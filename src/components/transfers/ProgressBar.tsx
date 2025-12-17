import { cn } from '@/lib/utils'

export type TransferState =
  | 'queued'
  | 'uploading'
  | 'paused'
  | 'completed'
  | 'failed'

export function ProgressBar({
  percent,
  state,
}: {
  percent: number
  state: TransferState
}) {
  const pct = clamp(percent, 0, 100)
  const track =
    state === 'completed'
      ? 'bg-emerald-500/20'
      : state === 'uploading'
        ? 'bg-sky-500/15'
        : state === 'paused'
          ? 'bg-yellow-500/15'
          : state === 'failed'
            ? 'bg-red-500/15'
            : 'bg-muted/40'

  const fill =
    state === 'completed'
      ? 'bg-emerald-500'
      : state === 'uploading'
        ? 'bg-sky-500'
        : state === 'paused'
          ? 'bg-yellow-500'
          : state === 'failed'
            ? 'bg-red-500'
            : 'bg-muted-foreground/40'

  const text =
    state === 'failed'
      ? 'text-red-200'
      : state === 'completed'
        ? 'text-emerald-100'
        : 'text-foreground'

  return (
    <div
      className={cn('relative h-4 w-full overflow-hidden rounded-sm', track)}
    >
      <div
        className={cn(
          'absolute inset-y-0 left-0 transition-[width] duration-300 ease-out',
          fill
        )}
        style={{ width: `${pct}%` }}
      />
      <div
        className={cn(
          'relative z-10 flex h-full w-full items-center justify-center text-[11px] font-medium tabular-nums',
          text
        )}
      >
        {pct.toFixed(1)}%
      </div>
    </div>
  )
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}
