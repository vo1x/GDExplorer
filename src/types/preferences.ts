// Types that match the Rust AppPreferences struct
// Only contains settings that should be persisted to disk
export interface AppPreferences {
  theme: string
  serviceAccountFolderPath: string | null
  maxConcurrentUploads: number
  destinationPresets: DestinationPreset[]
}

export interface DestinationPreset {
  id: string
  name: string
  url: string
}

export const defaultPreferences: AppPreferences = {
  theme: 'system',
  serviceAccountFolderPath: null,
  maxConcurrentUploads: 3,
  destinationPresets: [],
}
