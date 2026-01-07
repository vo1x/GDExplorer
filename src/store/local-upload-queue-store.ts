import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

export type LocalUploadItemKind = 'file' | 'folder'

export interface LocalUploadItem {
  id: string
  path: string
  kind: LocalUploadItemKind
  addedAt: number
  status?: 'queued' | 'preparing' | 'uploading' | 'paused' | 'done' | 'failed'
  message?: string | null
  bytesSent?: number
  totalBytes?: number
  saEmail?: string | null
}

interface LocalUploadQueueState {
  items: LocalUploadItem[]

  addItems: (items: Pick<LocalUploadItem, 'path' | 'kind'>[]) => void
  addFiles: (paths: string[]) => void
  addFolders: (paths: string[]) => void
  setItemStatus: (
    itemId: string,
    status: LocalUploadItem['status'],
    message?: string | null,
    saEmail?: string | null
  ) => void
  setItemProgress: (
    itemId: string,
    bytesSent: number,
    totalBytes: number
  ) => void
  resetUploadState: () => void
  resetItemsUploadState: (itemIds: string[]) => void
  remove: (path: string) => void
  clear: () => void
}

let uploadIdCounter = 0

function createUploadItemId(path: string): string {
  uploadIdCounter += 1
  return `${path}::${Date.now()}::${uploadIdCounter}`
}

function addUniqueItems(
  existing: LocalUploadItem[],
  incoming: Pick<LocalUploadItem, 'path' | 'kind'>[]
): LocalUploadItem[] {
  if (incoming.length === 0) return existing

  const existingPaths = new Set(existing.map(item => item.path))
  const newItems: LocalUploadItem[] = []

  for (const { path, kind } of incoming) {
    if (existingPaths.has(path)) continue
    existingPaths.add(path)
    newItems.push({
      id: createUploadItemId(path),
      path,
      kind,
      addedAt: Date.now(),
      status: 'queued',
    })
  }

  return existing.concat(newItems)
}

export const useLocalUploadQueue = create<LocalUploadQueueState>()(
  devtools(
    set => ({
      items: [],

      addItems: incoming =>
        set(
          state => ({
            items: addUniqueItems(state.items, incoming),
          }),
          undefined,
          'addItems'
        ),

      addFiles: paths =>
        set(
          state => ({
            items: addUniqueItems(
              state.items,
              paths.map(path => ({ path, kind: 'file' as const }))
            ),
          }),
          undefined,
          'addFiles'
        ),

      addFolders: paths =>
        set(
          state => ({
            items: addUniqueItems(
              state.items,
              paths.map(path => ({ path, kind: 'folder' as const }))
            ),
          }),
          undefined,
          'addFolders'
        ),

      setItemStatus: (itemId, status, message = null, saEmail = null) =>
        set(
          state => ({
            items: state.items.map(item =>
              item.id === itemId ? { ...item, status, message, saEmail } : item
            ),
          }),
          undefined,
          'setItemStatus'
        ),

      setItemProgress: (itemId, bytesSent, totalBytes) =>
        set(
          state => ({
            items: state.items.map(item =>
              item.id === itemId ? { ...item, bytesSent, totalBytes } : item
            ),
          }),
          undefined,
          'setItemProgress'
        ),

      resetUploadState: () =>
        set(
          state => ({
            items: state.items.map(item => ({
              ...item,
              status: 'queued',
              message: null,
              bytesSent: undefined,
              totalBytes: undefined,
              saEmail: null,
            })),
          }),
          undefined,
          'resetUploadState'
        ),

      resetItemsUploadState: itemIds =>
        set(
          state => {
            if (itemIds.length === 0) return state
            const ids = new Set(itemIds)
            return {
              items: state.items.map(item =>
                ids.has(item.id)
                  ? {
                      ...item,
                      status: 'queued',
                      message: null,
                      bytesSent: undefined,
                      totalBytes: undefined,
                      saEmail: null,
                    }
                  : item
              ),
            }
          },
          undefined,
          'resetItemsUploadState'
        ),

      remove: path =>
        set(
          state => ({ items: state.items.filter(item => item.path !== path) }),
          undefined,
          'remove'
        ),

      clear: () => set({ items: [] }, undefined, 'clear'),
    }),
    { name: 'local-upload-queue' }
  )
)
