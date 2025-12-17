import React, { useEffect, useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { usePreferences, useSavePreferences } from '@/services/preferences'
import type { DestinationPreset } from '@/types/preferences'
import { extractDriveFolderId } from '@/lib/drive-url'

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

  const [destinationPresetsDraft, setDestinationPresetsDraft] = useState<
    DestinationPreset[]
  >([])
  const [newPresetName, setNewPresetName] = useState('')
  const [newPresetUrl, setNewPresetUrl] = useState('')

  useEffect(() => {
    if (!preferences) return
    const folder = preferences.serviceAccountFolderPath ?? ''
    setServiceAccountFolder(folder)
    setLastSavedServiceAccountFolder(folder)
    setMaxConcurrentInput(String(preferences.maxConcurrentUploads ?? 3))
    setLastSavedMaxConcurrent(preferences.maxConcurrentUploads ?? 3)
    setDestinationPresetsDraft(preferences.destinationPresets ?? [])
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

  const presetErrors = useMemo(() => {
    const byId: Record<string, string | null> = {}
    for (const preset of destinationPresetsDraft) {
      if (!preset.name.trim()) {
        byId[preset.id] = 'Name is required.'
        continue
      }
      const folderId = extractDriveFolderId(preset.url)
      if (!folderId) {
        byId[preset.id] = 'Please enter a Google Drive folder URL.'
        continue
      }
      byId[preset.id] = null
    }
    return byId
  }, [destinationPresetsDraft])

  const newPresetError = useMemo(() => {
    if (!newPresetName.trim() && !newPresetUrl.trim()) return null
    if (!newPresetName.trim()) return 'Name is required.'
    if (!extractDriveFolderId(newPresetUrl)) {
      return 'Please enter a Google Drive folder URL.'
    }
    return null
  }, [newPresetName, newPresetUrl])

  const handleSaveDestinationPresets = async () => {
    const hasErrors = destinationPresetsDraft.some(
      p => presetErrors[p.id] !== null
    )
    if (hasErrors) return

    const uniqueByUrl = new Set<string>()
    const deduped: DestinationPreset[] = []
    for (const p of destinationPresetsDraft) {
      const url = p.url.trim()
      if (uniqueByUrl.has(url)) continue
      uniqueByUrl.add(url)
      deduped.push({ ...p, name: p.name.trim(), url })
    }

    try {
      await savePreferences.mutateAsync({ destinationPresets: deduped })
      setDestinationPresetsDraft(deduped)
    } catch {
      // Reset to last saved value (from query cache)
      setDestinationPresetsDraft(preferences?.destinationPresets ?? [])
    }
  }

  const addPreset = () => {
    if (newPresetError) return
    const url = newPresetUrl.trim()
    const name = newPresetName.trim()
    const preset: DestinationPreset = {
      id: generateId(),
      name,
      url,
    }
    setDestinationPresetsDraft(curr => [preset, ...curr])
    setNewPresetName('')
    setNewPresetUrl('')
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

        <SettingsField
          label="Destination presets"
          description="Save commonly used Google Drive folder URLs to quickly select them later."
        >
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-[160px_1fr_auto]">
              <Input
                value={newPresetName}
                onChange={e => setNewPresetName(e.target.value)}
                placeholder="Name (e.g. Shared Drive)"
              />
              <Input
                value={newPresetUrl}
                onChange={e => setNewPresetUrl(e.target.value)}
                placeholder="https://drive.google.com/drive/folders/<FOLDER_ID>"
                aria-invalid={Boolean(newPresetError)}
              />
              <Button type="button" onClick={addPreset}>
                Add
              </Button>
            </div>
            {newPresetError ? (
              <p className="text-sm text-destructive">{newPresetError}</p>
            ) : null}

            <div className="space-y-2">
              {destinationPresetsDraft.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No presets yet.
                </p>
              ) : (
                destinationPresetsDraft.map(preset => (
                  <div
                    key={preset.id}
                    className="grid gap-2 sm:grid-cols-[160px_1fr_auto]"
                  >
                    <Input
                      value={preset.name}
                      onChange={e =>
                        setDestinationPresetsDraft(curr =>
                          curr.map(p =>
                            p.id === preset.id
                              ? { ...p, name: e.target.value }
                              : p
                          )
                        )
                      }
                    />
                    <Input
                      value={preset.url}
                      onChange={e =>
                        setDestinationPresetsDraft(curr =>
                          curr.map(p =>
                            p.id === preset.id
                              ? { ...p, url: e.target.value }
                              : p
                          )
                        )
                      }
                      aria-invalid={Boolean(presetErrors[preset.id])}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        setDestinationPresetsDraft(curr =>
                          curr.filter(p => p.id !== preset.id)
                        )
                      }
                    >
                      Remove
                    </Button>
                    {presetErrors[preset.id] ? (
                      <p className="text-sm text-destructive sm:col-span-3">
                        {presetErrors[preset.id]}
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                onClick={handleSaveDestinationPresets}
                disabled={savePreferences.isPending}
              >
                Save presets
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  setDestinationPresetsDraft(preferences?.destinationPresets ?? [])
                }
                disabled={savePreferences.isPending}
              >
                Reset
              </Button>
            </div>
          </div>
        </SettingsField>
      </SettingsSection>
    </div>
  )
}

function generateId(): string {
  return `preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
