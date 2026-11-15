import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { MAIN_FILE, MAX_ASSET_BYTES } from '../../shared/project.ts'
import { type RunningServer, startServer } from '../src/app.ts'
import { connect, synced, tempDir, type TestClient, waitFor } from './helpers.ts'

const PDF_BYTES = Buffer.from('%PDF-1.5 pretend figure')

describe('HTTP API', () => {
  let server: RunningServer
  let data: Awaited<ReturnType<typeof tempDir>>
  let client: TestClient | null
  let url: string

  beforeEach(async () => {
    data = await tempDir()
    client = null
    server = await startServer({
      dataDir: data.dir,
      latex: null,
      compileDebounceMs: 20,
      saveDebounceMs: 20,
      // Stand-in for pdflatex: the "PDF" lists what the project contained.
      compile: async (project) => ({
        ok: true,
        pdf: Buffer.from(
          JSON.stringify({
            main: project.texts.get(MAIN_FILE),
            texts: [...project.texts.keys()].sort(),
            assets: project.assets.map((asset) => asset.path),
          }),
        ),
        log: '',
        errors: [],
        durationMs: 1,
      }),
    })
    url = `http://127.0.0.1:${server.port}`
  })

  afterEach(async () => {
    client?.close()
    await server.close()
    await data.remove()
  })

  interface Compiled {
    main: string
    texts: string[]
    assets: string[]
  }

  /** Polls the compiled "PDF" until it satisfies `condition`. */
  async function compiled(docId: string, condition: (result: Compiled) => boolean, what: string) {
    let latest: Compiled | null = null
    await waitFor(() => {
      void fetch(`${url}/api/docs/${docId}/pdf`)
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => (latest = body as Compiled | null))
      return latest !== null && condition(latest)
    }, what)
    return latest!
  }

  const upload = (docId: string, filePath: string, body: Buffer = PDF_BYTES) =>
    fetch(`${url}/api/docs/${docId}/assets/${filePath}`, {
      method: 'PUT',
      body: body as unknown as BodyInit,
    })

  it('reports health', async () => {
    const response = await fetch(`${url}/api/health`)
    expect(await response.json()).toEqual({ ok: true, latex: true })
  })

  it('has no PDF before anyone opens the document', async () => {
    const response = await fetch(`${url}/api/docs/untouched/pdf`)
    expect(response.status).toBe(404)
  })

  it('compiles when someone joins, and again after they edit', async () => {
    client = connect(server.port, 'talk')
    await synced(client)
    const starter = client.text.toString()
    await compiled('talk', (result) => result.main === starter, 'first compile')

    client.text.insert(0, '% edited\n')
    await compiled('talk', (result) => result.main.startsWith('% edited\n'), 'compile after edit')
  })

  it('compiles every text file in the project, ignoring unsafe names', async () => {
    client = connect(server.port, 'multi')
    await synced(client)
    client.files.set('sections/intro.tex', new Y.Text('intro'))
    client.files.set('../../escape.tex', new Y.Text('nope'))
    client.files.set('notes.exe', new Y.Text('nope'))

    const result = await compiled('multi', (r) => r.texts.includes('sections/intro.tex'), 'multi-file compile')
    expect(result.texts).toEqual(['main.tex', 'sections/intro.tex'])
  })

  it('streams compile status to subscribers', async () => {
    const controller = new AbortController()
    const response = await fetch(`${url}/api/docs/stream/events`, { signal: controller.signal })
    expect(response.headers.get('content-type')).toBe('text/event-stream')

    const states: string[] = []
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
    const reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        for (const match of value.matchAll(/^data: (.+)$/gm)) {
          states.push(JSON.parse(match[1]).state)
        }
      }
    })().catch(() => {}) // aborting the request rejects the pending read

    client = connect(server.port, 'stream')
    await waitFor(() => states.includes('ok'), 'ok status on the stream')
    expect(states).toEqual(['idle', 'compiling', 'ok'])

    controller.abort()
    await reading
  })

  it('rejects unknown routes and methods', async () => {
    expect((await fetch(`${url}/api/nope`)).status).toBe(404)
    expect((await fetch(`${url}/api/docs/talk/pdf`, { method: 'DELETE' })).status).toBe(405)
    expect((await fetch(`${url}/api/docs/bad%20id/pdf`)).status).toBe(404)
    expect((await fetch(`${url}/api/docs/talk/assets/a.pdf`)).status).toBe(405)
  })

  describe('figure uploads', () => {
    it('stores a figure, lists it for collaborators, and recompiles with it', async () => {
      client = connect(server.port, 'figs')
      await synced(client)

      const response = await upload('figs', 'figures/plot.pdf')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ path: 'figures/plot.pdf', size: PDF_BYTES.length })

      await waitFor(() => client!.assets.has('figures/plot.pdf'), 'figure in the shared file list')
      expect(client.assets.get('figures/plot.pdf')).toEqual({ size: PDF_BYTES.length })
      await compiled('figs', (result) => result.assets.includes('figures/plot.pdf'), 'compile with figure')
    })

    it('deletes a figure for everyone', async () => {
      client = connect(server.port, 'figs')
      await synced(client)
      await upload('figs', 'plot.pdf')
      await waitFor(() => client!.assets.has('plot.pdf'), 'figure listed')

      const response = await fetch(`${url}/api/docs/figs/assets/plot.pdf`, { method: 'DELETE' })
      expect(response.status).toBe(200)
      await waitFor(() => !client!.assets.has('plot.pdf'), 'figure removed from the list')
      await compiled('figs', (result) => result.assets.length === 0, 'compile without figure')

      expect((await fetch(`${url}/api/docs/figs/assets/plot.pdf`, { method: 'DELETE' })).status).toBe(404)
    })

    it('keeps figures across a server restart', async () => {
      await upload('figs', 'plot.pdf')
      await server.close()
      server = await startServer({ dataDir: data.dir, latex: null })

      client = connect(server.port, 'figs')
      await synced(client)
      expect(client.assets.has('plot.pdf')).toBe(true)
    })

    it.each([
      ['a path that climbs out of the project', '..%2F..%2Fescape.pdf'],
      ['an absolute path', '%2Fetc%2Fescape.pdf'],
      ['a backslash path', '..%5Cescape.pdf'],
      ['a file type that is not a figure', 'script.js'],
      ['a text file', 'notes.tex'],
      ['malformed encoding', '%E0%A4%A.pdf'],
    ])('rejects %s', async (_label, encodedPath) => {
      const response = await upload('figs', encodedPath)

      expect(response.status).toBe(400)
      expect(existsSync(path.join(data.dir, 'escape.pdf'))).toBe(false)
      expect(existsSync(path.join(data.dir, 'assets', 'escape.pdf'))).toBe(false)
    })

    it('rejects contents that do not match the extension', async () => {
      const response = await upload('figs', 'plot.pdf', Buffer.from('<script>alert(1)</script>'))
      expect(response.status).toBe(415)
    })

    it('rejects files over the size limit', async () => {
      const big = Buffer.alloc(MAX_ASSET_BYTES + 1)
      big.write('%PDF-')
      const response = await upload('figs', 'big.pdf', big)
      expect(response.status).toBe(413)
    })
  })
})
