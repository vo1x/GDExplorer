export function extractDriveFolderId(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.hostname !== 'drive.google.com') return null

  if (/^\/file\/d\/[A-Za-z0-9_-]+/.test(url.pathname)) return null

  const foldersMatch = url.pathname.match(
    /^\/drive(?:\/u\/\d+)?\/folders\/([A-Za-z0-9_-]+)(?:\/)?$/
  )
  if (foldersMatch?.[1]) return foldersMatch[1]

  if (url.pathname === '/open') {
    const id = url.searchParams.get('id')
    if (id && /^[A-Za-z0-9_-]+$/.test(id)) return id
  }

  return null
}

