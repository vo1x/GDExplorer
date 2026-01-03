import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

interface UIState {
  leftSidebarVisible: boolean
  preferencesOpen: boolean
  updateDownloading: boolean
  updateReady: boolean
  updateVersion: string | null
  updateProgress: number | null

  toggleLeftSidebar: () => void
  setLeftSidebarVisible: (visible: boolean) => void
  togglePreferences: () => void
  setPreferencesOpen: (open: boolean) => void
  setUpdateDownloading: (downloading: boolean, version?: string | null) => void
  setUpdateReady: (ready: boolean, version?: string | null) => void
  setUpdateProgress: (progress: number | null) => void
}

export const useUIStore = create<UIState>()(
  devtools(
    set => ({
      leftSidebarVisible: true,
      preferencesOpen: false,
      updateDownloading: false,
      updateReady: false,
      updateVersion: null,
      updateProgress: null,

      toggleLeftSidebar: () =>
        set(
          state => ({ leftSidebarVisible: !state.leftSidebarVisible }),
          undefined,
          'toggleLeftSidebar'
        ),

      setLeftSidebarVisible: visible =>
        set(
          { leftSidebarVisible: visible },
          undefined,
          'setLeftSidebarVisible'
        ),

      togglePreferences: () =>
        set(
          state => ({ preferencesOpen: !state.preferencesOpen }),
          undefined,
          'togglePreferences'
        ),

      setPreferencesOpen: open =>
        set({ preferencesOpen: open }, undefined, 'setPreferencesOpen'),

      setUpdateDownloading: (downloading, version = null) =>
        set(
          {
            updateDownloading: downloading,
            updateVersion: downloading ? version : null,
            updateProgress: downloading ? null : null,
          },
          undefined,
          'setUpdateDownloading'
        ),

      setUpdateReady: (ready, version = null) =>
        set(
          {
            updateReady: ready,
            updateVersion: ready ? version : null,
            updateDownloading: false,
            updateProgress: null,
          },
          undefined,
          'setUpdateReady'
        ),

      setUpdateProgress: progress =>
        set({ updateProgress: progress }, undefined, 'setUpdateProgress'),
    }),
    {
      name: 'ui-store',
    }
  )
)
