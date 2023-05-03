import * as Y from 'yjs'
import * as idb from 'lib0/indexeddb.js'
import { Observable } from 'lib0/observable.js'

const dbname = 'y-indexeddb'

// db version must be incremented for each new doc in order to trigger onupgradeneeded and create new object stores
// it is initiated from db.version of the first open connection
/** @type {number | undefined} */
let dbversion

// cache objectStoreNames to avoid additional db connection for each new Doc
/** @type {DOMStringList | undefined} */
let objectStoreNames

const noop = () => {}

export const PREFERRED_TRIM_SIZE = 500

/**
 * @param {IndexeddbPersistence} idbPersistence
 * @param {function(IDBObjectStore):void} [beforeApplyUpdatesCallback]
 */
export const fetchUpdates = (idbPersistence, beforeApplyUpdatesCallback = noop) => {
  const [updatesStore] = idb.transact(/** @type {IDBDatabase} */ (idbPersistence.db), [idbPersistence.updatesStoreName]) // , 'readonly')
  return idb.getAll(updatesStore, idb.createIDBKeyRangeLowerBound(idbPersistence._dbref, false)).then(updates => {
    if (!idbPersistence._destroyed) {
      beforeApplyUpdatesCallback(updatesStore)
      Y.transact(idbPersistence.doc, () => {
        updates.forEach(val => Y.applyUpdate(idbPersistence.doc, val))
      }, idbPersistence, false)
    }
  })
    .then(() => idb.getLastKey(updatesStore).then(lastKey => { idbPersistence._dbref = lastKey + 1 }))
    .then(() => idb.count(updatesStore).then(cnt => { idbPersistence._dbsize = cnt }))
    .then(() => updatesStore)
}

/**
 * @param {IndexeddbPersistence} idbPersistence
 * @param {boolean} forceStore
 */
export const storeState = (idbPersistence, forceStore = true) =>
  fetchUpdates(idbPersistence)
    .then(updatesStore => {
      if (forceStore || idbPersistence._dbsize >= PREFERRED_TRIM_SIZE) {
        idb.addAutoKey(updatesStore, Y.encodeStateAsUpdate(idbPersistence.doc))
          .then(() => idb.del(updatesStore, idb.createIDBKeyRangeUpperBound(idbPersistence._dbref, true)))
          .then(() => idb.count(updatesStore).then(cnt => { idbPersistence._dbsize = cnt }))
      }
    })

export const clear = () => idb.deleteDB(dbname).then(() => {
  dbversion = undefined
  objectStoreNames = undefined
})

/* istanbul ignore next */
/**
 * @param {string} name
 * @param {function(IDBDatabase):any} initDB Called when the database is first created
 * @param {function(IDBDatabase):any} versionchange Called when the database version changes
 * @param {boolean?} reopen Reopen the database without incrementing the version
 * @return {Promise<IDBDatabase>}
 */
const openDBWithVersion = (name, initDB, versionchange, reopen) => new Promise((resolve, reject) => {
  // increment the db version in order to add new object stores
  // otherwise, just use the latest db version
  const version = reopen || !dbversion ? dbversion : ++dbversion
  // eslint-disable-next-line
  const request = indexedDB.open(name, version)

  /**
   * @param {any} event
   */
  request.onupgradeneeded = event => {
    initDB(event.target.result)
  }

  /* istanbul ignore next */
  /**
   * @param {any} event
   */
  request.onerror = event => {
    reject(new Error(event.target.error))
  }
  /**
   * @param {any} event
   */
  request.onsuccess = event => {
    /**
     * @type {IDBDatabase}
     */
    const db = event.target.result
    if (!dbversion) {
      dbversion = db.version
    }
    /* istanbul ignore next */
    // close and re-open the database when the version changes, i.e. when new object stores are added for a new Doc
    // transactions on the old db instance will fail
    db.onversionchange = () => {
      db.close()
      openDBWithVersion(name, noop, versionchange, true).then(versionchange)
    }
    /* istanbul ignore if */
    if (typeof addEventListener !== 'undefined') {
      // eslint-disable-next-line
      addEventListener('unload', () => {
        db.close()
      })
    }
    resolve(db)
  }
})

/**
 * @extends Observable<string>
 */
