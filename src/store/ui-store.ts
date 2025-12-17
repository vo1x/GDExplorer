import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

interface UIState {
  leftSidebarVisible: boolean
  preferencesOpen: boolean

  toggleLeftSidebar: () => void
  setLeftSidebarVisible: (visible: boolean) => void
  togglePreferences: () => void
  setPreferencesOpen: (open: boolean) => void
}

export const useUIStore = create<UIState>()(
  devtools(
    set => ({
      leftSidebarVisible: true,
      preferencesOpen: false,

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
    }),
    {
      name: 'ui-store',
    }
  )
)
