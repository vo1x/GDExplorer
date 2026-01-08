import {
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  Fragment,
} from 'react'
import { Button } from '@/components/ui/button'
import { invoke } from '@tauri-apps/api/core'
// import { appLogDir, join } from '@tauri-apps/api/path'
// import { openPath } from '@tauri-apps/plugin-opener'
import {
  flexRender,
  getCoreRowModel,
  type RowSelectionState,
  useReactTable,
} from '@tanstack/react-table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useLocalUploadQueue } from '@/store/local-upload-queue-store'
import { useTransferUiStore } from '@/store/transfer-ui-store'
import { ProgressBar, type TransferState } from './ProgressBar'
import { formatBytes, formatEta, formatSpeed } from './format'
import {
  FileIcon,
  FolderIcon,
  AlertTriangleIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  FolderOpen,
  Trash2,
  Pause,
  BrushCleaning,
  Play,
} from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
// import { toast } from 'sonner'
// import { logger } from '@/lib/logger'

function getPathName(path: string): string {
  const normalized = path.replace(/[/\\]+$/g, '')
  const parts = normalized.split(/[/\\]/)
  return parts[parts.length - 1] || normalized
}

function getRelativePath(basePath: string, filePath: string): string {
  const normalizedBase = basePath.replace(/[/\\]+$/g, '')
  if (filePath.startsWith(normalizedBase)) {
    const trimmed = filePath.slice(normalizedBase.length)
    return trimmed.replace(/^[/\\]+/, '') || getPathName(filePath)
  }
  return filePath
}

type UploadRuntimeStatus =
  | 'queued'
  | 'preparing'
  | 'uploading'
  | 'paused'
  | 'done'
  | 'failed'

interface TransferRowData {
  id: string
  name: string
  path: string
  kind: 'file' | 'folder'
  status: UploadRuntimeStatus
  totalBytes: number | null
  bytesSent: number | null
  error: string | null
  saEmail: string | null
  progressPct: number
  progressState: TransferState
  statusLabel: string
  sizeLabel: string
  speedLabel: string
  etaLabel: string
}

