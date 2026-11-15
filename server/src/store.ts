// Document persistence: one file per document holding the full CRDT state.
// Writes go to a temp file first and are renamed into place, so a crash
// mid-write can never leave a truncated document behind.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export class DocStore {
  private readonly dir: string
  // Per-document promise chain so two saves of the same doc never interleave.
  private readonly pending = new Map<string, Promise<void>>()

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'docs')
  }

  async load(id: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.file(id))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  save(id: string, state: Uint8Array): Promise<void> {
    const previous = this.pending.get(id) ?? Promise.resolve()
    const next = previous
      .catch(() => {}) // a failed earlier save must not block later ones
      .then(() => this.write(id, state))
    this.pending.set(id, next)
    void next.finally(() => {
      if (this.pending.get(id) === next) this.pending.delete(id)
    })
    return next
  }

  /** Resolves once every save that has been requested so far has finished. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending.values()])
    }
  }

  private async write(id: string, state: Uint8Array): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const file = this.file(id)
    const tmp = `${file}.tmp`
    await writeFile(tmp, state)
    await rename(tmp, file)
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.ydoc`)
  }
}
