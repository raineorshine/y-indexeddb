
import * as Y from 'yjs'
import { IndexeddbPersistence, PREFERRED_TRIM_SIZE, clear, clearDocument, fetchUpdates } from '../src/y-indexeddb.js'
import * as idb from 'lib0/indexeddb.js'
import * as t from 'lib0/testing.js'
import * as promise from 'lib0/promise.js'

/**
 * @param {t.TestCase} tc
 */
export const testPerf = async tc => {
  await t.measureTimeAsync('time to create a y-indexeddb instance', async () => {
    const ydoc = new Y.Doc()
    const provider = new IndexeddbPersistence(tc.testName, ydoc)
    await provider.whenSynced
    provider.destroy()
  })
}

/**
 * @param {t.TestCase} tc
 */
export const testIdbUpdateAndMerge = async tc => {
  await clear()

  const doc1 = new Y.Doc()
  const arr1 = doc1.getArray('t')
  const doc2 = new Y.Doc()
  const arr2 = doc2.getArray('t')
  arr1.insert(0, [0])
  const persistence1 = new IndexeddbPersistence(tc.testName, doc1)
  persistence1._storeTimeout = 0
  await persistence1.whenSynced
  arr1.insert(0, [1])

  const persistence2 = new IndexeddbPersistence(tc.testName, doc2)
  persistence2._storeTimeout = 0
  let calledObserver = false
  // @ts-ignore
  arr2.observe((event, tr) => {
    t.assert(!tr.local)
    t.assert(tr.origin === persistence2)
    calledObserver = true
  })
  await persistence2.whenSynced
  t.assert(calledObserver)
  t.assert(arr2.length === 2)
  for (let i = 2; i < PREFERRED_TRIM_SIZE + 1; i++) {
    arr1.insert(i, [i])
  }
  await promise.wait(100)
  await fetchUpdates(persistence2)
  t.assert(arr2.length === PREFERRED_TRIM_SIZE + 1)
  t.assert(persistence1._dbsize === 1) // wait for dbsize === 0. db should be concatenated

  await clear()
}

/**
 * @param {t.TestCase} tc
 */
export const testIdbConcurrentMerge = async tc => {
  const doc1 = new Y.Doc()
  const arr1 = doc1.getArray('t')
  const doc2 = new Y.Doc()
  const arr2 = doc2.getArray('t')
  arr1.insert(0, [0])
  const persistence1 = new IndexeddbPersistence(tc.testName, doc1)
  persistence1._storeTimeout = 0
  await persistence1.whenSynced
  arr1.insert(0, [1])
  const persistence2 = new IndexeddbPersistence(tc.testName, doc2)
  persistence2._storeTimeout = 0
  await persistence2.whenSynced
  t.assert(arr2.length === 2)
  arr1.insert(0, ['left'])
  for (let i = 0; i < PREFERRED_TRIM_SIZE + 1; i++) {
    arr1.insert(i, [i])
  }
  arr2.insert(0, ['right'])
  for (let i = 0; i < PREFERRED_TRIM_SIZE + 1; i++) {
    arr2.insert(i, [i])
  }
  await promise.wait(100)
  await fetchUpdates(persistence1)
  await fetchUpdates(persistence2)
  t.assert(persistence1._dbsize < 10)
  t.assert(persistence2._dbsize < 10)
  t.compareArrays(arr1.toArray(), arr2.toArray())

  await clear()
}

/**
 * @param {t.TestCase} tc
 */
export const testMetaStorage = async tc => {
  const ydoc = new Y.Doc()
  const persistence = new IndexeddbPersistence(tc.testName, ydoc)
  persistence.set('a', 4)
  persistence.set(4, 'meta!')
  // @ts-ignore
  persistence.set('obj', { a: 4 })
  const resA = await persistence.get('a')
  t.assert(resA === 4)
  const resB = await persistence.get(4)
  t.assert(resB === 'meta!')
  const resC = await persistence.get('obj')
  t.compareObjects(resC, { a: 4 })

  await clear()
}

/**
 * @param {t.TestCase} tc
 */
export const testEarlyDestroy = async tc => {
  let hasbeenSyced = false
  const ydoc = new Y.Doc()
  const indexDBProvider = new IndexeddbPersistence(tc.testName, ydoc)
  indexDBProvider.on('synced', () => {
    hasbeenSyced = true
  })
  indexDBProvider.destroy()
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.assert(!hasbeenSyced)

  await clear()
}

/**
 * @param {t.TestCase} tc
 */
export const testMultipleDocs = async tc => {
  const persistenceArray = await Promise.all(Array(10).fill(null).map((value, i) => {
    const doc = new Y.Doc()
    const arr = doc.getArray('t')
    arr.insert(0, [i])
    const persistence = new IndexeddbPersistence(`doc${i}`, doc)
    persistence._storeTimeout = 0
    return persistence
  }))

  for (let i = 0; i < persistenceArray.length; i++) {
    const persistence = persistenceArray[i]
    await persistence.whenSynced
    const arr = persistence.doc.getArray('t')
    t.compareArrays(arr.toJSON(), [i])
  }

  await clear()
}

