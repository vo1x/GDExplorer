import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { useLocalUploadQueue } from '@/store/local-upload-queue-store'
import { useUploadDestinationStore } from '@/store/upload-destination-store'
import { useTransferUiStore } from '@/store/transfer-ui-store'
import { TransferTable } from '@/components/transfers/TransferTable'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'

function normalizeSelection(
  selection: string | string[] | null
): string[] | null {
  if (selection === null) return null
  return Array.isArray(selection) ? selection : [selection]
}

export function BrowseLocalFiles() {
  const {
    items,
    addFiles,
    addFolders,
    setItemProgress,
    setItemStatus,
    resetItemsUploadState,
  } = useLocalUploadQueue()
  const recordFileProgress = useTransferUiStore(s => s.recordFileProgress)
  const recordFileList = useTransferUiStore(s => s.recordFileList)
  const clearFileProgress = useTransferUiStore(s => s.clearFileProgress)
  const pauseAll = useTransferUiStore(s => s.pauseAll)
  const resumeAll = useTransferUiStore(s => s.resumeAll)
  const { destinationError, destinationFolderId } = useUploadDestinationStore()
  const [isBrowsing, setIsBrowsing] = useState(false)
  const [isDropActive, setIsDropActive] = useState(false)
  const [isUploading, setIsUploading] = useState(false)

  const handleBrowse = async () => {
    if (isBrowsing) return
    setIsBrowsing(true)
    try {
      const filesSelection = await open({
        multiple: true,
        directory: false,
        title: 'Select files',
      })
      const files = normalizeSelection(filesSelection) ?? []
      if (files.length > 0) addFiles(files)

      const foldersSelection = await open({
        multiple: false,
        directory: true,
        title: 'Select folders',
      })
      const folders = normalizeSelection(foldersSelection) ?? []
      if (folders.length > 0) addFolders(folders)
    } finally {
      setIsBrowsing(false)
    }
  }

  useEffect(() => {
    let unlistenStatus: (() => void) | null = null
    let unlistenProgress: (() => void) | null = null
    let unlistenFileProgress: (() => void) | null = null
    let unlistenFileList: (() => void) | null = null
    let unlistenCompleted: (() => void) | null = null
    let unlistenErrorBanner: (() => void) | null = null
    let unlistenNotice: (() => void) | null = null

    const setup = async () => {
      unlistenStatus = await listen<{
        itemId: string
        path: string
        kind: string
        status: 'queued' | 'preparing' | 'uploading' | 'done' | 'failed'
        message?: string | null
        saEmail?: string | null
      }>('upload:item_status', event => {
        const { itemId, status, message, saEmail } = event.payload
        setItemStatus(itemId, status, message ?? null, saEmail ?? null)
      })

      unlistenProgress = await listen<{
        itemId: string
        path: string
        bytesSent: number
        totalBytes: number
      }>('upload:progress', event => {
        const { itemId, bytesSent, totalBytes } = event.payload
        setItemProgress(itemId, bytesSent, totalBytes)
      })

      unlistenFileProgress = await listen<{
        itemId: string
        filePath: string
        bytesSent: number
        totalBytes: number
      }>('upload:file_progress', event => {
        const { itemId, filePath, bytesSent, totalBytes } = event.payload
        recordFileProgress(itemId, filePath, bytesSent, totalBytes)
      })

      unlistenFileList = await listen<{
        itemId: string
        files: { filePath: string; totalBytes: number }[]
      }>('upload:file_list', event => {
        const { itemId, files } = event.payload
        recordFileList(
          itemId,
          files.map(file => ({
            filePath: file.filePath,
            bytesSent: 0,
            totalBytes: file.totalBytes,
          }))
        )
      })

      unlistenCompleted = await listen<{
        summary: { total: number; succeeded: number; failed: number }
      }>('upload:completed', event => {
        setIsUploading(false)
        const { total, succeeded, failed } = event.payload.summary
        toast.success('Upload completed', {
          description: `${succeeded}/${total} succeeded, ${failed} failed`,
        })
      })

      unlistenErrorBanner = await listen<{
        message: string
        stage: string
        saEmail?: string | null
      }>('upload:error_banner', event => {
        setIsUploading(false)
        toast.error('Upload blocked', { description: event.payload.message })
      })

      unlistenNotice = await listen<{ message: string }>(
        'upload:notice',
        event => {
          toast.message('Upload notice', { description: event.payload.message })
        }
      )
    }

    setup().catch(error => {
      logger.debug('Upload event listeners not available', {
        error: String(error),
      })
    })

    return () => {
      if (unlistenStatus) unlistenStatus()
      if (unlistenProgress) unlistenProgress()
      if (unlistenFileProgress) unlistenFileProgress()
      if (unlistenFileList) unlistenFileList()
      if (unlistenCompleted) unlistenCompleted()
      if (unlistenErrorBanner) unlistenErrorBanner()
      if (unlistenNotice) unlistenNotice()
    }
  }, [recordFileList, recordFileProgress, setItemProgress, setItemStatus])

  useEffect(() => {
    let unlisten: (() => void) | null = null

    const setup = async () => {
      try {
        const win = getCurrentWindow()
        unlisten = await win.onDragDropEvent(async ({ payload }) => {
          switch (payload.type) {
            case 'enter':
            case 'over':
              setIsDropActive(true)
              break
            case 'leave':
              setIsDropActive(false)
              break
            case 'drop': {
              setIsDropActive(false)
              const paths = payload.paths ?? []
              if (paths.length === 0) return

              const existing = new Set(
                useLocalUploadQueue.getState().items.map(i => i.path)
              )

              interface ClassifiedPath {
                path: string
                kind: 'file' | 'folder'
              }

              try {
                const classified = await invoke<ClassifiedPath[]>(
                  'classify_paths',
                  { paths }
                )

                const toAdd = classified.map(item => ({
                  path: item.path,
                  kind: item.kind,
                }))
                useLocalUploadQueue.getState().addItems(toAdd)

                const addedCount = classified.filter(
                  p => !existing.has(p.path)
                ).length
                if (addedCount > 0) {
                  toast.success(`Added ${addedCount} items to queue`)
                }
              } catch (error) {
                logger.warn(
                  'Failed to classify dropped paths, defaulting to file',
                  {
                    error: String(error),
                  }
                )
                const toAdd = paths.map(path => ({
                  path,
                  kind: 'file' as const,
                }))
                useLocalUploadQueue.getState().addItems(toAdd)

                const addedCount = paths.filter(p => !existing.has(p)).length
                if (addedCount > 0) {
                  toast.success(`Added ${addedCount} items to queue`)
                }
              }
              break
            }
          }
        })
      } catch (error) {
        logger.debug('Tauri drag-and-drop events not available', {
          error: String(error),
        })
      }
    }

    setup()
    return () => {
      if (unlisten) unlisten()
    }
  }, [])

  const handleStartSelected = async (selectedIds: string[]) => {
    if (!destinationFolderId) return
    if (destinationError) return
    if (selectedIds.length === 0) return

    const selected = items.filter(i => selectedIds.includes(i.id))
    const pausedItems = selected.filter(i => i.status === 'paused')
    const queuedItems = selected.filter(
      i => i.status === 'queued' || !i.status
    )

    if (pausedItems.length === 0 && queuedItems.length === 0) {
      toast.message('Nothing to start', {
        description: 'Select queued or paused items.',
      })
      return
    }

    if (pausedItems.length > 0) {
      const toResume = pausedItems.map(i => i.id)
      setIsUploading(true)
      invoke('pause_items', { itemIds: toResume, paused: false }).catch(err => {
        logger.debug('pause_items resume failed', { error: String(err) })
      })
      resumeAll(toResume)
      for (const id of toResume) {
        setItemStatus(id, 'uploading', null, null)
      }
    }

    if (queuedItems.length === 0) return

    setIsUploading(true)

    clearFileProgress(queuedItems.map(i => i.id))
    resetItemsUploadState(queuedItems.map(i => i.id))
    for (const it of queuedItems) {
      setItemStatus(it.id, 'preparing', null, null)
    }

    try {
      await invoke('start_upload', {
        args: {
          queueItems: queuedItems.map(item => ({
            id: item.id,
            path: item.path,
            kind: item.kind,
          })),
          destinationFolderId,
        },
      })
    } catch (error) {
      setIsUploading(false)
      const message = error instanceof Error ? error.message : String(error)
      toast.error('Failed to start upload', { description: message })
    }
  }

  const handlePauseSelected = async (selectedIds: string[]) => {
    if (selectedIds.length === 0) return
    if (!isUploading) return

    const selected = items.filter(i => selectedIds.includes(i.id))
    const toPause = selected
      .filter(i => i.status === 'uploading' || i.status === 'preparing')
      .map(i => i.id)

    if (toPause.length === 0) return

    invoke('pause_items', { itemIds: toPause, paused: true }).catch(err => {
      logger.debug('pause_items pause failed', { error: String(err) })
    })
    pauseAll(toPause)
    for (const id of toPause) {
      setItemStatus(id, 'paused', null, null)
    }
    const remainingActive = items.some(
      item =>
        !toPause.includes(item.id) &&
        (item.status === 'uploading' || item.status === 'preparing')
    )
    if (!remainingActive) setIsUploading(false)
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-6">
        <TransferTable
          isDropActive={isDropActive}
          onBrowse={handleBrowse}
          onStartSelected={handleStartSelected}
          onPauseSelected={handlePauseSelected}
          isUploading={isUploading}
        />
      </div>
    </div>
  )
}
