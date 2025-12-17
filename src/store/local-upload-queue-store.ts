import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

export type LocalUploadItemKind = 'file' | 'folder'

export interface LocalUploadItem {
  id: string
  path: string
  kind: LocalUploadItemKind
  addedAt: number
}

interface LocalUploadQueueState {
  items: LocalUploadItem[]

  addItems: (items: Array<Pick<LocalUploadItem, 'path' | 'kind'>>) => void
  addFiles: (paths: string[]) => void
  addFolders: (paths: string[]) => void
  remove: (path: string) => void
  clear: () => void
}

function addUniqueItems(
  existing: LocalUploadItem[],
  incoming: Array<Pick<LocalUploadItem, 'path' | 'kind'>>
): LocalUploadItem[] {
  if (incoming.length === 0) return existing

  const existingPaths = new Set(existing.map(item => item.path))
  const newItems: LocalUploadItem[] = []

  for (const { path, kind } of incoming) {
    if (existingPaths.has(path)) continue
    existingPaths.add(path)
    newItems.push({ id: path, path, kind, addedAt: Date.now() })
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
