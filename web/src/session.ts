// One editing session: the local replica of the document plus its live
// connection to the server.
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import type { Identity } from './identity'

/** Must match TEXT_KEY in server/src/room.ts. */
const TEXT_KEY = 'main'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

export interface Peer {
  clientId: number
  name: string
  color: string
  isSelf: boolean
}

export interface Session {
  docId: string
  ytext: Y.Text
  provider: WebsocketProvider
  undoManager: Y.UndoManager
  setUser(identity: Identity): void
  peers(): Peer[]
  destroy(): void
}

export function openSession(docId: string): Session {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText(TEXT_KEY)
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const provider = new WebsocketProvider(`${scheme}://${location.host}/ws`, docId, ydoc, {
    // Tabs in one browser could also sync directly with each other; turn that
    // off so every edit takes the same path, through the server.
    disableBc: true,
  })
  // Undo only your own edits, never a collaborator's.
  const undoManager = new Y.UndoManager(ytext)

  return {
    docId,
    ytext,
    provider,
    undoManager,
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
      undoManager.destroy()
      provider.destroy()
      ydoc.destroy()
    },
  }
}
