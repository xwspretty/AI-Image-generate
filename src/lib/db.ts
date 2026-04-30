import type { HistoryItem } from '../types'

const DB_NAME = 'ai-image-generate-db'
const DB_VERSION = 1
const STORE = 'history'
const MAX_HISTORY = 60

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
    }
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function getHistory(): Promise<HistoryItem[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const request = store.getAll()
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      resolve((request.result as HistoryItem[]).sort((a, b) => b.createdAt - a.createdAt))
    }
    tx.oncomplete = () => db.close()
  })
}

export async function addHistory(item: HistoryItem) {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).put(item)
  await txDone(tx)
  db.close()
  await trimHistory()
}

export async function deleteHistory(id: string) {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).delete(id)
  await txDone(tx)
  db.close()
}

export async function clearHistory() {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).clear()
  await txDone(tx)
  db.close()
}

async function trimHistory() {
  const all = await getHistory()
  const overflow = all.slice(MAX_HISTORY)
  if (!overflow.length) return
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  for (const item of overflow) store.delete(item.id)
  await txDone(tx)
  db.close()
}
