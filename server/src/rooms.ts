// Loads rooms on demand, saves them shortly after each change, and evicts
// them from memory once the last collaborator leaves.
import type { WebSocket } from 'ws'
import { MAIN_FILE } from '../../shared/project.ts'
import { Room } from './room.ts'
import type { DocStore } from './store.ts'
import { STARTER_DOCUMENT } from './template.ts'

export interface RoomManagerOptions {
  saveDebounceMs?: number
  /** Called after every change to a room's document. */
  onChange?: (room: Room) => void
  /** Called when a socket joins a room. */
  onJoin?: (room: Room) => void
  /** Called after a room has been saved and dropped from memory. */
  onEvict?: (id: string) => void
}

export class RoomManager {
  private readonly store: DocStore
  private readonly options: RoomManagerOptions
  private readonly saveDebounceMs: number
  private readonly rooms = new Map<string, Promise<Room>>()
  private readonly saveTimers = new Map<Room, NodeJS.Timeout>()

  constructor(store: DocStore, options: RoomManagerOptions = {}) {
    this.store = store
    this.options = options
    this.saveDebounceMs = options.saveDebounceMs ?? 500
  }

  /** Attaches a socket to the room for `id`, loading the room if needed. */
  async join(id: string, ws: WebSocket): Promise<void> {
    // The client starts talking the moment the socket opens, but loading the
    // room from disk takes a little while. Hold incoming frames until the room
    // is listening; otherwise the client's opening sync message is dropped and
    // it never receives the document.
    ws.pause()
    try {
      for (;;) {
        const room = await this.get(id)
        // The room may have been evicted while we were awaiting; fetch a fresh one.
        if (room.closed) continue
        if (ws.readyState !== ws.OPEN) {
          // The client hung up while we were loading. Don't strand the room.
          if (room.size === 0) void this.evict(room)
          return
        }
        room.connect(ws)
        this.options.onJoin?.(room)
        return
      }
    } finally {
      ws.resume()
    }
  }

  get(id: string): Promise<Room> {
    let room = this.rooms.get(id)
    if (!room) {
      room = this.open(id)
      this.rooms.set(id, room)
      room.catch(() => this.rooms.delete(id)) // allow a retry after a failed load
    }
    return room
  }

  /**
   * Runs `use` with the room for `id`, loading it if needed. For work that is
   * not tied to a socket (uploads, compiles): the room is released again
   * afterwards if nobody is connected.
   */
  async withRoom<T>(id: string, use: (room: Room) => T | Promise<T>): Promise<T> {
    for (;;) {
      const room = await this.get(id)
      if (room.closed) continue
      try {
        return await use(room)
      } finally {
        if (room.size === 0) void this.evict(room)
      }
    }
  }

  isLoaded(id: string): boolean {
    return this.rooms.has(id)
  }

  /** Saves every loaded room and releases them. */
  async close(): Promise<void> {
    const rooms = await Promise.allSettled([...this.rooms.values()])
    this.rooms.clear()
    await Promise.all(
      rooms.map(async (result) => {
        if (result.status !== 'fulfilled') return
        const room = result.value
        await this.flush(room)
        room.close()
      }),
    )
    // A socket closing during shutdown can queue one more save through the
    // eviction path; wait for it so nothing writes after close() returns.
    await this.store.idle()
  }

  private async open(id: string): Promise<Room> {
    const saved = await this.store.load(id)
    const room = new Room(id, saved)
    // Seed brand-new documents on the server, exactly once. If clients seeded
    // them instead, two people opening a new link together would each insert
    // the template and the merged document would contain it twice.
    if (saved) room.migrateLegacyText()
    else room.setTextFile(MAIN_FILE, STARTER_DOCUMENT)

    room.onChange(() => {
      this.scheduleSave(room)
      this.options.onChange?.(room)
    })
    room.onEmpty(() => void this.evict(room))
    return room
  }

  private scheduleSave(room: Room): void {
    clearTimeout(this.saveTimers.get(room))
    this.saveTimers.set(
      room,
      setTimeout(() => {
        this.flush(room).catch((err) => console.error(`[room ${room.id}] save failed:`, err))
      }, this.saveDebounceMs),
    )
  }

  private async flush(room: Room): Promise<void> {
    clearTimeout(this.saveTimers.get(room))
    this.saveTimers.delete(room)
    if (room.closed) return
    await this.store.save(room.id, room.encodeState())
  }

  private async evict(room: Room): Promise<void> {
    try {
      await this.flush(room)
    } catch (err) {
      // Keep the room in memory rather than lose edits we could not save.
      console.error(`[room ${room.id}] save failed, keeping room in memory:`, err)
      return
    }
    // Someone may have joined, or typed, while we were saving.
    if (room.closed || room.size > 0 || this.saveTimers.has(room)) return
    this.rooms.delete(room.id)
    room.close()
    this.options.onEvict?.(room.id)
  }
}
