// Types that match the Rust AppPreferences struct
// Only contains settings that should be persisted to disk
export interface AppPreferences {
  theme: string
  serviceAccountFolderPath: string | null
  maxConcurrentUploads: number
}

export const defaultPreferences: AppPreferences = {
  theme: 'system',
  serviceAccountFolderPath: null,
  maxConcurrentUploads: 3,
}