export class IndexeddbPersistence extends Observable {
  /**
   * @param {string} name
   * @param {Y.Doc} doc
   */
  constructor (name, doc) {
    super()
    this.doc = doc
    this.name = name
    this.customStoreName = `custom-${name}`
    this.updatesStoreName = `updates-${name}`
    this._dbref = 0
    this._dbsize = 0
    this._destroyed = false
    /**
     * @type {IDBDatabase|null}
     */
    this.db = null
    this.synced = false

    /**
     * @param {IDBDatabase|null} db
     */
    const upgradeDbInstance = db => {
      this.db = db
    }

    // get initial objectStoreNames if it is not defined
    const objectStoreNamesInitialized = objectStoreNames
      ? Promise.resolve(objectStoreNames)
      : openDBWithVersion(dbname, noop, noop, true).then(db => {
        objectStoreNames = db.objectStoreNames
        db.close()
        return objectStoreNames
      })

    this._db = objectStoreNamesInitialized.then(() => {
      // first check if the object stores already exist
      const exists = !!objectStoreNames && objectStoreNames.contains(this.customStoreName)

      // if the object stores already exist, return the latest version of the db
      // otherwise bump the version to create new object stores
      return openDBWithVersion(dbname, exists ? noop : db => {
        idb.createStores(db, [
          [this.customStoreName],
          [this.updatesStoreName, { autoIncrement: true }]
        ])
        objectStoreNames = db.objectStoreNames
      }, upgradeDbInstance, exists)
    })

    /**
     * @type {Promise<IndexeddbPersistence>}
     */
    this.whenSynced = this._db.then(db => {
      this.db = db
      /**
       * @param {IDBObjectStore} updatesStore
       */
      const beforeApplyUpdatesCallback = (updatesStore) => idb.addAutoKey(updatesStore, Y.encodeStateAsUpdate(doc))
      return fetchUpdates(this, beforeApplyUpdatesCallback).then(() => {
        if (this._destroyed) return this
        this.emit('synced', [this])
        this.synced = true
        return this
      })
    })
    /**
     * Timeout in ms untill data is merged and persisted in idb.
     */
    this._storeTimeout = 1000
    /**
     * @type {any}
     */
    this._storeTimeoutId = null
    /**
     * @param {Uint8Array} update
     * @param {any} origin
     */
    this._storeUpdate = (update, origin) => {
      if (this.db && origin !== this) {
        const [updatesStore] = idb.transact(/** @type {IDBDatabase} */ (this.db), [this.updatesStoreName])
        idb.addAutoKey(updatesStore, update)
        if (++this._dbsize >= PREFERRED_TRIM_SIZE) {
          // debounce store call
          if (this._storeTimeoutId !== null) {
            clearTimeout(this._storeTimeoutId)
          }
          this._storeTimeoutId = setTimeout(() => {
            storeState(this, false)
            this._storeTimeoutId = null
          }, this._storeTimeout)
        }
      }
    }
    doc.on('update', this._storeUpdate)
    this.destroy = this.destroy.bind(this)
    doc.on('destroy', this.destroy)
  }

  destroy () {
    if (this._storeTimeoutId) {
      clearTimeout(this._storeTimeoutId)
    }
    this.doc.off('update', this._storeUpdate)
    this.doc.off('destroy', this.destroy)
    this._destroyed = true
    return this._db.then(db => {
      db.close()
    })
  }

  /**
   * Destroys this instance and removes all data from indexeddb.
   *
   * @return {Promise<void>}
   */
  clearData () {
    return this._db.then(db => {
      db.close()
      openDBWithVersion(dbname, db => {
        db.deleteObjectStore(this.customStoreName)
        db.deleteObjectStore(this.updatesStoreName)
      }, noop, false)
        .then(db => {
          if (this._storeTimeoutId) {
            clearTimeout(this._storeTimeoutId)
          }
          this.doc.off('update', this._storeUpdate)
          this.doc.off('destroy', this.destroy)
          this._destroyed = true
          this.db = db
        })
    })
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @return {Promise<String | number | ArrayBuffer | Date | any>}
   */
  get (key) {
    return this._db.then(db => {
      const [custom] = idb.transact(db, [this.customStoreName], 'readonly')
      return idb.get(custom, key)
    })
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @param {String | number | ArrayBuffer | Date} value
   * @return {Promise<String | number | ArrayBuffer | Date>}
   */
  set (key, value) {
    return this._db.then(db => {
      const [custom] = idb.transact(db, [this.customStoreName])
      return idb.put(custom, value, key)
    })
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @return {Promise<undefined>}
   */
  del (key) {
    return this._db.then(db => {
      const [custom] = idb.transact(db, [this.customStoreName])
      return idb.del(custom, key)
    })
  }
}
