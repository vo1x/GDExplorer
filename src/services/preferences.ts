import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import type { AppPreferences } from '@/types/preferences'
import { defaultPreferences } from '@/types/preferences'

// Query keys for preferences
export const preferencesQueryKeys = {
  all: ['preferences'] as const,
  preferences: () => [...preferencesQueryKeys.all] as const,
}

// TanStack Query hooks following the architectural patterns
export function usePreferences() {
  return useQuery({
    queryKey: preferencesQueryKeys.preferences(),
    queryFn: async (): Promise<AppPreferences> => {
      try {
        logger.debug('Loading preferences from backend')
        const preferences = await invoke<AppPreferences>('load_preferences')
        logger.info('Preferences loaded successfully', { preferences })
        return { ...defaultPreferences, ...preferences }
      } catch (error) {
        // Return defaults if preferences file doesn't exist yet
        logger.warn('Failed to load preferences, using defaults', { error })
        return defaultPreferences
      }
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
  })
}

export function useSavePreferences() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (preferencesUpdate: Partial<AppPreferences>) => {
      try {
        const current =
          queryClient.getQueryData<AppPreferences>(
            preferencesQueryKeys.preferences()
          ) ?? defaultPreferences
        const preferences: AppPreferences = { ...current, ...preferencesUpdate }

        logger.debug('Saving preferences to backend', { preferences })
        await invoke('save_preferences', { preferences })
        logger.info('Preferences saved successfully')
        return preferences
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error occurred'
        logger.error('Failed to save preferences', { error, preferencesUpdate })
        toast.error('Failed to save preferences', { description: message })
        throw error
      }
    },
    onSuccess: (_, preferencesUpdate) => {
      // Update the cache with the new preferences
      const current =
        queryClient.getQueryData<AppPreferences>(
          preferencesQueryKeys.preferences()
        ) ?? defaultPreferences
      queryClient.setQueryData(preferencesQueryKeys.preferences(), {
        ...current,
        ...preferencesUpdate,
      })
      logger.info('Preferences cache updated')
      toast.success('Preferences saved')
    },
  })
}
