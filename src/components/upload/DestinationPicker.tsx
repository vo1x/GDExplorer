import { useMemo } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useUploadDestinationStore } from '@/store/upload-destination-store'
import { usePreferences } from '@/services/preferences'

export function DestinationPicker() {
  const {
    destinationUrl,
    destinationError,
    destinationFolderId,
    setDestinationUrl,
  } = useUploadDestinationStore()
  const { data: preferences } = usePreferences()

  const destinationPresets = useMemo(
    () => preferences?.destinationPresets ?? [],
    [preferences?.destinationPresets]
  )

  const selectedPresetId = useMemo(() => {
    const url = destinationUrl.trim()
    if (!url) return 'custom'
    const match = destinationPresets.find(p => p.url.trim() === url)
    return match ? match.id : 'custom'
  }, [destinationPresets, destinationUrl])

  return (
    <section className="space-y-2">
      <Label htmlFor="destination-url">Destination folder URL</Label>

      {destinationPresets.length > 0 ? (
        <div className="space-y-2">
          <Select
            value={selectedPresetId}
            onValueChange={value => {
              if (value === 'custom') return
              const preset = destinationPresets.find(p => p.id === value)
              if (preset) setDestinationUrl(preset.url)
            }}
          >
            <SelectTrigger size="sm">
              <SelectValue placeholder="Custom" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="custom">Custom</SelectItem>
              {destinationPresets.map(p => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="text-xs text-muted-foreground">
            Select a saved destination or enter a custom URL.
          </div>
        </div>
      ) : null}

      <Input
        id="destination-url"
        value={destinationUrl}
        onChange={e => setDestinationUrl(e.target.value)}
        placeholder="https://drive.google.com/drive/folders/<FOLDER_ID>"
        aria-invalid={Boolean(destinationError)}
        className={
          destinationError
            ? 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20'
            : destinationFolderId
              ? 'border-emerald-600 focus-visible:border-emerald-600 focus-visible:ring-emerald-600/25'
              : undefined
        }
      />

      {destinationError ? (
        <p className="text-sm text-destructive">
          Please enter a Google Drive <em>folder</em> URL.
        </p>
      ) : destinationFolderId ? (
        <p className="text-sm text-emerald-700 dark:text-emerald-400">
          Folder ID: <span className="font-mono">{destinationFolderId}</span>
        </p>
      ) : null}
    </section>
  )
}
