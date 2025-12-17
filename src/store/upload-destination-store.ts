import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { extractDriveFolderId } from '@/lib/drive-url'

export interface UploadDestinationState {
  destinationUrl: string
  destinationFolderId: string | null
  destinationError: boolean
  setDestinationUrl: (url: string) => void
  clearDestination: () => void
}

export const useUploadDestinationStore = create<UploadDestinationState>()(
  devtools(
    set => ({
      destinationUrl: '',
      destinationFolderId: null,
      destinationError: false,

      setDestinationUrl: url => {
        const trimmed = url.trim()
        const folderId = extractDriveFolderId(trimmed)
        set(
          {
            destinationUrl: url,
            destinationFolderId: folderId,
            destinationError: Boolean(trimmed) && !folderId,
          },
          undefined,
          'setDestinationUrl'
        )
      },

      clearDestination: () =>
        set(
          { destinationUrl: '', destinationFolderId: null, destinationError: false },
          undefined,
          'clearDestination'
        ),
    }),
    { name: 'upload-destination' }
  )
)
