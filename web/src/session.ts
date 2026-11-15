// One editing session: the local replica of the project plus its live
// connection to the server.
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import {
  ASSETS_KEY,
  type AssetInfo,
  type FileKind,
  fileKind,
  FILES_KEY,
  isValidPath,
  MAIN_FILE,
} from '../../shared/project.ts'
import type { Identity } from './identity'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

export interface Peer {
  clientId: number
  name: string
  color: string
  isSelf: boolean
}

export interface ProjectFile {
  path: string
  kind: FileKind
}

export interface Session {
  docId: string
  provider: WebsocketProvider
  /** Every file in the project, main.tex first. */
  listFiles(): ProjectFile[]
  /** The shared text of a file, or null if there is no such text file. */
  getText(path: string): Y.Text | null
  /** Creates a text file, or replaces the contents of an existing one. */
  writeTextFile(path: string, content: string): void
  uploadAsset(path: string, data: Blob): Promise<void>
  deleteFile(file: ProjectFile): Promise<void>
  /** Calls `listener` whenever files are added or removed. Returns an unsubscribe function. */
  onFilesChange(listener: () => void): () => void
  setUser(identity: Identity): void
  peers(): Peer[]
  destroy(): void
}

async function expectOk(response: Response): Promise<void> {
  if (response.ok) return
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  throw new Error(body?.error ?? `Request failed (${response.status})`)
}

export function openSession(docId: string): Session {
  const ydoc = new Y.Doc()
  const files = ydoc.getMap<Y.Text>(FILES_KEY)
  const assets = ydoc.getMap<AssetInfo>(ASSETS_KEY)
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const provider = new WebsocketProvider(`${scheme}://${location.host}/ws`, docId, ydoc, {
    // Tabs in one browser could also sync directly with each other; turn that
    // off so every edit takes the same path, through the server.
    disableBc: true,
  })
  const assetUrl = (path: string) =>
    `/api/docs/${docId}/assets/${path.split('/').map(encodeURIComponent).join('/')}`

  return {
    docId,
    provider,
    listFiles() {
      const list: ProjectFile[] = []
      files.forEach((value, path) => {
        if (value instanceof Y.Text && isValidPath(path) && fileKind(path) === 'text') {
          list.push({ path, kind: 'text' })
        }
      })
      assets.forEach((_info, path) => {
        if (isValidPath(path) && fileKind(path) === 'asset') list.push({ path, kind: 'asset' })
      })
      return list.sort(
        (a, b) =>
          Number(b.path === MAIN_FILE) - Number(a.path === MAIN_FILE) || a.path.localeCompare(b.path),
      )
    },
    getText(path) {
      const text = files.get(path)
      return text instanceof Y.Text ? text : null
    },
    writeTextFile(path, content) {
      const existing = files.get(path)
      if (existing instanceof Y.Text) {
        // Edit in place so collaborators who have the file open stay attached.
        ydoc.transact(() => {
          existing.delete(0, existing.length)
          existing.insert(0, content)
        })
      } else {
        files.set(path, new Y.Text(content))
      }
    },
    async uploadAsset(path, data) {
      // The server stores the bytes and then lists the file in the shared
      // document itself, so it appears for everyone once this resolves.
      await expectOk(await fetch(assetUrl(path), { method: 'PUT', body: data }))
    },
    async deleteFile(file) {
      if (file.kind === 'text') files.delete(file.path)
      else await expectOk(await fetch(assetUrl(file.path), { method: 'DELETE' }))
    },
    onFilesChange(listener) {
      files.observe(listener)
      assets.observe(listener)
      return () => {
        files.unobserve(listener)
        assets.unobserve(listener)
      }
    },
    setUser(identity) {
      provider.awareness.setLocalStateField('user', {
        name: identity.name,
        color: identity.color,
        colorLight: `${identity.color}33`,
      })
    },
    peers() {
      const peers: Peer[] = []
      for (const [clientId, state] of provider.awareness.getStates()) {
        const user = state.user as { name?: unknown; color?: unknown } | undefined
        if (!user) continue
        peers.push({
          clientId,
          name: typeof user.name === 'string' && user.name ? user.name : 'Anonymous',
          color: typeof user.color === 'string' ? user.color : '#888888',
          isSelf: clientId === ydoc.clientID,
        })
      }
      // Yourself first, then a stable order.
      return peers.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.clientId - b.clientId)
    },
    destroy() {
      provider.destroy()
      ydoc.destroy()
    },
  }
}
