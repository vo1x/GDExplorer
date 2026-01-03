import { useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { checkForUpdates } from '@/lib/updater'
import { useUIStore } from '@/store/ui-store'

export const AboutPane: React.FC = () => {
  const [appVersion, setAppVersion] = useState<string>('—')
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false)
  const { updateDownloading, updateProgress } = useUIStore()

  useEffect(() => {
    getVersion()
      .then(version => setAppVersion(version))
      .catch(() => setAppVersion('Unknown'))
  }, [])

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-medium text-foreground">About</h3>
        <Separator className="mt-2" />
      </div>
      <div className="space-y-1">
        <p className="text-sm text-foreground">GDExplorer</p>
        <p className="text-sm text-muted-foreground">Version {appVersion}</p>
      </div>
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Download updates automatically and restart when you are ready.
        </p>
        <Button
          type="button"
          onClick={async () => {
            if (isCheckingUpdates) return
            setIsCheckingUpdates(true)
            try {
              await checkForUpdates({
                notifyIfLatest: true,
                notifyOnError: true,
                notifyOnReady: true,
              })
            } finally {
              setIsCheckingUpdates(false)
            }
          }}
          disabled={isCheckingUpdates || updateDownloading}
          aria-busy={isCheckingUpdates || updateDownloading}
        >
          {updateDownloading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {updateProgress !== null
                ? `Downloading (${updateProgress}%)`
                : 'Downloading…'}
            </>
          ) : isCheckingUpdates ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking…
            </>
          ) : (
            'Check for updates'
          )}
        </Button>
      </div>
    </div>
  )
}
