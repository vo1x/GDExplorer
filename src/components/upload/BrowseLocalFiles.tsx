import { useEffect, useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { Trash2Icon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useLocalUploadQueue } from '@/store/local-upload-queue-store'
import { useUploadDestinationStore } from '@/store/upload-destination-store'
import { TransferTable } from '@/components/transfers/TransferTable'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { usePreferences } from '@/services/preferences'

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
    clear,
    setItemProgress,
    setItemStatus,
    resetUploadState,
  } = useLocalUploadQueue()
  const {
    destinationUrl,
    destinationError,
    destinationFolderId,
    setDestinationUrl,
  } = useUploadDestinationStore()
  const { data: preferences } = usePreferences()
  const [isBrowsing, setIsBrowsing] = useState(false)
  const [isDropActive, setIsDropActive] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [errorBanner, setErrorBanner] = useState<string | null>(null)
  const [selectedPresetId, setSelectedPresetId] = useState<string>('custom')

  const destinationPresets = useMemo(
    () => preferences?.destinationPresets ?? [],
    [preferences?.destinationPresets]
  )

  useEffect(() => {
    if (!destinationUrl.trim()) {
      setSelectedPresetId('custom')
      return
    }
    const match = destinationPresets.find(
      p => p.url.trim() === destinationUrl.trim()
    )
    setSelectedPresetId(match ? match.id : 'custom')
  }, [destinationPresets, destinationUrl])

  const startUploadDisabled =
    items.length === 0 ||
    !destinationFolderId ||
    destinationError ||
    isUploading

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

  const handleStartUpload = async () => {
    if (!destinationFolderId) return
    if (destinationError) return
    if (items.length === 0) return
    if (isUploading) return

    setIsUploading(true)
    resetUploadState()
    setErrorBanner(null)

    try {
      await invoke('start_upload', {
        args: {
          queueItems: items.map(item => ({
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

  useEffect(() => {
    let unlistenStatus: (() => void) | null = null
    let unlistenProgress: (() => void) | null = null
    let unlistenCompleted: (() => void) | null = null
    let unlistenErrorBanner: (() => void) | null = null

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
        setErrorBanner(event.payload.message)
      })
    }

    setup().catch(error => {
      logger.debug('Upload event listeners not available', {
        error: String(error),
      })
    })

    return () => {
      if (unlistenStatus) unlistenStatus()
      if (unlistenProgress) unlistenProgress()
      if (unlistenCompleted) unlistenCompleted()
      if (unlistenErrorBanner) unlistenErrorBanner()
    }
  }, [resetUploadState, setItemProgress, setItemStatus])

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

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="shrink-0 space-y-4 p-6">
        {errorBanner ? (
          <Alert variant="destructive">
            <AlertTitle className="flex items-center justify-between gap-3">
              <span>Upload blocked</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setErrorBanner(null)}
                aria-label="Dismiss upload error"
              >
                <XIcon className="size-4" />
              </Button>
            </AlertTitle>
            <AlertDescription>
              <p className="whitespace-pre-wrap">{errorBanner}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        <section className="space-y-2">
          <Label htmlFor="destination-url">Destination folder URL</Label>
          {destinationPresets.length > 0 ? (
            <div className="flex items-center gap-2">
              <Select
                value={selectedPresetId}
                onValueChange={value => {
                  setSelectedPresetId(value)
                  if (value === 'custom') return
                  const preset = destinationPresets.find(p => p.id === value)
                  if (preset) setDestinationUrl(preset.url)
                }}
              >
                <SelectTrigger className="w-[260px]" size="sm">
                  <SelectValue placeholder="Custom" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="custom">Custom</SelectItem>
                  {destinationPresets.map(p => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* <div className="text-xs text-muted-foreground">
                Select a saved destination or enter a custom URL.
              </div> */}

              <div className='flex flex-col gap-0.5 w-full'>
                <Input
                  id="destination-url"
                  value={destinationUrl}
                  onChange={e => setDestinationUrl(e.target.value)}
                  placeholder="https://drive.google.com/drive/folders/<FOLDER_ID>"
                  aria-invalid={Boolean(destinationError)}
                  className={
                    destinationError
                      ? 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20'
                      : destinationFolderId
                        ? 'border-emerald-600 focus-visible:border-emerald-600 focus-visible:ring-emerald-600/25'
                        : undefined
                  }
                />
                {/* {destinationError ? (
                  <p className="text-sm text-destructive">
                    Please enter a Google Drive <em>folder</em> URL.
                  </p>
                ) : destinationFolderId ? (
                  <p className="text-sm text-emerald-700 dark:text-emerald-400">
                    Folder ID:{' '}
                    <span className="font-mono">{destinationFolderId}</span>
                  </p>
                ) : null} */}
              </div>
            </div>
          ) : null}
        </section>

        <section
          aria-label="Drop zone"
          className={cn(
            'w-full rounded-md border border-dashed p-8 text-center transition-colors',
            isDropActive
              ? 'border-primary bg-primary/5'
              : 'border-border bg-muted/20'
          )}
        >
          <div className="text-base font-medium">
            Drop files &amp; folders here
          </div>
          <div className="my-2 text-sm text-muted-foreground">
            or 
          </div>
          <Button type="button" onClick={handleBrowse} disabled={isBrowsing}>
              {isBrowsing ? 'Browsing…' : 'Browse…'}
          </Button>
        </section>

        <section className="flex flex-col items-start gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              disabled={startUploadDisabled}
              onClick={handleStartUpload}
            >
              {isUploading ? 'Uploading…' : 'Upload files'}
            </Button>
          </div>
        </section>
      </div>

      <Separator />

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-6">
        {items.length > 0 ? (
          <TransferTable />
        ) : (
          <section className="rounded-md border border-dashed p-8 text-center">
            <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-md bg-muted">
              <Trash2Icon className="size-5 text-muted-foreground" />
            </div>
            <div className="text-sm font-medium">Upload queue is empty</div>
            <div className="mt-1 text-sm text-muted-foreground">
              Click Browse… to add files and folders.
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
