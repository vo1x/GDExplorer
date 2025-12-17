import { cn } from '@/lib/utils'
import { BrowseLocalFiles } from '@/components/upload/BrowseLocalFiles'
import { LeftSideBar } from '@/components/layout/LeftSideBar'
import { DestinationPicker } from '@/components/upload/DestinationPicker'
import { useUIStore } from '@/store/ui-store'

interface MainWindowContentProps {
  children?: React.ReactNode
  className?: string
}

export function MainWindowContent({
  children,
  className,
}: MainWindowContentProps) {
  const leftSidebarVisible = useUIStore(s => s.leftSidebarVisible)

  if (children) {
    return (
      <div className={cn('flex h-full flex-col bg-background', className)}>
        {children}
      </div>
    )
  }

  return (
    <div className={cn('flex h-full w-full bg-background', className)}>
      {leftSidebarVisible ? (
        <LeftSideBar className="w-[360px] shrink-0 p-4">
          <DestinationPicker />
        </LeftSideBar>
      ) : null}
      <div className="min-w-0 flex-1">
        <BrowseLocalFiles />
      </div>
    </div>
  )
}

export default MainWindowContent
