import { Loader2 } from 'lucide-react'
import { useUIStore } from '@/store/ui-store'

interface UpdateSplashProps {
  visible: boolean
}

export function UpdateSplash({ visible }: UpdateSplashProps) {
  const { updateDownloading, updateProgress, updateReady, updateVersion } =
    useUIStore()

  if (!visible) return null

  const message = updateReady
    ? updateVersion
      ? `Update ready: ${updateVersion}`
      : 'Update ready'
    : updateDownloading
      ? updateProgress !== null
        ? `Downloading update (${updateProgress}%)`
        : 'Downloading update…'
      : 'Checking for updates…'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="w-[280px] rounded-2xl border border-border bg-card px-6 py-8 text-center shadow-xl">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Loader2 className="h-6 w-6 animate-spin text-foreground/80" />
        </div>
        <p className="mt-4 text-sm font-medium text-foreground">{message}</p>
        {updateReady ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Open Settings to restart and install.
          </p>
        ) : null}
      </div>
    </div>
  )
}
