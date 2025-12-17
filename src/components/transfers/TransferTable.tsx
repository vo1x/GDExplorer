import { useEffect, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { useLocalUploadQueue } from '@/store/local-upload-queue-store'
import { useTransferUiStore } from '@/store/transfer-ui-store'
import { TransferRow } from './TransferRow'

function getPathName(path: string): string {
  const normalized = path.replace(/[/\\]+$/g, '')
  const parts = normalized.split(/[/\\]/)
  return parts[parts.length - 1] || normalized
}

export function TransferTable() {
  const items = useLocalUploadQueue(s => s.items)
  const remove = useLocalUploadQueue(s => s.remove)
  const clear = useLocalUploadQueue(s => s.clear)

  const pauseAll = useTransferUiStore(s => s.pauseAll)
  const resumeAll = useTransferUiStore(s => s.resumeAll)
  const clearRemoved = useTransferUiStore(s => s.clearRemoved)
  const tick = useTransferUiStore(s => s.tick)

  const rows = useMemo(
    () =>
      items.map(item => ({
        id: item.id,
        name: getPathName(item.path),
        kind: item.kind,
        status: (item.status ?? 'queued') as any,
        totalBytes: item.totalBytes ?? null,
        bytesSent: item.bytesSent ?? null,
        error: item.message ?? null,
      })),
    [items]
  )

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

  const ids = useMemo(() => items.map(i => i.id), [items])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium">Transfers</div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => pauseAll(ids)}
            disabled={ids.length === 0}
          >
            Pause all
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => resumeAll(ids)}
            disabled={ids.length === 0}
          >
            Resume all
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              for (const item of items) {
                if (item.status === 'done') remove(item.path)
              }
            }}
            disabled={items.every(i => i.status !== 'done')}
          >
            Remove completed
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clear}
            disabled={items.length === 0}
          >
            Clear
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-md border">
        <div
          className="grid grid-cols-[minmax(220px,1.8fr)_minmax(180px,1.4fr)_110px_100px_110px_80px] items-center gap-3 border-b bg-muted/20 px-3 py-2 text-[11px] font-medium text-muted-foreground"
          role="row"
        >
          <div role="columnheader">Name</div>
          <div role="columnheader">Progress</div>
          <div role="columnheader">Status</div>
          <div role="columnheader">Size</div>
          <div role="columnheader">Speed</div>
          <div role="columnheader">ETA</div>
        </div>

        {rows.length > 0 ? (
          <div role="rowgroup">
            {rows.map(item => (
              <TransferRow
                key={item.id}
                item={item}
              />
            ))}
          </div>
        ) : (
          <div className="p-6 text-sm text-muted-foreground">No transfers</div>
        )}
      </div>
    </div>
  )
}
