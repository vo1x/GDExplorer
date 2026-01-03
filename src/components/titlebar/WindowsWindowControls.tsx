import { useEffect, useState, type HTMLProps } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Minus, Square, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface WindowsWindowControlsProps extends HTMLProps<HTMLDivElement> {
  className?: string
}

export function WindowsWindowControls({
  className,
  ...props
}: WindowsWindowControlsProps) {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    const appWindow = getCurrentWindow()
    appWindow.isMaximized().then(setIsMaximized).catch(() => {})

    const unlisten = appWindow.onResized(() => {
      appWindow.isMaximized().then(setIsMaximized).catch(() => {})
    })

    return () => {
      unlisten.then(stop => stop()).catch(() => {})
    }
  }, [])

  const handleMinimize = async () => {
    await getCurrentWindow().minimize()
  }

  const handleMaximize = async () => {
    await getCurrentWindow().toggleMaximize()
  }

  const handleClose = async () => {
    await getCurrentWindow().close()
  }

  return (
    <div
      className={cn('flex items-center text-foreground', className)}
      {...props}
    >
      <button
        type="button"
        onClick={handleMinimize}
        className="flex h-8 w-10 items-center justify-center hover:bg-muted"
        title="Minimize"
      >
        <Minus className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={handleMaximize}
        className="flex h-8 w-10 items-center justify-center hover:bg-muted"
        title={isMaximized ? 'Restore' : 'Maximize'}
      >
        <Square className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={handleClose}
        className="flex h-8 w-10 items-center justify-center hover:bg-destructive hover:text-destructive-foreground"
        title="Close"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

export default WindowsWindowControls
