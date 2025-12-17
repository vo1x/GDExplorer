import { memo, useMemo } from 'react'
import { FileIcon, FolderIcon, AlertTriangleIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ProgressBar, type TransferState } from './ProgressBar'
import { formatBytes, formatEta, formatSpeed } from './format'
import { useTransferUiStore } from '@/store/transfer-ui-store'

type UploadRuntimeStatus = 'queued' | 'preparing' | 'uploading' | 'done' | 'failed'

export interface TransferRowItem {
  id: string
  name: string
  kind: 'file' | 'folder'
  status?: UploadRuntimeStatus | null
  totalBytes?: number | null
  bytesSent?: number | null
  error?: string | null
}

export const TransferRow = memo(function TransferRow({
  item,
}: {
  item: TransferRowItem
}) {
  const paused = useTransferUiStore(s => Boolean(s.pausedById[item.id]))
  const metrics = useTransferUiStore(s => s.metricsById[item.id])

  const total = typeof item.totalBytes === 'number' ? item.totalBytes : 0
  const sent = typeof item.bytesSent === 'number' ? item.bytesSent : 0

  const derived = useMemo(() => {
    const runtime = (item.status ?? 'queued') as UploadRuntimeStatus
    const state: TransferState =
      runtime === 'done'
        ? 'completed'
        : runtime === 'failed'
          ? 'failed'
          : paused
            ? 'paused'
            : runtime === 'uploading'
              ? 'uploading'
              : 'queued'

    const rawPct = total > 0 ? (Math.min(sent, total) / total) * 100 : 0
    const pct =
      state === 'completed'
        ? 100
        : state === 'failed'
          ? Math.min(99.9, rawPct)
          : Math.min(99.9, rawPct)

    const statusLabel =
      state === 'uploading'
        ? 'Uploading'
        : state === 'paused'
          ? 'Paused'
          : state === 'completed'
            ? 'Completed'
            : state === 'failed'
              ? 'Failed'
              : 'Queued'

    const speed =
      state === 'uploading'
        ? formatSpeed(metrics?.speedBytesPerSec ?? 0)
        : state === 'paused'
          ? '0 B/s'
          : '—'

    const eta =
      state === 'uploading'
        ? formatEta(metrics?.etaSeconds ?? null)
        : state === 'paused'
          ? '∞'
          : '—'

    const size = total > 0 ? formatBytes(total) : '—'

    return { state, pct, statusLabel, speed, eta, size }
  }, [item.status, metrics?.etaSeconds, metrics?.speedBytesPerSec, paused, sent, total])

  return (
    <div
      className="group grid grid-cols-[minmax(220px,1.8fr)_minmax(180px,1.4fr)_110px_100px_110px_80px] items-center gap-3 px-3 py-2 text-sm odd:bg-muted/10 even:bg-background"
      role="row"
    >
      <div className="min-w-0" role="cell">
        <div className="flex min-w-0 items-center gap-2">
          {item.kind === 'folder' ? (
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <FileIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="truncate font-medium">{item.name}</div>
        </div>
      </div>

      <div role="cell">
        <ProgressBar percent={derived.pct} state={derived.state} />
      </div>

      <div
        className={[
          'flex items-center gap-1 text-xs',
          derived.state === 'failed'
            ? 'text-red-300'
          : derived.state === 'completed'
              ? 'text-emerald-300'
              : derived.state === 'uploading'
                ? 'text-sky-200'
                : derived.state === 'paused'
                  ? 'text-yellow-200'
                  : 'text-muted-foreground',
        ].join(' ')}
        role="cell"
      >
        {derived.state === 'failed' && item.error ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1">
                <AlertTriangleIcon className="size-3.5" />
                {derived.statusLabel}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" align="start">
              <div className="max-w-[420px] text-xs">{item.error}</div>
            </TooltipContent>
          </Tooltip>
        ) : (
          <span>{derived.statusLabel}</span>
        )}
      </div>

      <div className="text-xs tabular-nums text-muted-foreground" role="cell">
        {derived.size}
      </div>

      <div className="text-xs tabular-nums text-muted-foreground" role="cell">
        {derived.speed}
      </div>

      <div className="text-xs tabular-nums text-muted-foreground" role="cell">
        {derived.eta}
      </div>
    </div>
  )
})
