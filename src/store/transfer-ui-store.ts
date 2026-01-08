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

export interface FileProgress {
  bytesSent: number
  totalBytes: number
  saEmail?: string | null
}

export interface FileProgressByPath extends FileProgress {
  filePath: string
}

export interface FileMetrics {
  speedBytesPerSec: number
  etaSeconds: number | null
}

interface TransferUiState {
  pausedById: Record<string, boolean>
  metricsById: Record<string, TransferMetrics>
  fileProgressById: Record<string, Record<string, FileProgress>>
  fileOrderById: Record<string, string[]>
  fileMetricsById: Record<string, Record<string, FileMetrics>>
  _fileLastSampleById: Record<
    string,
    Record<string, { bytesSent: number; atMs: number }>
  >
  _lastSampleById: Record<string, { bytesSent: number; atMs: number }>
  _startedAtById: Record<string, number>

  isPaused: (id: string) => boolean
  setPaused: (id: string, paused: boolean) => void
  pauseAll: (ids: string[]) => void
  resumeAll: (ids: string[]) => void
  recordFileProgress: (
    itemId: string,
    filePath: string,
    bytesSent: number,
    totalBytes: number,
    saEmail?: string | null
  ) => void
  recordFileList: (itemId: string, files: FileProgressByPath[]) => void
  clearFileProgress: (itemIds: string[]) => void
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
  fileProgressById: {},
  fileOrderById: {},
  fileMetricsById: {},
  _fileLastSampleById: {},
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

  recordFileProgress: (itemId, filePath, bytesSent, totalBytes, saEmail) =>
    set(state => {
      const trimmed = filePath.trim()
      if (!trimmed) return state

      const existingByItem = state.fileProgressById[itemId]
      const existingOrder = state.fileOrderById[itemId]
      const existingMetrics = state.fileMetricsById[itemId]
      const existingSamples = state._fileLastSampleById[itemId]
      const resolvedKey =
        existingOrder && existingByItem
          ? resolveFileKey(existingOrder, trimmed)
          : trimmed
      const isNewFile = !existingByItem || !(resolvedKey in existingByItem)

      const nextByItem = existingByItem
        ? { ...existingByItem }
        : ({} as Record<string, FileProgress>)
      nextByItem[resolvedKey] = {
        bytesSent,
        totalBytes,
        saEmail:
          saEmail ?? existingByItem?.[resolvedKey]?.saEmail ?? null,
      }

      const nextOrder = isNewFile
        ? [...(existingOrder ?? []), resolvedKey]
        : (existingOrder ?? [])

      const now = Date.now()
      const prevSample = existingSamples?.[resolvedKey]
      const atMs = prevSample?.atMs ?? now
      const dtMs = Math.max(250, now - atMs)
      const prevSent = prevSample?.bytesSent ?? bytesSent
      const delta = Math.max(0, bytesSent - prevSent)
      const prevSpeed = existingMetrics?.[resolvedKey]?.speedBytesPerSec ?? 0
      const speed =
        delta > 0 ? Math.max(0, Math.round((delta * 1000) / dtMs)) : prevSpeed
      const remaining = Math.max(
        0,
        totalBytes - Math.min(bytesSent, totalBytes)
      )
      const etaSeconds = speed > 0 ? Math.round(remaining / speed) : null

      const nextSamples = {
        ...(existingSamples ?? {}),
        [resolvedKey]: { bytesSent, atMs: delta > 0 ? now : atMs },
      }

      const nextMetrics = {
        ...(existingMetrics ?? {}),
        [resolvedKey]: { speedBytesPerSec: speed, etaSeconds },
      }

      return {
        fileProgressById: {
          ...state.fileProgressById,
          [itemId]: nextByItem,
        },
        fileOrderById: {
          ...state.fileOrderById,
          [itemId]: nextOrder,
        },
        fileMetricsById: {
          ...state.fileMetricsById,
          [itemId]: nextMetrics,
        },
        _fileLastSampleById: {
          ...state._fileLastSampleById,
          [itemId]: nextSamples,
        },
      }
    }),

