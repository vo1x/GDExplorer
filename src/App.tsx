import { useEffect, useRef, useState } from 'react'
import { logger } from './lib/logger'
import { cleanupOldFiles } from './lib/recovery'
import { checkForUpdates } from './lib/updater'
import './App.css'
import MainWindow from './components/layout/MainWindow'
import { ThemeProvider } from './components/ThemeProvider'
import ErrorBoundary from './components/ErrorBoundary'
import { usePreferences } from './services/preferences'
import { UpdateSplash } from './components/update/UpdateSplash'

function App() {
  const { data: preferences } = usePreferences()
  const [showUpdateSplash, setShowUpdateSplash] = useState(false)
  const hasCheckedUpdates = useRef(false)

  // Initialize command system and cleanup on app startup
  useEffect(() => {
    logger.info('🚀 Frontend application starting up')

    // Clean up old recovery files on startup
    cleanupOldFiles().catch(error => {
      logger.warn('Failed to cleanup old recovery files', { error })
    })

    // Example of logging with context
    logger.info('App environment', {
      isDev: import.meta.env.DEV,
      mode: import.meta.env.MODE,
    })

  }, [])

  useEffect(() => {
    if (!preferences) return
    if (!preferences.autoCheckUpdates) return
    if (hasCheckedUpdates.current) return
    hasCheckedUpdates.current = true

    setShowUpdateSplash(true)
    checkForUpdates({
      notifyIfLatest: false,
      notifyOnError: false,
      notifyOnReady: false,
    })
      .catch(() => {})
      .finally(() => {
        setShowUpdateSplash(false)
      })
  }, [preferences])

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <MainWindow />
        <UpdateSplash visible={showUpdateSplash} />
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
