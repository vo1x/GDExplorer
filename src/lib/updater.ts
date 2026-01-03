import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { logger } from '@/lib/logger'
import { useUIStore } from '@/store/ui-store'
import { toast } from 'sonner'

let checkInFlight = false
let pendingUpdate: Awaited<ReturnType<typeof check>> | null = null

interface CheckOptions {
  notifyIfLatest?: boolean
  notifyOnError?: boolean
  notifyOnReady?: boolean
}

export async function checkForUpdates(options: CheckOptions = {}) {
  const {
    notifyIfLatest = false,
    notifyOnError = false,
    notifyOnReady = false,
  } = options

  if (checkInFlight) return
  checkInFlight = true

  try {
    const update = await check()
    if (!update) {
      if (notifyIfLatest) {
        toast.success('You are running the latest version')
      }
      return
    }

    const {
      updateDownloading,
      updateReady,
      setUpdateDownloading,
      setUpdateReady,
    } = useUIStore.getState()
    if (updateReady || updateDownloading) {
      if (notifyOnReady && updateReady) {
        toast('Update ready. Click the download icon to restart.')
      }
      return
    }

    setUpdateDownloading(true, update.version)
    logger.info(`Update available: ${update.version}`)

    await update.download(event => {
      switch (event.event) {
        case 'Started':
          logger.info(`Downloading ${event.data.contentLength} bytes`)
          break
        case 'Progress':
          logger.info(`Downloaded: ${event.data.chunkLength} bytes`)
          break
        case 'Finished':
          logger.info('Download complete')
          break
      }
    })

    pendingUpdate = update
    setUpdateReady(true, update.version)
    if (notifyOnReady) {
      toast(`Update ready: ${update.version}. Click to restart.`)
    }
  } catch (error) {
    logger.error('Update check failed:', { error: String(error) })
    useUIStore.getState().setUpdateDownloading(false)
    pendingUpdate = null
    if (notifyOnError) {
      toast.error('Failed to check for updates')
    }
  } finally {
    checkInFlight = false
  }
}

export async function installUpdate() {
  const { updateReady, setUpdateReady } = useUIStore.getState()
  if (!updateReady || !pendingUpdate) return

  try {
    await pendingUpdate.install()
    pendingUpdate = null
    setUpdateReady(false)
    await relaunch()
  } catch (error) {
    logger.error('Update install failed:', { error: String(error) })
    toast.error('Failed to install update')
  }
}
