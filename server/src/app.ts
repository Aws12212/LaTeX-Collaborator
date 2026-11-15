// HTTP + WebSocket front door.
//
//   WS   /ws/:docId                  real-time sync and presence
//   GET  /api/docs/:docId/events     compile status stream (Server-Sent Events)
//   GET  /api/docs/:docId/pdf        latest compiled PDF
//   POST /api/docs/:docId/compile    compile now instead of waiting for a pause
//   PUT  /api/docs/:docId/assets/*   upload a figure (PDF, PNG, JPEG)
//   DELETE /api/docs/:docId/assets/* remove a figure
//   GET  /api/health
//   GET  /*                          the built web app, when `staticDir` is set
import { readFile } from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import {
  fileKind,
  matchesFileType,
  MAX_ASSET_BYTES,
  normalizePath,
} from '../../shared/project.ts'
import { AssetLimitError, AssetStore } from './assets.ts'
import { Compiler, type CompilerOptions } from './compiler.ts'
import { detectLatex, type LatexEngine, type ProjectSnapshot } from './latex.ts'
import { RoomManager } from './rooms.ts'
import { DocStore } from './store.ts'

export interface ServerOptions {
  port?: number
  host?: string
  dataDir: string
  /** Directory holding the built web app; omit in development (Vite serves it). */
  staticDir?: string
  saveDebounceMs?: number
  compileDebounceMs?: number
  /** Override LaTeX detection: an engine, or null to disable compiling. */
  latex?: LatexEngine | null
  compile?: CompilerOptions['compile']
}

export interface RunningServer {
  port: number
  latexAvailable: boolean
  close(): Promise<void>
}

const DOC_ID = '[A-Za-z0-9_-]{1,64}'
const WS_ROUTE = new RegExp(`^/ws/(${DOC_ID})$`)
const API_ROUTE = new RegExp(`^/api/docs/(${DOC_ID})/(events|pdf|compile)$`)
const ASSET_ROUTE = new RegExp(`^/api/docs/(${DOC_ID})/assets/(.+)$`)
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024

