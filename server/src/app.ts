// HTTP + WebSocket front door.
//
//   WS   /ws/:docId                  real-time sync and presence
//   GET  /api/docs/:docId/events     compile status stream (Server-Sent Events)
//   GET  /api/docs/:docId/pdf        latest compiled PDF
//   POST /api/docs/:docId/compile    compile now instead of waiting for a pause
//   GET  /api/health
//   GET  /*                          the built web app, when `staticDir` is set
import { readFile } from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { Compiler, type CompilerOptions } from './compiler.ts'
import { detectLatex, type LatexEngine } from './latex.ts'
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
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024

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
  const rooms = new RoomManager(new DocStore(options.dataDir), {
    saveDebounceMs: options.saveDebounceMs,
    onChange: (room) => compiler.request(room.id, () => room.text),
    // Compile straight away for the first person in; a no-op if the PDF is current.
    onJoin: (room) => compiler.request(room.id, () => room.text, 0),
    onEvict: (id) => compiler.forget(id),
  })

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
    const room = await rooms.get(id)
    compiler.request(id, () => room.text, 0)
    sendJson(res, 202, { accepted: true })
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
