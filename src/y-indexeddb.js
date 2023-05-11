import * as Y from 'yjs'
import * as idb from 'lib0/indexeddb.js'
import { Observable } from 'lib0/observable.js'

const dbname = 'y-indexeddb'

// The db version must be incremented for each new doc in order to trigger onupgradeneeded and create new object stores.
// It is initiated from db.version of the first open connection, then incremented at pace with db upgrades.
/** @type {number | undefined} */
let dbversion

// A promiseed IDBDatabase connection. The promise object reference will change whenever a new IndexedDBPersistence is instantiated, as it needs to open a new connection to add new object stores. */
/** @type {Promise<IDBDatabase> | undefined} */
let dbpromise

// A cached IDBDatabase instance from the last resolved dbpromise.
/** @type {IDBDatabase | undefined} */
let dbcached

const noop = () => {}

export const PREFERRED_TRIM_SIZE = 500

/**
 * @param {IndexeddbPersistence} idbPersistence
 * @param {function(IDBObjectStore):void} [beforeApplyUpdatesCallback]
 */
export const fetchUpdates = (idbPersistence, beforeApplyUpdatesCallback = noop) => {
  const [updatesStore] = idb.transact(/** @type {IDBDatabase} */ (dbcached), [idbPersistence.updatesStoreName]) // , 'readonly')
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

/** Deletes the entire database. */
export const clear = () => idb.deleteDB(dbname).then(() => {
  dbpromise = undefined
  dbcached = undefined
  dbversion = undefined
})

/** Deletes a document from the database. We need a standalone method as a way to delete a persisted Doc if there is no IndexedDBPersistence instance. If you have an IndexedDBPersistence instance, call the clearData instance methnod.
 * @param {string} name
 * */
export const clearDocument = (name) => {
  const customStoreName = `custom-${name}`
  const updatesStoreName = `updates-${name}`
  /**
   * @type {Promise<IDBDatabase | null>}
   */
  const dbOrNull = dbpromise || Promise.resolve(null)

  const dbnew = dbOrNull.then(db => {
    if (db) {
      db.close()
    }
    return openDBWithVersion(dbname, db => {
      db.deleteObjectStore(customStoreName)
      db.deleteObjectStore(updatesStoreName)
    }, false)
  })

  // Set dbpromise to the new db instance if deleteObjectStore succeeds, otherwise revert.
  // Assign the new promise immediately to dbpromise to block other db requests until this resolves.
  // Do not assign dbnew directly to the global dbpromise, as a rejected promise will fail subsequent calls.
  /**
   * @type {any}
   */
  const dbrevert = dbpromise
  dbpromise = dbnew.catch(() => dbrevert).then(db => {
    dbcached = db
    return db
  })

  return dbnew
}

/* istanbul ignore next */
/**
 * @param {string} name
 * @param {function(IDBDatabase):any} initDB Called when the database is first created
 * @param {boolean?} reopen Reopen the database without incrementing the version
 * @return {Promise<IDBDatabase>}
 */
const openDBWithVersion = (name, initDB, reopen) => new Promise((resolve, reject) => {
  // increment the db version in order to add new object stores
  // otherwise, just use the latest db version
  const version = reopen || !dbversion ? dbversion : ++dbversion
  // eslint-disable-next-line
  const request = indexedDB.open(name, version)

  /**
   * @param {any} event
   */
  request.onupgradeneeded = event => {
    try {
      initDB(event.target.result)
    } catch (e) {
      reject(e)
    }
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
    dbcached = db

    if (!dbversion) {
      dbversion = db.version
    }

    /* istanbul ignore next */
    db.onversionchange = () => db.close()

    /* istanbul ignore if */
    if (typeof addEventListener !== 'undefined') {
      // eslint-disable-next-line
      addEventListener('unload', close)
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
    this.created = false
    this.synced = false

    // get initial objectStoreNames if it is not defined
    const objectStoreNames = dbpromise ? dbpromise.then(db => db.objectStoreNames)
      : openDBWithVersion(dbname, noop, true).then(db => {
        const objectStoreNames = db.objectStoreNames
        db.close()
        return objectStoreNames
      })

    dbpromise = objectStoreNames.then(names => {
      // first check if the object stores already exist
      const exists = !!names && names.contains(this.customStoreName)

      // if the object stores already exist, return the latest version of the db
      // otherwise bump the version to create new object stores
      return openDBWithVersion(dbname, exists ? noop : db => {
        idb.createStores(db, [
          [this.customStoreName],
          [this.updatesStoreName, { autoIncrement: true }]
        ])
      }, exists).then(db => {
        this.created = true
        return db
      })
    })

    /**
     * @type {Promise<IndexeddbPersistence>}
     */
    this.whenSynced = dbpromise.then(db => {
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
     * @param {any} retries
     */
    this._storeUpdate = (update, origin, retries = 0) => {
      if (origin !== this && this.created) {
        // logarithmic retry if database is being upgraded
        if (/** @type {IDBDatabase} */(dbcached).version !== dbversion) {
          if (isNaN(retries)) {
            retries = 0
          }
          setTimeout(() => this._storeUpdate(update, origin, retries + 1), Math.pow(retries, 2))
          return
        }
        const [updatesStore] = idb.transact(/** @type {IDBDatabase} */ (dbcached), [this.updatesStoreName])
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
    return dbpromise
  }

  /**
   * Destroys this instance and removes the object stores from indexeddb.
   *
   * @return {Promise<IDBDatabase>}
   */
  clearData () {
    if (!dbpromise) {
      throw new Error(`clearData() of IndexeddbPersistence instance "${this.name}" cannot be called after clear.`)
    }

    this.destroy()

    const dbnew = dbpromise.then(db => {
      db.close()
      return openDBWithVersion(dbname, db => {
        db.deleteObjectStore(this.customStoreName)
        db.deleteObjectStore(this.updatesStoreName)
      }, false)
    })

    // Set dbpromise to the new db instance if deleteObjectStore succeeds, otherwise revert.
    // Assign the new promise immediately to dbpromise to block other db requests until this resolves.
    // Do not assign the new db directly to the global dbpromise, as a rejected promise will fail subsequent calls.
    /**
     * @type {any}
     */
    const dbrevert = dbpromise
    dbpromise = dbnew.catch(() => dbrevert).then(db => {
      dbcached = db
      return db
    })

    return dbnew
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @return {Promise<String | number | ArrayBuffer | Date | any>}
   */
  get (key) {
    if (!dbpromise) {
      throw new Error(`get() of IndexeddbPersistence instance "${this.name}" cannot be called after clear.`)
    }
    return dbpromise.then(db => {
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
    if (!dbpromise) {
      throw new Error(`set() of IndexeddbPersistence instance "${this.name}" cannot be called after clear.`)
    }
    return dbpromise.then(db => {
      const [custom] = idb.transact(db, [this.customStoreName])
      return idb.put(custom, value, key)
    })
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @return {Promise<undefined>}
   */
  del (key) {
    if (!dbpromise) {
      throw new Error(`del() of IndexeddbPersistence instance "${this.name}" cannot be called after clear.`)
    }
    return dbpromise.then(db => {
      const [custom] = idb.transact(db, [this.customStoreName])
      return idb.del(custom, key)
    })
  }
}