  recordFileList: (itemId, files) =>
    set(state => {
      if (!files.length) return state

      const existingOrder = state.fileOrderById[itemId] ?? []
      const existingByItem = state.fileProgressById[itemId] ?? {}
      const nextByItem: Record<string, FileProgress> = {
        ...existingByItem,
      }
      const nextOrder = [...existingOrder]
      for (const entry of files) {
        const trimmed = entry.filePath.trim()
        if (!trimmed) continue
        if (trimmed in nextByItem) {
          continue
        }
        const resolved = resolveFileKey(existingOrder, trimmed)
        if (resolved in nextByItem) {
          continue
        }
        nextByItem[trimmed] = {
          bytesSent: entry.bytesSent,
          totalBytes: entry.totalBytes,
        }
        nextOrder.push(trimmed)
      }

      if (nextOrder.length === 0) return state

      const nextMetrics: Record<string, FileMetrics> = {}
      const nextSamples: Record<string, { bytesSent: number; atMs: number }> =
        {}
      const now = Date.now()
      for (const filePath of nextOrder) {
        nextMetrics[filePath] = { speedBytesPerSec: 0, etaSeconds: null }
        nextSamples[filePath] = { bytesSent: 0, atMs: now }
      }

      return {
        fileProgressById: {
          ...state.fileProgressById,
          [itemId]: nextByItem,
        },
        fileOrderById: {
          ...state.fileOrderById,
          [itemId]: nextOrder,
        },
        fileMetricsById: {
          ...state.fileMetricsById,
          [itemId]: {
            ...(state.fileMetricsById[itemId] ?? {}),
            ...nextMetrics,
          },
        },
        _fileLastSampleById: {
          ...state._fileLastSampleById,
          [itemId]: {
            ...(state._fileLastSampleById[itemId] ?? {}),
            ...nextSamples,
          },
        },
      }
    }),

  clearFileProgress: itemIds =>
    set(state => {
      if (itemIds.length === 0) return state
      const ids = new Set(itemIds)
      const nextById: Record<string, Record<string, FileProgress>> = {}
      const nextOrderById: Record<string, string[]> = {}
      const nextMetricsById: Record<string, Record<string, FileMetrics>> = {}
      const nextSamplesById: Record<
        string,
        Record<string, { bytesSent: number; atMs: number }>
      > = {}

      for (const [id, value] of Object.entries(state.fileProgressById)) {
        if (!ids.has(id)) nextById[id] = value
      }
      for (const [id, value] of Object.entries(state.fileOrderById)) {
        if (!ids.has(id)) nextOrderById[id] = value
      }
      for (const [id, value] of Object.entries(state.fileMetricsById)) {
        if (!ids.has(id)) nextMetricsById[id] = value
      }
      for (const [id, value] of Object.entries(state._fileLastSampleById)) {
        if (!ids.has(id)) nextSamplesById[id] = value
      }

      return {
        fileProgressById: nextById,
        fileOrderById: nextOrderById,
        fileMetricsById: nextMetricsById,
        _fileLastSampleById: nextSamplesById,
      }
    }),

  clearRemoved: remainingIds =>
    set(state => {
      const remaining = new Set(remainingIds)
      const nextPaused: Record<string, boolean> = {}
      const nextMetrics: Record<string, TransferMetrics> = {}
      const nextFileProgress: Record<string, Record<string, FileProgress>> = {}
      const nextFileOrder: Record<string, string[]> = {}
      const nextFileMetrics: Record<string, Record<string, FileMetrics>> = {}
      const nextFileSamples: Record<
        string,
        Record<string, { bytesSent: number; atMs: number }>
      > = {}
      const nextLast: Record<string, { bytesSent: number; atMs: number }> = {}
      const nextStarted: Record<string, number> = {}

      for (const [id, v] of Object.entries(state.pausedById)) {
        if (remaining.has(id)) nextPaused[id] = v
      }
      for (const [id, v] of Object.entries(state.metricsById)) {
        if (remaining.has(id)) nextMetrics[id] = v
      }
      for (const [id, v] of Object.entries(state.fileProgressById)) {
        if (remaining.has(id)) nextFileProgress[id] = v
      }
      for (const [id, v] of Object.entries(state.fileOrderById)) {
        if (remaining.has(id)) nextFileOrder[id] = v
      }
      for (const [id, v] of Object.entries(state.fileMetricsById)) {
        if (remaining.has(id)) nextFileMetrics[id] = v
      }
      for (const [id, v] of Object.entries(state._fileLastSampleById)) {
        if (remaining.has(id)) nextFileSamples[id] = v
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
        fileProgressById: nextFileProgress,
        fileOrderById: nextFileOrder,
        fileMetricsById: nextFileMetrics,
        _fileLastSampleById: nextFileSamples,
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

function resolveFileKey(existingOrder: string[], candidate: string): string {
  if (existingOrder.includes(candidate)) return candidate
  const base = getPathName(candidate)
  let match: string | null = null
  for (const entry of existingOrder) {
    if (getPathName(entry) === base) {
      if (match) return candidate
      match = entry
    }
  }
  return match ?? candidate
}

function getPathName(path: string): string {
  const normalized = path.replace(/[/\\]+$/g, '')
  const parts = normalized.split(/[/\\]/)
  return parts[parts.length - 1] || normalized
}
