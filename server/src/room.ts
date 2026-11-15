// One Room per document: the server's copy of the CRDT, the presence
// ("awareness") state, and the set of connected sockets.
//
// Wire protocol (same framing the y-websocket client speaks):
//   [varuint messageType][payload]
//   0 = sync       (state-vector exchange, then incremental updates)
//   1 = awareness  (cursors, names; ephemeral, never persisted)
//   3 = query awareness
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import type { RawData, WebSocket } from 'ws'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_QUERY_AWARENESS = 3

/** Name of the shared text inside the Y.Doc. The web client must use the same key. */
export const TEXT_KEY = 'main'

interface AwarenessChange {
  added: number[]
  updated: number[]
  removed: number[]
}

function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return data
}

export class Room {
  readonly id: string
  readonly doc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness
  /** Set once the room has been evicted; a closed room must not accept sockets. */
  closed = false

  // Each socket maps to the awareness client ids it introduced, so we can
  // remove that user's cursor when the socket drops.
  private readonly conns = new Map<WebSocket, Set<number>>()
  private readonly changeListeners = new Set<() => void>()
  private readonly emptyListeners = new Set<() => void>()

  constructor(id: string, savedState?: Uint8Array | null) {
    this.id = id
    this.doc = new Y.Doc()
    if (savedState) Y.applyUpdate(this.doc, savedState)

    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.awareness.setLocalState(null) // the server is not a participant

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      // The sender already has this update, so skip it.
      this.broadcast(encoding.toUint8Array(encoder), origin)
      for (const listener of this.changeListeners) listener()
    })

    this.awareness.on('update', ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
      const controlled = this.conns.get(origin as WebSocket)
      if (controlled) {
        for (const clientId of added) controlled.add(clientId)
        for (const clientId of removed) controlled.delete(clientId)
      }
      const changed = [...added, ...updated, ...removed]
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
      )
      this.broadcast(encoding.toUint8Array(encoder))
    })
  }

  get size(): number {
    return this.conns.size
  }

  get text(): string {
    return this.doc.getText(TEXT_KEY).toString()
  }

  /** Full document state, suitable for persisting and for `new Room(id, state)`. */
  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc)
  }

  onChange(listener: () => void): void {
    this.changeListeners.add(listener)
  }

  onEmpty(listener: () => void): void {
    this.emptyListeners.add(listener)
  }

  connect(ws: WebSocket): void {
    if (this.closed) throw new Error(`room ${this.id} is closed`)
    this.conns.set(ws, new Set())

    ws.on('message', (data) => {
      try {
        this.handleMessage(ws, toUint8Array(data))
      } catch (err) {
        // A malformed frame means a broken or hostile client: drop it.
        console.warn(`[room ${this.id}] bad message, closing socket:`, err)
        this.disconnect(ws)
      }
    })
    ws.on('close', () => this.disconnect(ws))
    ws.on('error', () => this.disconnect(ws))

    // Sync step 1: tell the client what we have; it replies with what we lack,
    // and sends its own step 1 so we can do the same for it.
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, this.doc)
    this.send(ws, encoding.toUint8Array(encoder))

    const states = this.awareness.getStates()
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder()
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
      )
      this.send(ws, encoding.toUint8Array(awarenessEncoder))
    }
  }

  /** Drops every socket and releases the document. */
  close(): void {
    this.closed = true
    for (const ws of [...this.conns.keys()]) this.disconnect(ws)
    this.changeListeners.clear()
    this.emptyListeners.clear()
    this.awareness.destroy()
    this.doc.destroy()
  }

  private handleMessage(ws: WebSocket, message: Uint8Array): void {
    const decoder = decoding.createDecoder(message)
    const messageType = decoding.readVarUint(decoder)
    switch (messageType) {
      case MESSAGE_SYNC: {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        // Applies the client's step 2 / update to our doc (with `ws` as the
        // transaction origin) or writes our reply to its step 1.
        syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws)
        // Length 1 means only the message type was written, i.e. no reply.
        if (encoding.length(encoder) > 1) this.send(ws, encoding.toUint8Array(encoder))
        break
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          ws,
        )
        break
      }
      case MESSAGE_QUERY_AWARENESS: {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
            ...this.awareness.getStates().keys(),
          ]),
        )
        this.send(ws, encoding.toUint8Array(encoder))
        break
      }
      default:
        throw new Error(`unknown message type ${messageType}`)
    }
  }

  private send(ws: WebSocket, message: Uint8Array): void {
    if (ws.readyState !== ws.OPEN) return
    ws.send(message, { binary: true }, (err) => {
      if (err) this.disconnect(ws)
    })
  }

  private broadcast(message: Uint8Array, except?: unknown): void {
    for (const ws of this.conns.keys()) {
      if (ws !== except) this.send(ws, message)
    }
  }

  private disconnect(ws: WebSocket): void {
    const controlled = this.conns.get(ws)
    if (!controlled) return // already disconnected
    this.conns.delete(ws)
    if (!this.closed) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [...controlled], null)
    }
    ws.close()
    if (this.conns.size === 0) {
      for (const listener of this.emptyListeners) listener()
    }
  }
}
