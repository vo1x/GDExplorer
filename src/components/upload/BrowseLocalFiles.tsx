import { useEffect, useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { FileIcon, FolderIcon, Trash2Icon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useLocalUploadQueue } from '@/store/local-upload-queue-store'
import { useUploadDestinationStore } from '@/store/upload-destination-store'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'

function normalizeSelection(
  selection: string | string[] | null
): string[] | null {
  if (selection === null) return null
  return Array.isArray(selection) ? selection : [selection]
}

function getPathName(path: string): string {
  const normalized = path.replace(/[/\\]+$/g, '')
  const parts = normalized.split(/[/\\]/)
  return parts[parts.length - 1] || normalized
}

export function BrowseLocalFiles() {
  const { items, addFiles, addFolders, remove, clear } = useLocalUploadQueue()
  const { destinationUrl, destinationError, destinationFolderId, setDestinationUrl } =
    useUploadDestinationStore()
  const [isBrowsing, setIsBrowsing] = useState(false)
  const [isDropActive, setIsDropActive] = useState(false)

  const queueSummary = useMemo(() => {
    if (items.length === 0) return 'No items in queue'
    return items.length === 1 ? '1 item in queue' : `${items.length} items in queue`
  }, [items.length])

  const startUploadDisabled =
    items.length === 0 || !destinationFolderId || destinationError

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

              type ClassifiedPath = { path: string; kind: 'file' | 'folder' }

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

                const addedCount = classified.filter(p => !existing.has(p.path))
                  .length
                if (addedCount > 0) {
                  toast.success(`Added ${addedCount} items to queue`)
                }
              } catch (error) {
                logger.warn('Failed to classify dropped paths, defaulting to file', {
                  error: String(error),
                })
                const toAdd = paths.map(path => ({ path, kind: 'file' as const }))
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
    <div className="flex h-full w-full flex-col gap-6 p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">Browse local files</h1>
        <p className="text-sm text-muted-foreground">
          Select files, then folders (best cross-platform approximation for a mixed picker).
        </p>
      </header>

      <section className="space-y-2">
        <Label htmlFor="destination-url">Destination folder URL</Label>
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
        {destinationError ? (
          <p className="text-sm text-destructive">
            Please enter a Google Drive <em>folder</em> URL.
          </p>
        ) : destinationFolderId ? (
          <p className="text-sm text-emerald-700 dark:text-emerald-400">
            Folder ID: <span className="font-mono">{destinationFolderId}</span>
          </p>
        ) : null}
      </section>

      <section className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">{queueSummary}</div>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={handleBrowse} disabled={isBrowsing}>
            {isBrowsing ? 'Browsing…' : 'Browse…'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={clear}
            disabled={items.length === 0}
          >
            Clear queue
          </Button>
          <Button type="button" disabled={startUploadDisabled}>
            Start upload
          </Button>
        </div>
      </section>

      <section
        aria-label="Drop zone"
        className={[
          'rounded-md border border-dashed p-8 text-center transition-colors',
          isDropActive
            ? 'border-primary bg-primary/5'
            : 'border-border bg-muted/20',
        ].join(' ')}
      >
        <div className="text-base font-medium">Drop files &amp; folders here</div>
        <div className="mt-1 text-sm text-muted-foreground">or use Browse…</div>
      </section>

      {items.length > 0 ? (
        <section className="overflow-hidden rounded-md border">
          <div className="grid grid-cols-[minmax(200px,1fr)_minmax(260px,2fr)_110px_80px] items-center gap-3 border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
            <div>Name</div>
            <div>Path</div>
            <div>Type</div>
            <div className="text-right">Actions</div>
          </div>
          <ul className="max-h-[55vh] overflow-auto">
            {items.map(item => (
              <li
                key={item.id}
                className="grid grid-cols-[minmax(200px,1fr)_minmax(260px,2fr)_110px_80px] items-start gap-3 border-b px-3 py-2 last:border-b-0"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {item.kind === 'folder' ? (
                    <FolderIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="truncate text-sm">{getPathName(item.path)}</div>
                </div>
                <div className="break-all text-sm text-muted-foreground">
                  {item.path}
                </div>
                <div>
                  <Badge variant={item.kind === 'folder' ? 'secondary' : 'default'}>
                    {item.kind === 'folder' ? 'Folder' : 'File'}
                  </Badge>
                </div>
                <div className="flex justify-end gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => remove(item.path)}
                    aria-label={`Remove ${item.path}`}
                  >
                    <XIcon className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
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
  )
}
