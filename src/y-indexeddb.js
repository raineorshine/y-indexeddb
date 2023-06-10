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
export const fetchUpdates = async (idbPersistence, beforeApplyUpdatesCallback = noop) => {
  const [updatesStore] = idb.transact(/** @type {IDBDatabase} */ (dbcached), [updatesStoreName]) // , 'readonly')
  const updatesIndex = updatesStore.index('name,id')
  const updates = await idb.rtop(updatesIndex.getAll(idb.createIDBKeyRangeBound(
    [idbPersistence.name, idbPersistence._dbref],
    [idbPersistence.name, []],
    false,
    false
  )))
  if (!idbPersistence._destroyed) {
    beforeApplyUpdatesCallback(updatesStore)
    Y.transact(idbPersistence.doc, () => {
      updates.forEach((/** @type {{ update: Uint8Array }} */record) => Y.applyUpdate(idbPersistence.doc, record.update))
    }, idbPersistence, false)
  }
  const lastKey = await idb.getLastKey(updatesStore)
  idbPersistence._dbref = lastKey + 1
  const count = await idb.count(updatesStore)
  idbPersistence._dbsize = count
  return updatesStore
}

/**
 * @param {IndexeddbPersistence} idbPersistence
 * @param {boolean} forceStore
 */
export const storeState = async (idbPersistence, forceStore = true) => {
  const updatesStore = await fetchUpdates(idbPersistence)
  if (forceStore || idbPersistence._dbsize >= PREFERRED_TRIM_SIZE) {
    await idb.rtop(updatesStore.add({
      name: idbPersistence.name,
      update: Y.encodeStateAsUpdate(idbPersistence.doc)
    }))
    await idb.del(updatesStore, idb.createIDBKeyRangeUpperBound(idbPersistence._dbref, true))
    const cnt = await idb.count(updatesStore)
    idbPersistence._dbsize = cnt
  }
}

/** Deletes the entire database. */
export const clear = async () => {
  await idb.deleteDB(dbname)
  dbpromise = undefined
  dbcached = undefined
}

/** Deletes a document from the database. We need a standalone method as a way to delete a persisted Doc if there is no IndexedDBPersistence instance. If you have an IndexedDBPersistence instance, call the clearData instance methnod.
 * @param {string} name
 * */
export const clearDocument = async (name) => {
  const db = await (dbpromise || idb.openDB(dbname, () => {}))
  return new Promise((resolve, reject) => {
    // resolve when transaction auto-commits
    const tx = db.transaction([customStoreName, updatesStoreName], 'readwrite')
    tx.oncomplete = resolve
    tx.onerror = reject

    // delete custom values
    const customStore = tx.objectStore(customStoreName)
    customStore.delete(idb.createIDBKeyRangeBound([name], [name, []], false, false))

    // delete updates
    const updatesStore = tx.objectStore(updatesStoreName)
    const updatesIndex = updatesStore.index('name,id')

    // get all keys from the index and then delete individually since there is no index.delete method
    idb.rtop(updatesIndex.getAllKeys(idb.createIDBKeyRangeBound([name], [name, []], false, false))).then(keys => {
      keys.forEach((/** @type {string} */key) => updatesStore.delete(key))
    })
  })
}

/**
 * Modified idb.openDB to pass the upgrade transaction to initDB for creating an index.
 * @param {string} name
 * @param {function(IDBDatabase, IDBTransaction):any} initDB Called when the database is first created
 * @return {Promise<IDBDatabase>}
 */
export const openDBWithUpgradeTransaction = (name, initDB) => new Promise((resolve, reject) => {
  // eslint-disable-next-line
  const request = indexedDB.open(name)
  /**
   * @param {any} event
   */
  request.onupgradeneeded = event => initDB(event.target.result, event.target.transaction)
  /**
   * @param {any} event
   */
  request.onerror = event => reject(new Error(event.target.error))
  /**
   * @param {any} event
   */
  request.onsuccess = event => {
    /**
     * @type {IDBDatabase}
     */
    const db = event.target.result
    db.onversionchange = () => { db.close() }

    if (typeof addEventListener !== 'undefined') {
      // eslint-disable-next-line
      addEventListener('unload', () => db.close())
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
    this._dbref = 0
    this._dbsize = 0
    this._destroyed = false
    this.created = false
    this.synced = false

    dbpromise = dbpromise || openDBWithUpgradeTransaction(dbname, (db, tx) => {
      idb.createStores(db, [
        [customStoreName],
        [updatesStoreName, { autoIncrement: true, keyPath: 'id' }]
      ])
      const updatesStore = tx.objectStore(updatesStoreName)
      updatesStore.createIndex('name,id', ['name', 'id'])
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
      const beforeApplyUpdatesCallback = (updatesStore) =>
        idb.rtop(updatesStore.add({
          name: this.name,
          update: Y.encodeStateAsUpdate(doc)
        }))
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
        idb.rtop(updatesStore.add({ name: this.name, update }))
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
    return clearDocument(this.name)
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @return {Promise<String | number | ArrayBuffer | Date | any>}
   */
  async get (key) {
    const db = await (/** @type {Promise<IDBDatabase>} */(dbpromise))
    const [custom] = idb.transact(db, [customStoreName], 'readonly')
    const { value } = await idb.rtop(custom.get([this.name, key]))
    return value
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @param {String | number | ArrayBuffer | Date} value
   * @return {Promise<String | number | ArrayBuffer | Date>}
   */
  async set (key, value) {
    const db = await (/** @type {Promise<IDBDatabase>} */(dbpromise))
    const [custom] = idb.transact(db, [customStoreName])
    return idb.rtop(custom.put({ name: this.name, value }, [this.name, key]))
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @return {Promise<undefined>}
   */
  async del (key) {
    const db = await (/** @type {Promise<IDBDatabase>} */(dbpromise))
    const [custom] = idb.transact(db, [customStoreName])
    return idb.del(custom, [this.name, key])
  }
}
