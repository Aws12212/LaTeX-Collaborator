// Uploaded figures (PDF, PNG, JPEG). These are binary and not edited
// collaboratively, so they live on disk rather than inside the CRDT.
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  fileKind,
  isValidPath,
  MAX_FILES,
  MAX_PROJECT_ASSET_BYTES,
} from '../../shared/project.ts'

export interface AssetEntry {
  /** Project path, e.g. "figures/disks.pdf". */
  path: string
  size: number
  mtimeMs: number
  /** Absolute location on the server's disk. */
  file: string
}

export class AssetLimitError extends Error {}

export class AssetStore {
  private readonly root: string

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'assets')
  }

  async list(docId: string): Promise<AssetEntry[]> {
    const dir = path.join(this.root, docId)
    let entries
    try {
      entries = await readdir(dir, { recursive: true, withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const assets: AssetEntry[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const file = path.join(entry.parentPath, entry.name)
      const projectPath = path.relative(dir, file).split(path.sep).join('/')
      // Skips temp files from in-progress uploads and anything unexpected.
      if (!isValidPath(projectPath) || fileKind(projectPath) !== 'asset') continue
      const info = await stat(file)
      assets.push({ path: projectPath, size: info.size, mtimeMs: info.mtimeMs, file })
    }
    return assets.sort((a, b) => a.path.localeCompare(b.path))
  }

  async put(docId: string, projectPath: string, data: Buffer): Promise<AssetEntry> {
    const file = this.resolve(docId, projectPath)
    const others = (await this.list(docId)).filter((asset) => asset.path !== projectPath)
    if (others.length + 1 > MAX_FILES) {
      throw new AssetLimitError(`A project can hold at most ${MAX_FILES} uploaded files`)
    }
    const total = others.reduce((sum, asset) => sum + asset.size, 0) + data.length
    if (total > MAX_PROJECT_ASSET_BYTES) {
      const limitMb = Math.round(MAX_PROJECT_ASSET_BYTES / 1024 / 1024)
      throw new AssetLimitError(`Uploads in one project are limited to ${limitMb} MB in total`)
    }

    await mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await writeFile(tmp, data)
    await rename(tmp, file)
    const info = await stat(file)
    return { path: projectPath, size: info.size, mtimeMs: info.mtimeMs, file }
  }

  /** Returns false if there was nothing to delete. */
  async delete(docId: string, projectPath: string): Promise<boolean> {
    const file = this.resolve(docId, projectPath)
    try {
      await stat(file)
    } catch {
      return false
    }
    await rm(file, { force: true })
    return true
  }

  private resolve(docId: string, projectPath: string): string {
    // Callers validate first; check again here because this is the last stop
    // before a client-supplied name becomes a location on disk.
    if (!isValidPath(projectPath) || fileKind(projectPath) !== 'asset') {
      throw new Error(`invalid asset path: ${projectPath}`)
    }
    return path.join(this.root, docId, ...projectPath.split('/'))
  }
}
