import { cn } from '@/lib/utils'
import { BrowseLocalFiles } from '@/components/upload/BrowseLocalFiles'

interface MainWindowContentProps {
  children?: React.ReactNode
  className?: string
}

export function MainWindowContent({
  children,
  className,
}: MainWindowContentProps) {
  return (
    <div className={cn('flex h-full flex-col bg-background', className)}>
      {children || <BrowseLocalFiles />}
    </div>
  )
}

export default MainWindowContent
