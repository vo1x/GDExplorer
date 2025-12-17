import { create } from 'zustand'

type UploadRuntimeStatus =
  | 'queued'
  | 'preparing'
  | 'uploading'
  | 'paused'
  | 'done'
  | 'failed'

export interface TransferMetrics {
  speedBytesPerSec: number
  etaSeconds: number | null
}

interface TransferUiState {
  pausedById: Record<string, boolean>
  metricsById: Record<string, TransferMetrics>
  _lastSampleById: Record<string, { bytesSent: number; atMs: number }>
  _startedAtById: Record<string, number>

  isPaused: (id: string) => boolean
  setPaused: (id: string, paused: boolean) => void
  pauseAll: (ids: string[]) => void
  resumeAll: (ids: string[]) => void
  clearRemoved: (remainingIds: string[]) => void

  tick: (
    items: {
      id: string
      status?: UploadRuntimeStatus | null
      bytesSent?: number | null
      totalBytes?: number | null
    }[]
  ) => void
}

export const useTransferUiStore = create<TransferUiState>((set, get) => ({
  pausedById: {},
  metricsById: {},
  _lastSampleById: {},
  _startedAtById: {},

  isPaused: id => Boolean(get().pausedById[id]),

  setPaused: (id, paused) =>
    set(state => ({
      pausedById: paused
        ? { ...state.pausedById, [id]: true }
        : omitKey(state.pausedById, id),
    })),

  pauseAll: ids =>
    set(state => {
      const next = { ...state.pausedById }
      for (const id of ids) next[id] = true
      return { pausedById: next }
    }),

  resumeAll: ids =>
    set(state => {
      if (ids.length === 0) return state
      const remove = new Set(ids)
      const next: Record<string, boolean> = {}
      for (const [id, v] of Object.entries(state.pausedById)) {
        if (!remove.has(id)) next[id] = v
      }
      return { pausedById: next }
    }),

  clearRemoved: remainingIds =>
    set(state => {
      const remaining = new Set(remainingIds)
      const nextPaused: Record<string, boolean> = {}
      const nextMetrics: Record<string, TransferMetrics> = {}
      const nextLast: Record<string, { bytesSent: number; atMs: number }> = {}
      const nextStarted: Record<string, number> = {}

      for (const [id, v] of Object.entries(state.pausedById)) {
        if (remaining.has(id)) nextPaused[id] = v
      }
      for (const [id, v] of Object.entries(state.metricsById)) {
        if (remaining.has(id)) nextMetrics[id] = v
      }
      for (const [id, v] of Object.entries(state._lastSampleById)) {
        if (remaining.has(id)) nextLast[id] = v
      }
      for (const [id, v] of Object.entries(state._startedAtById)) {
        if (remaining.has(id)) nextStarted[id] = v
      }

      return {
        pausedById: nextPaused,
        metricsById: nextMetrics,
        _lastSampleById: nextLast,
        _startedAtById: nextStarted,
      }
    }),

  tick: items =>
    set(state => {
      const now = Date.now()
      let metricsById = state.metricsById
      let lastSampleById = state._lastSampleById
      let startedAtById = state._startedAtById

      for (const item of items) {
        const id = item.id
        const paused = Boolean(state.pausedById[id])
        const status = item.status ?? 'queued'
        const total = typeof item.totalBytes === 'number' ? item.totalBytes : 0
        const sent = typeof item.bytesSent === 'number' ? item.bytesSent : 0

        const isActive =
          !paused &&
          (status === 'uploading' ||
            status === 'preparing' ||
            (sent > 0 &&
              status !== 'paused' &&
              status !== 'done' &&
              status !== 'failed'))

        // Establish a stable "started at" time so speed/ETA can be computed even if the first
        // progress event arrives with bytesSent > 0 (common with larger chunks / slower UIs).
        if (isActive && startedAtById[id] === undefined) {
          if (startedAtById === state._startedAtById) {
            startedAtById = { ...state._startedAtById }
          }
          startedAtById[id] = now
        } else if (!isActive && startedAtById[id] !== undefined) {
          // Reset once inactive to avoid stale baselines.
          if (startedAtById === state._startedAtById) {
            startedAtById = { ...state._startedAtById }
          }
          startedAtById = omitKey(startedAtById, id)
        }

        const prev = lastSampleById[id]
        const atMs = prev?.atMs ?? now
        const dtMs = Math.max(250, now - atMs)
        const prevSent = prev?.bytesSent ?? sent
        const delta = Math.max(0, sent - prevSent)

        // Only update the sample when bytes have actually advanced; updating the timestamp
        // every tick would make speed/ETA incorrect for large chunks.
        if (isActive && delta > 0) {
          if (lastSampleById === state._lastSampleById) {
            lastSampleById = { ...state._lastSampleById }
          }
          lastSampleById[id] = { bytesSent: sent, atMs: now }
        }

        const baselineAtMs = startedAtById[id]
        const baselineDtMs =
          baselineAtMs !== undefined ? Math.max(250, now - baselineAtMs) : dtMs

        const speed = isActive
          ? delta > 0
            ? Math.max(0, Math.round((delta * 1000) / dtMs))
            : sent > 0 && baselineAtMs !== undefined
              ? Math.max(0, Math.round((sent * 1000) / baselineDtMs))
              : (state.metricsById[id]?.speedBytesPerSec ?? 0)
          : paused
            ? 0
            : 0

        const etaSeconds =
          isActive && total > 0 && speed > 0
            ? Math.max(0, Math.round((total - Math.min(sent, total)) / speed))
            : status === 'done'
              ? 0
              : paused
                ? null
                : null

        const prevMetrics = state.metricsById[id]
        const nextMetrics: TransferMetrics = {
          speedBytesPerSec: speed,
          etaSeconds,
        }
        if (
          !prevMetrics ||
          prevMetrics.speedBytesPerSec !== nextMetrics.speedBytesPerSec ||
          prevMetrics.etaSeconds !== nextMetrics.etaSeconds
        ) {
          if (metricsById === state.metricsById)
            metricsById = { ...state.metricsById }
          metricsById[id] = nextMetrics
        }
      }

      return {
        metricsById,
        _lastSampleById: lastSampleById,
        _startedAtById: startedAtById,
      }
    }),
}))

function omitKey<T extends Record<string, unknown>>(obj: T, key: string): T {
  if (!(key in obj)) return obj
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { [key]: _removed, ...rest } = obj as any
  return rest as T
}
