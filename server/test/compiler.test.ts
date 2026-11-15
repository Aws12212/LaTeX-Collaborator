import { afterEach, describe, expect, it } from 'vitest'
import { Compiler, type CompileStatus } from '../src/compiler.ts'
import type { CompileResult } from '../src/latex.ts'
import { waitFor } from './helpers.ts'

const ok = (text: string): CompileResult => ({
  ok: true,
  pdf: Buffer.from(text),
  log: '',
  errors: [],
  durationMs: 1,
})

const failure: CompileResult = {
  ok: false,
  pdf: null,
  log: 'main.tex:3: Undefined control sequence.',
  errors: [{ line: 3, message: 'Undefined control sequence.' }],
  durationMs: 1,
}

describe('compile scheduling', () => {
  let compiler: Compiler

  afterEach(() => compiler.close())

  it('compiles once for a burst of changes', async () => {
    const compiled: string[] = []
    compiler = new Compiler(null, {
      buildDir: 'unused',
      debounceMs: 30,
      compile: async (source) => {
        compiled.push(source)
        return ok(source)
      },
    })

    let source = 'a'
    for (const next of ['ab', 'abc', 'abcd']) {
      source = next
      compiler.request('doc', () => source)
    }
    await waitFor(() => compiler.status('doc').state === 'ok', 'compile to finish')

    expect(compiled).toEqual(['abcd'])
    expect(compiler.pdf('doc')?.toString()).toBe('abcd')
  })

  it('does not recompile unchanged source', async () => {
    let runs = 0
    compiler = new Compiler(null, {
      buildDir: 'unused',
      compile: async (source) => {
        runs++
        return ok(source)
      },
    })

    compiler.request('doc', () => 'same', 0)
    await waitFor(() => compiler.status('doc').state === 'ok', 'first compile')
    compiler.request('doc', () => 'same', 0)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(runs).toBe(1)
  })

  it('compiles again when the source changes mid-compile', async () => {
    const compiled: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    compiler = new Compiler(null, {
      buildDir: 'unused',
      compile: async (source) => {
        compiled.push(source)
        if (compiled.length === 1) await gate
        return ok(source)
      },
    })

    let source = 'v1'
    compiler.request('doc', () => source, 0)
    await waitFor(() => compiled.length === 1, 'first compile to start')
    source = 'v2'
    compiler.request('doc', () => source, 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()

    await waitFor(() => compiler.pdf('doc')?.toString() === 'v2', 'second compile')
    expect(compiled).toEqual(['v1', 'v2'])
  })

  it('reports errors and keeps the last good PDF', async () => {
    const statuses: CompileStatus[] = []
    compiler = new Compiler(null, {
      buildDir: 'unused',
      compile: async (source) => (source === 'bad' ? failure : ok(source)),
    })
    compiler.subscribe('doc', (status) => statuses.push(status))

    compiler.request('doc', () => 'good', 0)
    await waitFor(() => compiler.status('doc').state === 'ok', 'good compile')
    compiler.request('doc', () => 'bad', 0)
    await waitFor(() => compiler.status('doc').state === 'error', 'bad compile')

    expect(statuses.map((status) => status.state)).toEqual(['idle', 'compiling', 'ok', 'compiling', 'error'])
    expect(compiler.status('doc')).toMatchObject({ errors: [{ line: 3 }] })
    expect(compiler.pdf('doc')?.toString()).toBe('good')
  })

  it('never runs more compiles at once than allowed', async () => {
    let running = 0
    let peak = 0
    compiler = new Compiler(null, {
      buildDir: 'unused',
      maxConcurrent: 2,
      compile: async (source) => {
        running++
        peak = Math.max(peak, running)
        await new Promise((resolve) => setTimeout(resolve, 20))
        running--
        return ok(source)
      },
    })

    const ids = ['a', 'b', 'c', 'd', 'e']
    for (const id of ids) compiler.request(id, () => id, 0)
    await waitFor(() => ids.every((id) => compiler.status(id).state === 'ok'), 'all compiles')

    expect(peak).toBe(2)
  })

  it('reports unavailable when there is no LaTeX engine', () => {
    compiler = new Compiler(null, { buildDir: 'unused' })
    expect(compiler.available).toBe(false)
    expect(compiler.status('doc')).toEqual({ state: 'unavailable' })
  })
})
