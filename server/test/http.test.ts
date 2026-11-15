import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type RunningServer, startServer } from '../src/app.ts'
import { connect, synced, tempDir, type TestClient, waitFor } from './helpers.ts'

describe('compile API', () => {
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
      // Stand-in for pdflatex: the "PDF" is just the source text.
      compile: async (source) => ({
        ok: true,
        pdf: Buffer.from(source),
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

  async function pdfText(docId: string): Promise<string | null> {
    const response = await fetch(`${url}/api/docs/${docId}/pdf`)
    return response.ok ? response.text() : null
  }

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

    let latest: string | null = null
    await waitFor(() => {
      void pdfText('talk').then((text) => (latest = text))
      return latest === client!.text.toString()
    }, 'first compile')

    client.text.insert(0, '% edited\n')
    await waitFor(() => {
      void pdfText('talk').then((text) => (latest = text))
      return latest !== null && (latest as string).startsWith('% edited\n')
    }, 'compile after edit')
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
  })
})
