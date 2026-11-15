import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compileLatex, detectLatex, parseErrors } from '../src/latex.ts'
import { tempDir } from './helpers.ts'

const engine = await detectLatex()

const document = (body: string) => String.raw`\documentclass{article}
\begin{document}
${body}
\end{document}
`

describe('parseErrors', () => {
  it('extracts line numbers from file-line-error output', () => {
    const log = [
      'This is pdfTeX',
      './main.tex:12: Undefined control sequence.',
      'l.12 \\oops',
      'main.tex:40: Missing $ inserted.',
      'main.tex:40:  ==> Fatal error occurred, no output PDF file produced!',
      '! Emergency stop.',
    ].join('\n')

    expect(parseErrors(log)).toEqual([
      { line: 12, message: 'Undefined control sequence.' },
      { line: 40, message: 'Missing $ inserted.' },
      { line: null, message: 'Emergency stop.' },
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
    const result = await compileLatex(engine!, document('Hello.'), work.dir)

    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.pdf!.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('reports the line of an error', async () => {
    const result = await compileLatex(engine!, document(String.raw`\thiscommanddoesnotexist`), work.dir)

    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.errors[0]).toEqual({ line: 3, message: 'Undefined control sequence.' })
  })

  it('does not let a document run shell commands', async () => {
    const source = document(String.raw`\immediate\write18{echo pwned > pwned.txt}Hi.`)
    await compileLatex(engine!, source, work.dir)

    expect(existsSync(path.join(work.dir, 'pwned.txt'))).toBe(false)
  })

  it('stops a document that never finishes', async () => {
    const source = document(String.raw`\def\loop{\loop}\loop`)
    const result = await compileLatex(engine!, source, work.dir, { timeoutMs: 3000 })

    expect(result.ok).toBe(false)
    expect(result.errors[0].message).toMatch(/timed out/)
  })
})
