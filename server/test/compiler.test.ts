import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_FILE } from '../../shared/project.ts'
import { Compiler, type CompileStatus } from '../src/compiler.ts'
import type { CompileResult, ProjectSnapshot } from '../src/latex.ts'
import { projectOf, waitFor } from './helpers.ts'

const main = (project: ProjectSnapshot) => project.texts.get(MAIN_FILE)!

/** A fake compile whose "PDF" is just the source of main.tex. */
const ok = (project: ProjectSnapshot): CompileResult => ({
  ok: true,
  pdf: Buffer.from(main(project)),
  log: '',
  errors: [],
  durationMs: 1,
})

const failure: CompileResult = {
  ok: false,
  pdf: null,
  log: 'main.tex:3: Undefined control sequence.',
  errors: [{ file: 'main.tex', line: 3, message: 'Undefined control sequence.' }],
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
      compile: async (project) => {
        compiled.push(main(project))
        return ok(project)
      },
    })

    let source = 'a'
    for (const next of ['ab', 'abc', 'abcd']) {
      source = next
      compiler.request('doc', () => projectOf(source))
    }
    await waitFor(() => compiler.status('doc').state === 'ok', 'compile to finish')

    expect(compiled).toEqual(['abcd'])
    expect(compiler.pdf('doc')?.toString()).toBe('abcd')
  })

  it('does not recompile an unchanged project', async () => {
    let runs = 0
    compiler = new Compiler(null, {
      buildDir: 'unused',
      compile: async (project) => {
        runs++
        return ok(project)
      },
    })

    compiler.request('doc', () => projectOf('same'), 0)
    await waitFor(() => compiler.status('doc').state === 'ok', 'first compile')
    compiler.request('doc', () => projectOf('same'), 0)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(runs).toBe(1)
  })

  it('recompiles when a file other than main.tex changes', async () => {
    let runs = 0
    compiler = new Compiler(null, {
      buildDir: 'unused',
      compile: async (project) => {
        runs++
        return ok(project)
      },
    })

    compiler.request('doc', () => projectOf('main', { 'part.tex': 'one' }), 0)
    await waitFor(() => runs === 1 && compiler.status('doc').state === 'ok', 'first compile')
    compiler.request('doc', () => projectOf('main', { 'part.tex': 'two' }), 0)
    await waitFor(() => runs === 2, 'second compile')
  })

  it('recompiles when a figure is replaced', async () => {
    let runs = 0
    compiler = new Compiler(null, {
      buildDir: 'unused',
      compile: async (project) => {
        runs++
        return ok(project)
      },
    })
    const withFigure = (mtimeMs: number): ProjectSnapshot => ({
      ...projectOf('main'),
      assets: [{ path: 'fig.pdf', size: 10, mtimeMs, file: 'unused' }],
    })

    compiler.request('doc', () => withFigure(1), 0)
    await waitFor(() => runs === 1 && compiler.status('doc').state === 'ok', 'first compile')
    compiler.request('doc', () => withFigure(2), 0)
    await waitFor(() => runs === 2, 'second compile')
  })

  it('compiles again when the project changes mid-compile', async () => {
    const compiled: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    compiler = new Compiler(null, {
      buildDir: 'unused',
      compile: async (project) => {
        compiled.push(main(project))
        if (compiled.length === 1) await gate
        return ok(project)
      },
    })

    let source = 'v1'
    compiler.request('doc', () => projectOf(source), 0)
    await waitFor(() => compiled.length === 1, 'first compile to start')
    source = 'v2'
    compiler.request('doc', () => projectOf(source), 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()

    await waitFor(() => compiler.pdf('doc')?.toString() === 'v2', 'second compile')
    expect(compiled).toEqual(['v1', 'v2'])
  })

  it('reports errors and keeps the last good PDF', async () => {
    const statuses: CompileStatus[] = []
    compiler = new Compiler(null, {
      buildDir: 'unused',
      compile: async (project) => (main(project) === 'bad' ? failure : ok(project)),
    })
    compiler.subscribe('doc', (status) => statuses.push(status))

    compiler.request('doc', () => projectOf('good'), 0)
    await waitFor(() => compiler.status('doc').state === 'ok', 'good compile')
    compiler.request('doc', () => projectOf('bad'), 0)
    await waitFor(() => compiler.status('doc').state === 'error', 'bad compile')

    expect(statuses.map((status) => status.state)).toEqual(['idle', 'compiling', 'ok', 'compiling', 'error'])
    expect(compiler.status('doc')).toMatchObject({ errors: [{ file: 'main.tex', line: 3 }] })
    expect(compiler.pdf('doc')?.toString()).toBe('good')
  })

  it('never runs more compiles at once than allowed', async () => {
    let running = 0
    let peak = 0
    compiler = new Compiler(null, {
      buildDir: 'unused',
      maxConcurrent: 2,
      compile: async (project) => {
        running++
        peak = Math.max(peak, running)
        await new Promise((resolve) => setTimeout(resolve, 20))
        running--
        return ok(project)
      },
    })

    const ids = ['a', 'b', 'c', 'd', 'e']
    for (const id of ids) compiler.request(id, () => projectOf(id), 0)
    await waitFor(() => ids.every((id) => compiler.status(id).state === 'ok'), 'all compiles')

    expect(peak).toBe(2)
  })

  it('reports unavailable when there is no LaTeX engine', () => {
    compiler = new Compiler(null, { buildDir: 'unused' })
    expect(compiler.available).toBe(false)
    expect(compiler.status('doc')).toEqual({ state: 'unavailable' })
  })
})
