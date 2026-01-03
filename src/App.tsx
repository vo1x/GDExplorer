import { useEffect } from 'react'
import { logger } from './lib/logger'
import { cleanupOldFiles } from './lib/recovery'
import { checkForUpdates } from './lib/updater'
import './App.css'
import MainWindow from './components/layout/MainWindow'
import { ThemeProvider } from './components/ThemeProvider'
import ErrorBoundary from './components/ErrorBoundary'

function App() {
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

    // Auto-updater logic - check for updates 5 seconds after app loads
    // Check for updates 5 seconds after app loads
    const updateTimer = setTimeout(() => {
      checkForUpdates()
    }, 5000)
    return () => clearTimeout(updateTimer)
  }, [])

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <MainWindow />
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
