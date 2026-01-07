import { describe, it, expect, beforeEach } from 'vitest'
import { useLocalUploadQueue } from './local-upload-queue-store'

describe('localUploadQueue', () => {
  beforeEach(() => {
    useLocalUploadQueue.setState({ items: [] })
  })

  it('adds files and folders', () => {
    useLocalUploadQueue.getState().addFiles(['/tmp/a.txt'])
    useLocalUploadQueue.getState().addFolders(['/tmp/folder'])

    const items = useLocalUploadQueue.getState().items
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      path: '/tmp/a.txt',
      kind: 'file',
    })
    expect(items[0]).toBeDefined()
    expect(items[0]!.id).toEqual(expect.any(String))
    expect(items[1]).toMatchObject({
      path: '/tmp/folder',
      kind: 'folder',
    })
    expect(items[1]).toBeDefined()
    expect(items[1]!.id).toEqual(expect.any(String))
  })

  it('deduplicates by path', () => {
    useLocalUploadQueue.getState().addFiles(['/tmp/a.txt', '/tmp/a.txt'])
    useLocalUploadQueue.getState().addFolders(['/tmp/a.txt'])
    expect(useLocalUploadQueue.getState().items).toHaveLength(1)
  })

  it('preserves insertion order with mixed items', () => {
    useLocalUploadQueue.getState().addItems([
      { path: '/tmp/1', kind: 'folder' },
      { path: '/tmp/2.txt', kind: 'file' },
    ])

    expect(useLocalUploadQueue.getState().items.map(i => i.path)).toEqual([
      '/tmp/1',
      '/tmp/2.txt',
    ])
  })

  it('removes items by path', () => {
    useLocalUploadQueue.getState().addFiles(['/tmp/a.txt', '/tmp/b.txt'])
    useLocalUploadQueue.getState().remove('/tmp/a.txt')
    expect(useLocalUploadQueue.getState().items.map(i => i.path)).toEqual([
      '/tmp/b.txt',
    ])
  })

  it('clears the queue', () => {
    useLocalUploadQueue.getState().addFolders(['/tmp/folder'])
    useLocalUploadQueue.getState().clear()
    expect(useLocalUploadQueue.getState().items).toEqual([])
  })
})