/**
 * Reads a request body, or returns null if it is larger than `limit` bytes.
 *
 * An oversized body is still read to the end (and thrown away) so the client
 * gets a proper "too large" response; hanging up mid-upload would show up in
 * the browser as a network error instead. A body several times over the limit
 * is not worth being polite about and is cut off.
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let chunks: Buffer[] = []
    let size = 0
    let tooLarge = Number(req.headers['content-length'] ?? 0) > limit
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        tooLarge = true
        chunks = []
      }
      if (size > limit * 4) req.destroy()
      else if (!tooLarge) chunks.push(chunk)
    })
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)))
    req.on('close', () => resolve(null)) // aborted or cut off; a no-op after 'end'
  })
}

function decodePath(encoded: string): string | null {
  try {
    return normalizePath(decodeURIComponent(encoded))
  } catch {
    return null // malformed percent-encoding
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const engine = options.latex === undefined ? await detectLatex() : options.latex
  const compiler = new Compiler(engine, {
    buildDir: path.join(options.dataDir, 'build'),
    debounceMs: options.compileDebounceMs,
    compile: options.compile,
  })
  const assets = new AssetStore(options.dataDir)
  const rooms: RoomManager = new RoomManager(new DocStore(options.dataDir), {
    saveDebounceMs: options.saveDebounceMs,
    onChange: (room) => compiler.request(room.id, snapshot(room.id)),
    // Compile straight away for the first person in; a no-op if the PDF is current.
    onJoin: (room) => compiler.request(room.id, snapshot(room.id), 0),
    onEvict: (id) => compiler.forget(id),
  })

  /**
   * Reads a project's current contents at the moment a compile starts. It
   * goes through the room manager rather than holding on to a Room, because
   * the room may have been evicted and reloaded since the compile was queued.
   */
  function snapshot(id: string): () => Promise<ProjectSnapshot> {
    return () =>
      rooms.withRoom(id, async (room) => ({
        texts: room.textFiles(),
        assets: await assets.list(id),
      }))
  }

  const eventStreams = new Set<ServerResponse>()

  function handleEvents(id: string, req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    eventStreams.add(res)
    const unsubscribe = compiler.subscribe(id, (status) => {
      res.write(`data: ${JSON.stringify(status)}\n\n`)
    })
    // Comment lines keep proxies from closing an idle stream.
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000)
    req.on('close', () => {
      clearInterval(keepAlive)
      unsubscribe()
      eventStreams.delete(res)
      // While the room is loaded its eviction does the cleanup instead.
      if (!rooms.isLoaded(id)) compiler.forget(id)
    })
  }

  function handlePdf(id: string, res: ServerResponse): void {
    const pdf = compiler.pdf(id)
    if (!pdf) {
      sendJson(res, 404, { error: 'No PDF has been compiled for this document yet' })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.length,
      'Cache-Control': 'no-store',
    })
    res.end(pdf)
  }

  async function handleCompile(id: string, res: ServerResponse): Promise<void> {
    if (!compiler.available) {
      sendJson(res, 503, { error: 'LaTeX is not installed on the server' })
      return
    }
    compiler.request(id, snapshot(id), 0)
    sendJson(res, 202, { accepted: true })
  }

  async function handleAssetUpload(
    id: string,
    encodedPath: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const projectPath = decodePath(encodedPath)
    if (!projectPath || fileKind(projectPath) !== 'asset') {
      sendJson(res, 400, { error: 'Only PDF, PNG and JPEG files with simple names can be uploaded' })
      return
    }
    const data = await readBody(req, MAX_ASSET_BYTES)
    if (!data) {
      const limitMb = Math.round(MAX_ASSET_BYTES / 1024 / 1024)
      sendJson(res, 413, { error: `Files are limited to ${limitMb} MB each` })
      return
    }
    // Check the content, not just the name: a ".pdf" that is not a PDF would
    // only produce a confusing TeX error later.
    if (!matchesFileType(projectPath, data)) {
      sendJson(res, 415, { error: 'The file contents do not match its extension' })
      return
    }
    try {
      const asset = await assets.put(id, projectPath, data)
      // Recording it in the shared document tells every client about the new
      // file and, being a document change, triggers a recompile.
      await rooms.withRoom(id, (room) => room.setAsset(projectPath, { size: asset.size }))
      sendJson(res, 200, { path: projectPath, size: asset.size })
    } catch (err) {
      if (!(err instanceof AssetLimitError)) throw err
      sendJson(res, 413, { error: err.message })
    }
  }

  async function handleAssetDelete(id: string, encodedPath: string, res: ServerResponse): Promise<void> {
    const projectPath = decodePath(encodedPath)
    if (!projectPath || fileKind(projectPath) !== 'asset') {
      sendJson(res, 400, { error: 'Not a valid file path' })
      return
    }
    const existed = await assets.delete(id, projectPath)
    await rooms.withRoom(id, (room) => room.deleteAsset(projectPath))
    sendJson(res, existed ? 200 : 404, existed ? { deleted: projectPath } : { error: 'Not found' })
  }

  async function handleStatic(pathname: string, res: ServerResponse): Promise<void> {
    const root = path.resolve(options.staticDir!)
    let file = path.resolve(root, `.${decodeURIComponent(pathname)}`)
    // Refuse anything that resolves outside the web root.
    if (file !== root && !file.startsWith(root + path.sep)) {
      sendJson(res, 403, { error: 'Forbidden' })
      return
    }
    // Paths without an extension are app routes (e.g. /d/abc): serve the app shell.
    if (!path.extname(file)) file = path.join(root, 'index.html')
    try {
      const body = await readFile(file)
      const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream'
      const hashed = file.includes(`${path.sep}assets${path.sep}`)
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      })
      res.end(body)
    } catch {
      sendJson(res, 404, { error: 'Not found' })
    }
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')

    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true, latex: compiler.available })
      return
    }

    const api = API_ROUTE.exec(pathname)
    if (api) {
      const [, id, action] = api
      if (action === 'events' && req.method === 'GET') return handleEvents(id, req, res)
      if (action === 'pdf' && req.method === 'GET') return handlePdf(id, res)
      if (action === 'compile' && req.method === 'POST') return handleCompile(id, res)
      sendJson(res, 405, { error: 'Method not allowed' })
      return
    }

    const asset = ASSET_ROUTE.exec(pathname)
    if (asset) {
      const [, id, encodedPath] = asset
      if (req.method === 'PUT') return handleAssetUpload(id, encodedPath, req, res)
      if (req.method === 'DELETE') return handleAssetDelete(id, encodedPath, res)
      sendJson(res, 405, { error: 'Method not allowed' })
      return
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found' })
      return
    }
    if (options.staticDir && req.method === 'GET') return handleStatic(pathname, res)
    sendJson(res, 404, { error: 'Not found' })
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[http] request failed:', err)
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' })
      else res.end()
    })
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')
    const match = WS_ROUTE.exec(pathname)
    if (!match) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      rooms.join(match[1], ws).catch((err) => {
        console.error(`[ws] could not join ${match[1]}:`, err)
        ws.close(1011, 'could not open document')
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve)
  })

  return {
    port: (server.address() as AddressInfo).port,
    latexAvailable: compiler.available,
    async close() {
      for (const res of eventStreams) res.end()
      for (const ws of wss.clients) ws.terminate()
      await rooms.close()
      compiler.close()
      wss.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
