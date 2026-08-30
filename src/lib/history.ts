import type { MeetingHistoryItem, TranscriptChunk } from '../types'

const DATABASE = 'saroop-meetings'
const VERSION = 1
const HISTORY = 'history'
const DRAFTS = 'drafts'

export type TranscriptDraft = {
  id: string
  updatedAt: string
  completed: Record<number, TranscriptChunk[]>
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(HISTORY)) request.result.createObjectStore(HISTORY, { keyPath: 'id' })
      if (!request.result.objectStoreNames.contains(DRAFTS)) request.result.createObjectStore(DRAFTS, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('เปิดฐานข้อมูลในเบราว์เซอร์ไม่สำเร็จ'))
  })
}

async function transaction<T>(storeName: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(database.transaction(storeName, mode).objectStore(storeName))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('บันทึกข้อมูลในเบราว์เซอร์ไม่สำเร็จ'))
    })
  } finally { database.close() }
}

export function fileDraftId(file: Pick<File, 'name' | 'size' | 'lastModified'>, provider: string) {
  return `${file.name}:${file.size}:${file.lastModified}:${provider}`
}

export async function saveHistory(item: MeetingHistoryItem) {
  await transaction(HISTORY, 'readwrite', (store) => store.put(item))
}

export async function listHistory(): Promise<MeetingHistoryItem[]> {
  const items = await transaction(HISTORY, 'readonly', (store) => store.getAll())
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30)
}

export async function deleteHistory(id: string) {
  await transaction(HISTORY, 'readwrite', (store) => store.delete(id))
}

export async function loadDraft(id: string): Promise<TranscriptDraft | undefined> {
  return transaction(DRAFTS, 'readonly', (store) => store.get(id))
}

export async function saveDraft(id: string, index: number, chunks: TranscriptChunk[]) {
  const current = await loadDraft(id)
  await transaction(DRAFTS, 'readwrite', (store) => store.put({ id, updatedAt: new Date().toISOString(), completed: { ...(current?.completed ?? {}), [index]: chunks } }))
}

export async function deleteDraft(id: string) {
  await transaction(DRAFTS, 'readwrite', (store) => store.delete(id))
}
