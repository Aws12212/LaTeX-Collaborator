import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { type RunningServer, startServer } from '../src/app.ts'
import { STARTER_DOCUMENT } from '../src/template.ts'
import { connect, synced, tempDir, type TestClient, waitFor } from './helpers.ts'

describe('real-time sync', () => {
  let server: RunningServer
  let data: Awaited<ReturnType<typeof tempDir>>
  let clients: TestClient[]

  const start = () => startServer({ dataDir: data.dir, latex: null, saveDebounceMs: 20 })
  const open = (docId: string) => {
    const client = connect(server.port, docId)
    clients.push(client)
    return client
  }

  beforeEach(async () => {
    data = await tempDir()
    clients = []
    server = await start()
  })

  afterEach(async () => {
    for (const client of clients) client.close()
    await server.close()
    await data.remove()
  })

  it('seeds a new document exactly once, even when two people open it together', async () => {
    const alice = open('fresh')
    const bob = open('fresh')
    await Promise.all([synced(alice), synced(bob)])

    expect(alice.text.toString()).toBe(STARTER_DOCUMENT)
    expect(bob.text.toString()).toBe(STARTER_DOCUMENT)
  })

  it('delivers edits in both directions', async () => {
    const alice = open('pair')
    const bob = open('pair')
    await Promise.all([synced(alice), synced(bob)])

    alice.text.insert(0, '% from alice\n')
    await waitFor(() => bob.text.toString().startsWith('% from alice\n'), "alice's edit at bob")

    bob.text.insert(bob.text.length, '% from bob\n')
    await waitFor(() => alice.text.toString().endsWith('% from bob\n'), "bob's edit at alice")

    expect(alice.text.toString()).toBe(bob.text.toString())
  })

  it('merges edits made while both people were offline', async () => {
    const alice = open('offline')
    const bob = open('offline')
    await Promise.all([synced(alice), synced(bob)])

    alice.provider.disconnect()
    bob.provider.disconnect()
    alice.text.insert(0, 'ALICE ')
    bob.text.insert(0, 'BOB ')
    alice.provider.connect()
    bob.provider.connect()

    await waitFor(
      () =>
        alice.text.toString() === bob.text.toString() &&
        alice.text.toString().includes('ALICE ') &&
        alice.text.toString().includes('BOB '),
      'both replicas to converge',
    )
    expect(alice.text.toString().endsWith(STARTER_DOCUMENT)).toBe(true)
  })

  it('keeps documents separate', async () => {
    const alice = open('doc-a')
    const bob = open('doc-b')
    await Promise.all([synced(alice), synced(bob)])

    alice.text.insert(0, 'only in a')
    // Round-trip a second client on doc-a so we know the edit was processed.
    const carol = open('doc-a')
    await synced(carol)
    await waitFor(() => carol.text.toString().startsWith('only in a'), "alice's edit at carol")

    expect(bob.text.toString()).toBe(STARTER_DOCUMENT)
  })

  it('persists documents across a server restart', async () => {
    const alice = open('durable')
    await synced(alice)
    alice.text.insert(0, '% survives restarts\n')
    const expected = alice.text.toString()

    // Confirm the server has the edit before stopping it.
    const bob = open('durable')
    await synced(bob)
    await waitFor(() => bob.text.toString() === expected, 'edit to reach the server')

    for (const client of clients) client.close()
    clients = []
    await server.close()
    server = await start()

    const carol = open('durable')
    await synced(carol)
    expect(carol.text.toString()).toBe(expected)
  })

  it('syncs files created and deleted by collaborators', async () => {
    const alice = open('files')
    const bob = open('files')
    await Promise.all([synced(alice), synced(bob)])

    alice.files.set('sections/intro.tex', new Y.Text('hello'))
    await waitFor(() => bob.files.has('sections/intro.tex'), 'new file at bob')

    bob.files.get('sections/intro.tex')!.insert(5, ' world')
    await waitFor(
      () => alice.files.get('sections/intro.tex')!.toString() === 'hello world',
      "bob's edit to the new file at alice",
    )

    bob.files.delete('sections/intro.tex')
    await waitFor(() => !alice.files.has('sections/intro.tex'), 'deletion at alice')
  })

  it('opens documents saved by the single-file version', async () => {
    // That version kept the text in one top-level Y.Text called "main".
    const legacy = new Y.Doc()
    legacy.getText('main').insert(0, '% written before multi-file projects\n')
    await mkdir(path.join(data.dir, 'docs'), { recursive: true })
    await writeFile(path.join(data.dir, 'docs', 'old.ydoc'), Y.encodeStateAsUpdate(legacy))

    const alice = open('old')
    await synced(alice)

    expect(alice.text.toString()).toBe('% written before multi-file projects\n')
    expect([...alice.files.keys()]).toEqual(['main.tex'])
  })

  it('shares presence and removes it when someone leaves', async () => {
    const alice = open('presence')
    const bob = open('presence')
    await Promise.all([synced(alice), synced(bob)])

    alice.provider.awareness.setLocalStateField('user', { name: 'Alice' })
    const aliceAtBob = () =>
      (bob.provider.awareness.getStates().get(alice.doc.clientID)?.user as { name: string } | undefined)?.name
    await waitFor(() => aliceAtBob() === 'Alice', "alice's presence at bob")

    alice.close()
    await waitFor(
      () => !bob.provider.awareness.getStates().has(alice.doc.clientID),
      "alice's presence to be removed",
    )
  })

  it('drops a client that sends garbage without disturbing others', async () => {
    const alice = open('hostile')
    await synced(alice)

    const raw = new WebSocket(`ws://127.0.0.1:${server.port}/ws/hostile`)
    const closed = new Promise<void>((resolve) => raw.once('close', () => resolve()))
    await new Promise<void>((resolve) => raw.once('open', () => resolve()))
    raw.send(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0x02]))
    await closed

    const bob = open('hostile')
    await synced(bob)
    alice.text.insert(0, 'still working ')
    await waitFor(() => bob.text.toString().startsWith('still working '), 'sync after bad client')
  })

  it('rejects connections with an invalid document id', async () => {
    const raw = new WebSocket(`ws://127.0.0.1:${server.port}/ws/not%20valid!`)
    const failed = await new Promise<boolean>((resolve) => {
      raw.once('open', () => resolve(false))
      raw.once('error', () => resolve(true))
    })
    expect(failed).toBe(true)
  })
})