/**
 * @param {t.TestCase} tc
 */
export const testClearDataSingleDoc = async tc => {
  // this document will be cleared
  const doc1 = new Y.Doc()
  const persistence1 = new IndexeddbPersistence(tc.testName, doc1)
  persistence1.set('a', 4)

  // clear persistence1
  await persistence1.clearData()

  // persistence1 should have no updates
  const db = await idb.openDB('y-indexeddb', () => {})
  const [customStore, updatesStore] = idb.transact(db, ['custom', 'updates'])
  const updates = await idb.getAll(updatesStore, idb.createIDBKeyRangeLowerBound(0, false))
  t.assert(updates.length === 0)

  // persistence1 should have no custom values
  const custom = await idb.getAll(customStore, idb.createIDBKeyRangeLowerBound(0, false))
  t.assert(custom.length === 0)

  await clear()
}

/**
 * @param {t.TestCase} tc
 */
export const testClearDocumentSingleDoc = async tc => {
  // this document will be cleared
  const doc1 = new Y.Doc()
  const persistence1 = new IndexeddbPersistence(tc.testName, doc1)
  persistence1.set('a', 4)

  // clear persistence1
  await clearDocument(tc.testName)

  // persistence1 should have no updates
  const db = await idb.openDB('y-indexeddb', () => {})
  const [customStore, updatesStore] = idb.transact(db, ['custom', 'updates'])
  const updates = await idb.getAll(updatesStore, idb.createIDBKeyRangeLowerBound(0, false))
  t.assert(updates.length === 0)

  // persistence1 should have no custom values
  const custom = await idb.getAll(customStore, idb.createIDBKeyRangeLowerBound(0, false))
  t.assert(custom.length === 0)

  await clear()
}

/**
 * @param {t.TestCase} tc
 */
export const testClearDataMultipleDocs = async tc => {
  // this document will be cleared
  const doc1 = new Y.Doc()
  const persistence1 = new IndexeddbPersistence(tc.testName, doc1)
  persistence1.set('a', 4)

  // this document should be preserved
  const doc2 = new Y.Doc()
  const arr2 = doc2.getArray('t')
  arr2.insert(0, [1])
  const persistence2 = new IndexeddbPersistence('doc2', doc2)
  persistence2.set('b', 5)

  // clear persistence1
  await persistence1.clearData()

  // persistence1 should have no updates
  const db = await idb.openDB('y-indexeddb', () => {})
  const [customStore, updatesStore] = idb.transact(db, ['custom', 'updates'])
  const updates = await idb.getAll(updatesStore)
  t.assert(updates.every(({ name }) => name !== 'doc1'))

  // persistence1 should have no custom values
  const custom = await idb.getAll(customStore)
  t.assert(custom.every(({ name }) => name !== 'doc1'))

  // persistence2 should be preserved
  const resB = await persistence2.get('b')
  t.assert(resB === 5)

  await clear()
}

/**
 * @param {t.TestCase} tc
 */
export const testClearDocumentMultipleDocs = async tc => {
  // this document will be cleared
  const doc1 = new Y.Doc()
  const persistence1 = new IndexeddbPersistence(tc.testName, doc1)
  persistence1.set('a', 4)

  // this document should be preserved
  const doc2 = new Y.Doc()
  const arr2 = doc2.getArray('t')
  arr2.insert(0, [1])
  const persistence2 = new IndexeddbPersistence('doc2', doc2)
  persistence2.set('b', 5)

  // clear persistence1
  await clearDocument(tc.testName)

  // persistence1 should have no updates
  const db = await idb.openDB('y-indexeddb', () => {})
  const [customStore, updatesStore] = idb.transact(db, ['custom', 'updates'])
  const updates = await idb.getAll(updatesStore)
  t.assert(updates.every(({ name }) => name !== 'doc1'))

  // persistence1 should have no custom values
  const custom = await idb.getAll(customStore)
  t.assert(custom.every(({ name }) => name !== 'doc1'))

  // persistence2 should be preserved
  const resB = await persistence2.get('b')
  t.assert(resB === 5)

  await clear()
}

/**
 * @param {t.TestCase} tc
 */
export const testClearDocumentAndReopen = async tc => {
  // this document will be cleared
  const doc1 = new Y.Doc()
  const persistence1 = new IndexeddbPersistence(tc.testName, doc1)
  await persistence1.set('a', 4)

  // clear persistence1
  await clearDocument(tc.testName)

  const doc2 = new Y.Doc()
  const persistence2 = new IndexeddbPersistence(tc.testName, doc2)
  await persistence2.set('a', 5)

  // persistence1 object stores should be deleted
  const db = await idb.openDB('y-indexeddb', () => {})
  t.assert(db)
  t.assert(db.objectStoreNames.length === 2)

  const resA = await persistence2.get('a')
  t.assert(resA === 5)

  await clear()
}
