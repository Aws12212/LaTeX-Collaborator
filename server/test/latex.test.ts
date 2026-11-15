import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compileLatex, detectLatex, parseErrors, type ProjectSnapshot } from '../src/latex.ts'
import { projectOf, tempDir } from './helpers.ts'

const engine = await detectLatex()

const document = (body: string, preamble = '') => String.raw`\documentclass{article}
${preamble}
\begin{document}
${body}
\end{document}
`

describe('parseErrors', () => {
  it('extracts files and line numbers from file-line-error output', () => {
    const log = [
      'This is pdfTeX',
      './main.tex:12: Undefined control sequence.',
      'l.12 \\oops',
      'figures_tikz/disks.tex:40: Missing $ inserted.',
      'main.tex:40:  ==> Fatal error occurred, no output PDF file produced!',
    ].join('\n')

    expect(parseErrors(log)).toEqual([
      { file: 'main.tex', line: 12, message: 'Undefined control sequence.' },
      { file: 'figures_tikz/disks.tex', line: 40, message: 'Missing $ inserted.' },
    ])
  })

  it('places a missing-file error where TeX stopped', () => {
    const log = [
      "! LaTeX Error: File `figures_tikz/disks.tex' not found.",
      'Type X to quit or <RETURN> to proceed,',
      './main.tex:185: Emergency stop.',
      'main.tex:185:  ==> Fatal error occurred, no output PDF file produced!',
    ].join('\n')

    expect(parseErrors(log)).toEqual([
      { file: 'main.tex', line: 185, message: "LaTeX Error: File `figures_tikz/disks.tex' not found." },
    ])
  })
})

// These run the real pdflatex and are skipped on machines without TeX.
describe.skipIf(!engine)('compileLatex', { timeout: 120_000 }, () => {
  let work: Awaited<ReturnType<typeof tempDir>>

  beforeEach(async () => {
    work = await tempDir()
  })
  afterEach(() => work.remove())

  it('produces a PDF', async () => {
    const result = await compileLatex(engine!, projectOf(document('Hello.')), work.dir)

    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.pdf!.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('reports the file and line of an error', async () => {
    const project = projectOf(document(String.raw`\thiscommanddoesnotexist`))
    const result = await compileLatex(engine!, project, work.dir)

    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.errors[0]).toEqual({ file: 'main.tex', line: 4, message: 'Undefined control sequence.' })
  })

  it('compiles a project split across files and folders', async () => {
    const project = projectOf(document(String.raw`\input{sections/intro.tex}`), {
      'sections/intro.tex': 'Text from another file.',
    })
    const result = await compileLatex(engine!, project, work.dir)

    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('reports errors inside an included file against that file', async () => {
    const project = projectOf(document(String.raw`\input{sections/intro.tex}`), {
      'sections/intro.tex': 'Fine.\n\\notacommand\n',
    })
    const result = await compileLatex(engine!, project, work.dir)

    expect(result.errors[0]).toEqual({
      file: 'sections/intro.tex',
      line: 2,
      message: 'Undefined control sequence.',
    })
  })

  it('includes uploaded figures', async () => {
    // Make a real PDF to use as the figure.
    const figureDir = await tempDir()
    try {
      const figure = await compileLatex(engine!, projectOf(document('Figure.')), figureDir.dir)
      const file = path.join(figureDir.dir, 'figure-copy.pdf')
      await writeFile(file, figure.pdf!)

      const project: ProjectSnapshot = {
        ...projectOf(
          document(String.raw`\includegraphics[width=2cm]{figures/plot.pdf}`, String.raw`\usepackage{graphicx}`),
        ),
        assets: [{ path: 'figures/plot.pdf', size: figure.pdf!.length, mtimeMs: 1, file }],
      }
      const result = await compileLatex(engine!, project, work.dir)

      expect(result.errors).toEqual([])
      expect(result.ok).toBe(true)
    } finally {
      await figureDir.remove()
    }
  })

  it('stops finding a file once it is deleted from the project', async () => {
    const mainSource = document(String.raw`\input{part.tex}`)
    const first = await compileLatex(engine!, projectOf(mainSource, { 'part.tex': 'Here.' }), work.dir)
    expect(first.ok).toBe(true)

    const second = await compileLatex(engine!, projectOf(mainSource), work.dir)
    expect(second.ok).toBe(false)
    expect(second.errors[0].message).toMatch(/part\.tex' not found/)
  })

  it('refuses to write files outside the build directory', async () => {
    const project = projectOf(document('Hello.'), { '../escaped.tex': 'x' })
    await compileLatex(engine!, project, path.join(work.dir, 'build'))

    expect(existsSync(path.join(work.dir, 'escaped.tex'))).toBe(false)
  })

  it('explains a project with no main.tex', async () => {
    const result = await compileLatex(engine!, { texts: new Map(), assets: [] }, work.dir)

    expect(result.ok).toBe(false)
    expect(result.errors[0].message).toMatch(/no main\.tex/)
  })

  it('does not let a document run shell commands', async () => {
    const source = document(String.raw`\immediate\write18{echo pwned > pwned.txt}Hi.`)
    await compileLatex(engine!, projectOf(source), work.dir)

    expect(existsSync(path.join(work.dir, 'pwned.txt'))).toBe(false)
  })

  it('stops a document that never finishes', async () => {
    const source = document(String.raw`\def\loop{\loop}\loop`)
    const result = await compileLatex(engine!, projectOf(source), work.dir, { timeoutMs: 3000 })

    expect(result.ok).toBe(false)
    expect(result.errors[0].message).toMatch(/timed out/)
  })
})
