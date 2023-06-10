import * as Y from 'yjs'
import * as idb from 'lib0/indexeddb.js'
import { Observable } from 'lib0/observable.js'

const dbname = 'y-indexeddb'
const customStoreName = 'custom'
const updatesStoreName = 'updates'

// A promiseed IDBDatabase connection. Opened once when first constructed, then kept open. */
/** @type {Promise<IDBDatabase> | undefined} */
let dbpromise

// A cached IDBDatabase instance from the resolved dbpromise. Used by synchronous functions like fetchUpdates that assume the db has already been opened.
/** @type {IDBDatabase | undefined} */
let dbcached

const noop = () => {}

export const PREFERRED_TRIM_SIZE = 500

/**
 * @param {IndexeddbPersistence} idbPersistence
 * @param {function(IDBObjectStore):void} [beforeApplyUpdatesCallback]
 */
export const fetchUpdates = (idbPersistence, beforeApplyUpdatesCallback = noop) => {
  const [updatesStore] = idb.transact(/** @type {IDBDatabase} */ (dbcached), [updatesStoreName]) // , 'readonly')
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
})

/** Deletes a document from the database. We need a standalone method as a way to delete a persisted Doc if there is no IndexedDBPersistence instance. If you have an IndexedDBPersistence instance, call the clearData instance methnod.
 * @param {string} name
 * */
export const clearDocument = async (name) => {
  const db = await (dbpromise || idb.openDB(dbname, () => {}))
  const [customStore, updatesStore] = idb.transact(db, [customStoreName, updatesStoreName])
  return Promise.all([
    idb.del(customStore, idb.createIDBKeyRangeLowerBound(0, false)),
    idb.del(updatesStore, idb.createIDBKeyRangeLowerBound(0, false))
  ])
}

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
    this._dbref = 0
    this._dbsize = 0
    this._destroyed = false
    this.created = false
    this.synced = false

    dbpromise = dbpromise || idb.openDB(dbname, db => {
      idb.createStores(db, [
        [customStoreName],
        [updatesStoreName, { autoIncrement: true }]
      ])
    }).then(db => {
      dbcached = db
      return db
    })

    /**
     * @type {Promise<IndexeddbPersistence>}
     */
    this.whenSynced = dbpromise.then(() => {
      this.created = true
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
     * Timeout in ms until data is merged and persisted in idb.
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
        const [updatesStore] = idb.transact(/** @type {IDBDatabase} */ (dbcached), [updatesStoreName])
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
   * @return {Promise<void>}
   */
  async clearData () {
    this.destroy()

    const db = await (/** @type {Promise<IDBDatabase>} */(dbpromise))
    const [customStore, updatesStore] = idb.transact(db, [customStoreName, updatesStoreName])
    await Promise.all([
      idb.del(customStore, idb.createIDBKeyRangeLowerBound(0, false)),
      idb.del(updatesStore, idb.createIDBKeyRangeLowerBound(0, false))
    ])
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @return {Promise<String | number | ArrayBuffer | Date | any>}
   */
  async get (key) {
    const db = await (/** @type {Promise<IDBDatabase>} */(dbpromise))
    const [custom] = idb.transact(db, [customStoreName], 'readonly')
    return idb.get(custom, key)
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @param {String | number | ArrayBuffer | Date} value
   * @return {Promise<String | number | ArrayBuffer | Date>}
   */
  async set (key, value) {
    const db = await (/** @type {Promise<IDBDatabase>} */(dbpromise))
    const [custom] = idb.transact(db, [customStoreName])
    return idb.put(custom, value, key)
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @return {Promise<undefined>}
   */
  async del (key) {
    const db = await (/** @type {Promise<IDBDatabase>} */(dbpromise))
    const [custom] = idb.transact(db, [customStoreName])
    return idb.del(custom, key)
  }
}