export function TransferTable({
  isDropActive,
  onBrowse,
  onStartSelected,
  onPauseSelected,
  isUploading,
}: {
  isDropActive: boolean
  onBrowse: () => void
  onStartSelected: (itemIds: string[]) => void
  onPauseSelected: (itemIds: string[]) => void
  isUploading: boolean
}) {
  const items = useLocalUploadQueue(s => s.items)
  const clear = useLocalUploadQueue(s => s.clear)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const [clearPending, setClearPending] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deletePending, setDeletePending] = useState(false)

  const clearRemoved = useTransferUiStore(s => s.clearRemoved)
  const tick = useTransferUiStore(s => s.tick)

  const paused = useTransferUiStore(s => s.pausedById)
  const metrics = useTransferUiStore(s => s.metricsById)
  const fileProgressById = useTransferUiStore(s => s.fileProgressById)
  const fileOrderById = useTransferUiStore(s => s.fileOrderById)
  const fileMetricsById = useTransferUiStore(s => s.fileMetricsById)
  const recordFileList = useTransferUiStore(s => s.recordFileList)
  const listRequestRef = useRef<Record<string, boolean>>({})

  const rows = useMemo((): TransferRowData[] => {
    return items.map(item => {
      const runtime = (item.status ?? 'queued') as UploadRuntimeStatus
      const rowPaused = Boolean(paused[item.id])
      const rowMetrics = metrics[item.id]

      const total =
        typeof item.totalBytes === 'number' && item.totalBytes > 0
          ? item.totalBytes
          : 0
      const sent =
        typeof item.bytesSent === 'number' && item.bytesSent > 0
          ? item.bytesSent
          : 0

      const progressState: TransferState =
        runtime === 'done'
          ? 'completed'
          : runtime === 'failed'
            ? 'failed'
            : runtime === 'paused'
              ? 'paused'
              : rowPaused
                ? 'paused'
                : runtime === 'uploading' || runtime === 'preparing'
                  ? 'uploading'
                  : 'queued'

      const rawPct = total > 0 ? (Math.min(sent, total) / total) * 100 : 0
      const progressPct =
        progressState === 'completed'
          ? 100
          : progressState === 'failed'
            ? Math.min(99.9, rawPct)
            : Math.min(99.9, rawPct)

      const isFinalizing =
        progressState === 'uploading' && total > 0 && sent >= total
      const statusLabel =
        runtime === 'preparing'
          ? 'Preparing'
          : progressState === 'uploading'
            ? isFinalizing
              ? 'Finalizing'
              : 'Uploading'
            : progressState === 'paused'
              ? 'Paused'
              : progressState === 'completed'
                ? 'Completed'
                : progressState === 'failed'
                  ? 'Failed'
                  : 'Queued'

      const speedLabel =
        progressState === 'uploading'
          ? formatSpeed(rowMetrics?.speedBytesPerSec ?? 0)
          : progressState === 'paused'
            ? '0 B/s'
            : '—'

      const remaining = Math.max(0, total - Math.min(sent, total))
      const etaSeconds =
        progressState === 'uploading' && (rowMetrics?.speedBytesPerSec ?? 0) > 0
          ? Math.round(remaining / (rowMetrics?.speedBytesPerSec ?? 0))
          : null
      const etaLabel =
        progressState === 'uploading'
          ? formatEta(etaSeconds)
          : progressState === 'paused'
            ? '∞'
            : '—'

      const sizeLabel = total > 0 ? formatBytes(total) : '—'

      return {
        id: item.id,
        name: getPathName(item.path),
        path: item.path,
        kind: item.kind,
        status: runtime,
        totalBytes: item.totalBytes ?? null,
        bytesSent: item.bytesSent ?? null,
        error: item.message ?? null,
        saEmail: item.saEmail ?? null,
        progressPct,
        progressState,
        statusLabel,
        sizeLabel,
        speedLabel,
        etaLabel,
      }
    })
  }, [items, metrics, paused])

  useEffect(() => {
    clearRemoved(items.map(i => i.id))
  }, [clearRemoved, items])

  useEffect(() => {
    const interval = setInterval(() => {
      tick(
        items.map(i => ({
          id: i.id,
          status: i.status ?? 'queued',
          bytesSent: i.bytesSent ?? 0,
          totalBytes: i.totalBytes ?? 0,
        }))
      )
    }, 500)
    return () => clearInterval(interval)
  }, [items, tick])

  const hasCompleted = rows.some(row => row.status === 'done')

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const lastIndexRef = useRef<number | null>(null)
  const [expandedById, setExpandedById] = useState<Record<string, boolean>>({})
  // const [logsPending, setLogsPending] = useState(false)

  useEffect(() => {
    const valid = new Set(items.map(i => i.id))
    setRowSelection(prev => {
      let changed = false
      const next: RowSelectionState = {}
      for (const [id, v] of Object.entries(prev)) {
        if (v && valid.has(id)) next[id] = true
        else changed = true
      }
      return changed ? next : prev
    })
  }, [items])

  useEffect(() => {
    const valid = new Set(
      items.filter(item => item.kind === 'folder').map(item => item.id)
    )
    setExpandedById(prev => {
      let changed = false
      const next: Record<string, boolean> = {}
      for (const [id, v] of Object.entries(prev)) {
        if (v && valid.has(id)) next[id] = v
        else changed = true
      }
      return changed ? next : prev
    })
  }, [items])

  const table = useReactTable({
    data: rows,
    columns: [
      {
        header: 'Name',
        accessorKey: 'name',
        cell: ({ row }) => {
          const item = row.original
          const isExpanded = Boolean(expandedById[item.id])
          return (
            <div className="flex min-w-0 items-center gap-2">
              {item.kind === 'folder' ? (
                <button
                  type="button"
                  onClick={event => {
                    event.stopPropagation()
                    if (!listRequestRef.current[item.id]) {
                      const shouldFetch =
                        item.kind === 'folder' &&
                        (fileOrderById[item.id]?.length ?? 0) === 0
                      if (shouldFetch) {
                        listRequestRef.current[item.id] = true
                        invoke<{ filePath: string; totalBytes: number }[]>(
                          'list_item_files',
                          { path: item.path, kind: 'folder' }
                        )
                          .then(files => {
                            if (files.length === 0) return
                            recordFileList(
                              item.id,
                              files.map(file => ({
                                filePath: file.filePath,
                                bytesSent: 0,
                                totalBytes: file.totalBytes,
                              }))
                            )
                          })
                          .catch(() => {
                            listRequestRef.current[item.id] = false
                          })
                      }
                    }
                    setExpandedById(prev => ({
                      ...prev,
                      [item.id]: !isExpanded,
                    }))
                  }}
                  className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                  aria-label={
                    isExpanded ? `Collapse ${item.name}` : `Expand ${item.name}`
                  }
                >
                  {isExpanded ? (
                    <ChevronDownIcon className="size-4" />
                  ) : (
                    <ChevronRightIcon className="size-4" />
                  )}
                </button>
              ) : (
                <span className="size-5" aria-hidden="true" />
              )}
              {item.kind === 'folder' ? (
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <div className="truncate font-medium">{item.name}</div>
            </div>
          )
        },
      },
      {
        header: 'Progress',
        accessorKey: 'progressPct',
        cell: ({ row }) => (
          <ProgressBar
            percent={row.original.progressPct}
            state={row.original.progressState}
          />
        ),
      },
      {
        header: 'Status',
        accessorKey: 'statusLabel',
        cell: ({ row }) => {
          const item = row.original
          const cls =
            item.progressState === 'failed'
              ? 'text-red-300'
              : item.progressState === 'completed'
                ? 'text-emerald-300'
                : item.progressState === 'uploading'
                  ? 'text-sky-200'
                  : item.progressState === 'paused'
                    ? 'text-yellow-200'
                    : 'text-muted-foreground'

          return (
            <div className={['flex flex-col gap-0.5 text-xs', cls].join(' ')}>
              {item.progressState === 'failed' && item.error ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1">
                      <AlertTriangleIcon className="size-3.5" />
                      {item.statusLabel}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="start">
                    <div className="max-w-[420px] text-xs">{item.error}</div>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span>{item.statusLabel}</span>
              )}
              {item.saEmail ? (
                <span className="text-[10px] text-muted-foreground">
                  {item.saEmail}
                </span>
              ) : null}
            </div>
          )
        },
      },
      {
        header: 'Size',
        accessorKey: 'sizeLabel',
        cell: ({ row }) => (
          <div className="text-xs tabular-nums text-muted-foreground">
            {row.original.sizeLabel}
          </div>
        ),
      },
      {
        header: 'Speed',
        accessorKey: 'speedLabel',
        cell: ({ row }) => (
          <div className="text-xs tabular-nums text-muted-foreground">
            {row.original.speedLabel}
          </div>
        ),
      },
      {
        header: 'ETA',
        accessorKey: 'etaLabel',
        cell: ({ row }) => (
          <div className="text-xs tabular-nums text-muted-foreground">
            {row.original.etaLabel}
          </div>
        ),
      },
    ],
    state: { rowSelection },
    getRowId: row => row.id,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: true,
    getCoreRowModel: getCoreRowModel(),
  })

  const selectedIds = useMemo(
    () => Object.keys(rowSelection).filter(id => rowSelection[id]),
    [rowSelection]
  )

  const handleDeleteSelected = () => {
    if (selectedIds.length === 0) return
    const selectedItems = items.filter(item => selectedIds.includes(item.id))
    const selectedPaths = new Set(selectedItems.map(item => item.path))
    invoke('cancel_items', { args: { itemIds: selectedIds } }).catch(() => {
      // Ignore backend errors; UI still removes items.
    })
    for (const path of selectedPaths) {
      useLocalUploadQueue.getState().remove(path)
    }
    setRowSelection({})
  }

  const handleRowClick = (rowId: string, rowIndex: number, e: MouseEvent) => {
    const isToggle = e.metaKey || e.ctrlKey
    const isRange = e.shiftKey

    if (isRange && lastIndexRef.current !== null) {
      const start = Math.min(lastIndexRef.current, rowIndex)
      const end = Math.max(lastIndexRef.current, rowIndex)
      const next: RowSelectionState = isToggle ? { ...rowSelection } : {}
      const all = table.getRowModel().rows
      for (let i = start; i <= end; i++) {
        const id = all[i]?.id
        if (id) next[id] = true
      }
      setRowSelection(next)
      return
    }

    lastIndexRef.current = rowIndex
    if (isToggle) {
      setRowSelection(prev => ({ ...prev, [rowId]: !prev[rowId] }))
      return
    }

    setRowSelection({ [rowId]: true })
  }
  const handleBackgroundClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element) {
      if (event.target.closest('[data-row]')) return
    }
    setRowSelection({})
  }

  // const handleOpenLogs = async () => {
  //   if (logsPending) return
  //   setLogsPending(true)
  //   try {
  //     const dir = await appLogDir()
  //     const logPath = await join(dir, 'gdexplorer.log.txt')
  //     await openPath(logPath)
  //   } catch (error) {
  //     logger.warn('Failed to open log file', { error: String(error) })
  //     toast.error('Failed to open log file')
  //   } finally {
  //     setLogsPending(false)
  //   }
  // }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onStartSelected(selectedIds)}
            disabled={selectedIds.length === 0}
            className="gap-2 bg-emerald-500/90 text-[#DCFCE7]  hover:bg-emerald-500 disabled:bg-emerald-500/40"
          >
            <Play className="size-4" fill='#DCFCE7' />
            Upload
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onPauseSelected(selectedIds)}
            disabled={selectedIds.length === 0 || !isUploading}
            title={
              selectedIds.length === 0
                ? 'Select one or more rows'
                : isUploading
                  ? undefined
                  : 'Nothing is uploading'
            }
            className="gap-2 bg-amber-400/90 text-[#FDE68A] hover:bg-amber-400 disabled:bg-amber-400/40"
          >
            <Pause className="size-4" fill='#FDE68A'/>
            Pause
          </Button>

          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              // UI-only: clearing completed just removes completed rows.
              // (Backend does not keep running tasks for completed items.)
              const toRemove = rows.filter(r => r.status === 'done')
              for (const it of toRemove) {
                // Remove by path via store method; import lazily to avoid extra selector.
                useLocalUploadQueue.getState().remove(it.path)
              }
            }}
            disabled={!hasCompleted}
            className="gap-2 bg-slate-700/70 text-slate-100 hover:bg-slate-700 disabled:bg-slate-700/40"
          >
            <BrushCleaning className="size-4" />
            Clear completed
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => setDeleteDialogOpen(true)}
            disabled={selectedIds.length === 0}
            className="gap-2 text-[#FEE2E2]"
          >
            <Trash2 className="size-4"  />
            Delete
          </Button>
          {/* <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setClearDialogOpen(true)}
            disabled={!hasAny}
          >
            Clear all
          </Button> */}
            {/* <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleOpenLogs}
              disabled={logsPending}
            >
              Open logs
            </Button> */}
        </div>
      </div>

      <AlertDialog
        open={deleteDialogOpen}
        onOpenChange={open => !deletePending && setDeleteDialogOpen(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete selected transfers?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the selected items from the queue.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deletePending}
              onClick={() => {
                setDeletePending(true)
                try {
                  handleDeleteSelected()
                } finally {
                  setDeletePending(false)
                  setDeleteDialogOpen(false)
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={clearDialogOpen}
        onOpenChange={open => !clearPending && setClearDialogOpen(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all transfers?</AlertDialogTitle>
            <AlertDialogDescription>
              This will stop uploads in progress and clear the list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={clearPending}
              onClick={async () => {
                setClearPending(true)
                try {
                  await invoke('cancel_upload')
                } catch {
                  // ignore; UI state still clears
                } finally {
                  clear()
                  setClearPending(false)
                  setClearDialogOpen(false)
                }
              }}
            >
              Clear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div
        className={[
          'min-h-0 flex-1 overflow-auto rounded-md border',
          isDropActive ? 'border-primary bg-primary/5' : 'border-border',
        ].join(' ')}
      >
        <div
          className="grid grid-cols-[minmax(220px,1.8fr)_minmax(180px,1.4fr)_110px_100px_110px_80px] items-center gap-3 border-b bg-muted/20 px-3 py-2 text-[11px] font-medium text-muted-foreground"
          role="row"
        >
          {table.getHeaderGroups().map(headerGroup =>
            headerGroup.headers.map(header => (
              <div key={header.id} role="columnheader">
                {header.isPlaceholder
                  ? null
                  : flexRender(
                      header.column.columnDef.header,
                      header.getContext()
                    )}
              </div>
            ))
          )}
        </div>

        {rows.length > 0 ? (
          <div role="rowgroup" onClick={handleBackgroundClick}>
            {table.getRowModel().rows.map(row => {
              const item = row.original
              const isExpanded = Boolean(expandedById[item.id])
              const fileOrder = fileOrderById[item.id] ?? []
              const fileProgress = fileProgressById[item.id] ?? {}
              const fileMetrics = fileMetricsById[item.id] ?? {}

              return (
                <Fragment key={row.id}>
                  <div
                    role="row"
                    onClick={e => handleRowClick(row.id, row.index, e)}
                    className={[
                      'group grid cursor-default grid-cols-[minmax(220px,1.8fr)_minmax(180px,1.4fr)_110px_100px_110px_80px] items-center gap-3 px-3 py-2 text-sm',
                      row.index % 2 === 0 ? 'bg-background' : 'bg-muted/10',
                      row.getIsSelected()
                        ? 'bg-primary/12 outline outline-1 outline-primary/40'
                        : '',
                    ].join(' ')}
                    data-row="parent"
                  >
                    {row.getVisibleCells().map(cell => (
                      <div key={cell.id} role="cell" className="min-w-0">
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext()
                        )}
                      </div>
                    ))}
                  </div>

                  {item.kind === 'folder' && isExpanded ? (
                    fileOrder.length > 0 ? (
                      fileOrder.map((filePath, index) => {
                        const progress = fileProgress[filePath]
                        const saEmail = progress?.saEmail ?? null
                        const total =
                          typeof progress?.totalBytes === 'number'
                            ? progress.totalBytes
                            : 0
                        const sent =
                          typeof progress?.bytesSent === 'number'
                            ? progress.bytesSent
                            : 0
                        const rawPct =
                          total > 0 ? (Math.min(sent, total) / total) * 100 : 0
                        const isCompleted = total > 0 && sent >= total
                        const parentState = row.original.progressState
                        const progressState: TransferState =
                          parentState === 'failed'
                            ? 'failed'
                            : parentState === 'paused'
                              ? 'paused'
                              : isCompleted
                                ? 'completed'
                                : sent > 0
                                  ? 'uploading'
                                  : parentState === 'uploading'
                                    ? 'uploading'
                                    : 'queued'
                        const isFinalizing =
                          progressState === 'uploading' &&
                          total > 0 &&
                          sent >= total
                        const statusLabel =
                          progressState === 'failed'
                            ? 'Failed'
                            : progressState === 'paused'
                              ? 'Paused'
                              : progressState === 'completed'
                                ? 'Completed'
                                : progressState === 'uploading'
                                  ? isFinalizing
                                    ? 'Finalizing'
                                    : 'Uploading'
                                  : 'Queued'
                        const sizeLabel = total > 0 ? formatBytes(total) : '—'
                        const speedValue =
                          fileMetrics[filePath]?.speedBytesPerSec ?? 0
                        const speedLabel =
                          progressState === 'uploading'
                            ? formatSpeed(speedValue)
                            : progressState === 'paused'
                              ? '0 B/s'
                              : '—'
                        const remainingChild = Math.max(
                          0,
                          total - Math.min(sent, total)
                        )
                        const etaValue =
                          speedValue > 0
                            ? Math.round(remainingChild / speedValue)
                            : null
                        const etaLabel =
                          progressState === 'uploading'
                            ? formatEta(etaValue)
                            : progressState === 'paused'
                              ? '∞'
                              : '—'

                        return (
                          <div
                            key={`${item.id}:${filePath}`}
                            role="row"
                            onClick={event => event.stopPropagation()}
                            className={[
                              'grid grid-cols-[minmax(220px,1.8fr)_minmax(180px,1.4fr)_110px_100px_110px_80px] items-center gap-3 px-3 py-2 text-xs',
                              index % 2 === 0 ? 'bg-muted/5' : 'bg-muted/10',
                            ].join(' ')}
                            data-row="child"
                          >
                            <div role="cell" className="min-w-0">
                              <div className="flex min-w-0 items-center gap-2 pl-7 text-muted-foreground">
                                <FileIcon className="size-3.5 shrink-0" />
                                <div className="truncate">
                                  {getRelativePath(item.path, filePath)}
                                </div>
                              </div>
                            </div>
                            <div role="cell">
                              <ProgressBar
                                percent={rawPct}
                                state={progressState}
                              />
                            </div>
                            <div
                              role="cell"
                              className={[
                                'flex flex-col gap-0.5 text-xs',
                                progressState === 'failed'
                                  ? 'text-red-300'
                                  : progressState === 'completed'
                                    ? 'text-emerald-300'
                                    : progressState === 'uploading'
                                      ? 'text-sky-200'
                                      : progressState === 'paused'
                                        ? 'text-yellow-200'
                                        : 'text-muted-foreground',
                              ].join(' ')}
                            >
                              <span>{statusLabel}</span>
                              {saEmail ? (
                                <span className="text-[10px] text-muted-foreground">
                                  {saEmail}
                                </span>
                              ) : null}
                            </div>
                            <div
                              role="cell"
                              className="text-xs tabular-nums text-muted-foreground"
                            >
                              {sizeLabel}
                            </div>
                            <div
                              role="cell"
                              className="text-xs tabular-nums text-muted-foreground"
                            >
                              {speedLabel}
                            </div>
                            <div
                              role="cell"
                              className="text-xs tabular-nums text-muted-foreground"
                            >
                              {etaLabel}
                            </div>
                          </div>
                        )
                      })
                    ) : (
                      <div
                        role="row"
                        className="grid grid-cols-[minmax(220px,1.8fr)_minmax(180px,1.4fr)_110px_100px_110px_80px] items-center gap-3 px-3 py-2 text-xs text-muted-foreground"
                      >
                        <div role="cell" className="min-w-0">
                          <div className="pl-7">Waiting for file progress…</div>
                        </div>
                        <div role="cell" />
                        <div role="cell" />
                        <div role="cell" />
                        <div role="cell" />
                        <div role="cell" />
                      </div>
                    )
                  ) : null}
                </Fragment>
              )
            })}
          </div>
        ) : (
          <div className="flex h-[260px] flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="text-base font-medium">
              Drop files &amp; folders here
            </div>
            <div className="text-sm text-muted-foreground">
              or click Browse…
            </div>
            <Button
              type="button"
              onClick={onBrowse}
              className="gap-2 border-slate-500/30 bg-slate-900/40 text-slate-100 hover:bg-slate-900/70"
              variant="outline"
            >
              <FolderOpen className="size-4" />
              Browse
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
