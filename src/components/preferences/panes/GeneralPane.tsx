import React, { useEffect, useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { usePreferences, useSavePreferences } from '@/services/preferences'

const SettingsField: React.FC<{
  label: string
  children: React.ReactNode
  description?: string
}> = ({ label, children, description }) => (
  <div className="space-y-2">
    <Label className="text-sm font-medium text-foreground">{label}</Label>
    {children}
    {description && (
      <p className="text-sm text-muted-foreground">{description}</p>
    )}
  </div>
)

const SettingsSection: React.FC<{
  title: string
  children: React.ReactNode
}> = ({ title, children }) => (
  <div className="space-y-4">
    <div>
      <h3 className="text-lg font-medium text-foreground">{title}</h3>
      <Separator className="mt-2" />
    </div>
    <div className="space-y-4">{children}</div>
  </div>
)

export const GeneralPane: React.FC = () => {
  const { data: preferences } = usePreferences()
  const savePreferences = useSavePreferences()

  const [serviceAccountFolder, setServiceAccountFolder] = useState<string>('')
  const [lastSavedServiceAccountFolder, setLastSavedServiceAccountFolder] =
    useState<string>('')
  const [maxConcurrentInput, setMaxConcurrentInput] = useState<string>('3')
  const [lastSavedMaxConcurrent, setLastSavedMaxConcurrent] = useState(3)

  useEffect(() => {
    if (!preferences) return
    const folder = preferences.serviceAccountFolderPath ?? ''
    setServiceAccountFolder(folder)
    setLastSavedServiceAccountFolder(folder)
    setMaxConcurrentInput(String(preferences.maxConcurrentUploads ?? 3))
    setLastSavedMaxConcurrent(preferences.maxConcurrentUploads ?? 3)
  }, [preferences])

  const maxConcurrentError = useMemo(() => {
    const trimmed = maxConcurrentInput.trim()
    if (!trimmed) return 'Please enter a number between 1 and 10.'
    if (!/^\d+$/.test(trimmed)) return 'Must be an integer between 1 and 10.'
    const parsed = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10) {
      return 'Must be an integer between 1 and 10.'
    }
    return null
  }, [maxConcurrentInput])

  const handleBrowseServiceAccountsFolder = async () => {
    const selection = await open({
      directory: true,
      multiple: false,
      title: 'Select service account credentials folder',
    })
    if (!selection) return

    const folderPath = Array.isArray(selection) ? selection[0] : selection
    if (!folderPath) return

    try {
      await savePreferences.mutateAsync({ serviceAccountFolderPath: folderPath })
      setServiceAccountFolder(folderPath)
      setLastSavedServiceAccountFolder(folderPath)
    } catch {
      setServiceAccountFolder(lastSavedServiceAccountFolder)
    }
  }

  const handleSaveMaxConcurrent = () => {
    if (maxConcurrentError) return
    const value = Number.parseInt(maxConcurrentInput.trim(), 10)
    savePreferences
      .mutateAsync({ maxConcurrentUploads: value })
      .then(() => {
        setLastSavedMaxConcurrent(value)
      })
      .catch(() => {
        setMaxConcurrentInput(String(lastSavedMaxConcurrent))
      })
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="Uploads">
        <SettingsField
          label="Service Account credentials folder (.json)"
          description="Select a folder containing one or more service account JSON files."
        >
          <div className="flex items-center gap-2">
            <Input
              value={serviceAccountFolder}
              placeholder="No folder selected"
              readOnly
            />
            <Button
              type="button"
              onClick={handleBrowseServiceAccountsFolder}
              disabled={savePreferences.isPending}
            >
              Browse…
            </Button>
          </div>
        </SettingsField>

        <SettingsField
          label="Maximum concurrent uploads"
          description="Controls how many uploads can run at the same time."
        >
          <div className="space-y-2">
            <Input
              inputMode="numeric"
              value={maxConcurrentInput}
              onChange={e => setMaxConcurrentInput(e.target.value)}
              onBlur={handleSaveMaxConcurrent}
              aria-invalid={Boolean(maxConcurrentError)}
            />
            {maxConcurrentError ? (
              <p className="text-sm text-destructive">{maxConcurrentError}</p>
            ) : null}
          </div>
        </SettingsField>
      </SettingsSection>
    </div>
  )
}
