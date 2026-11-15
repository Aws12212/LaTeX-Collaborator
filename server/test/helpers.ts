import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { ASSETS_KEY, type AssetInfo, FILES_KEY, MAIN_FILE } from '../../shared/project.ts'
import type { ProjectSnapshot } from '../src/latex.ts'

export interface TestClient {
  doc: Y.Doc
  /** The shared text of main.tex. Only available once the client has synced. */
  readonly text: Y.Text
  files: Y.Map<Y.Text>
  assets: Y.Map<AssetInfo>
  provider: WebsocketProvider
  close(): void
}

/** A project with the given main.tex and nothing else. */
export function projectOf(main: string, extra: Record<string, string> = {}): ProjectSnapshot {
  return { texts: new Map([[MAIN_FILE, main], ...Object.entries(extra)]), assets: [] }
}

/** A real client, speaking the same protocol the browser does. */
export function connect(port: number, docId: string): TestClient {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/ws`, docId, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  })
  const files = doc.getMap<Y.Text>(FILES_KEY)
  return {
    doc,
    get text() {
      const text = files.get(MAIN_FILE)
      if (!text) throw new Error('main.tex is not there yet; wait for the client to sync')
      return text
    },
    files,
    assets: doc.getMap<AssetInfo>(ASSETS_KEY),
    provider,
    close() {
      provider.destroy()
      doc.destroy()
    },
  }
}

export async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export function synced(client: TestClient): Promise<void> {
  return waitFor(() => client.provider.synced, 'initial sync')
}

export async function tempDir(): Promise<{ dir: string; remove(): Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'collab-tex-test-'))
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) }
}
