// Runs pdflatex on untrusted input. The process is given a fixed argument
// list (no shell), shell escape is disabled, and it is killed on timeout.
//
// This is NOT a full sandbox: TeX can still read files the server user can
// read. Before exposing the server publicly, run compiles inside a container.
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface LatexError {
  /** 1-based line in the source, when TeX reported one. */
  line: number | null
  message: string
}

export interface CompileResult {
  ok: boolean
  pdf: Buffer | null
  log: string
  errors: LatexError[]
  durationMs: number
}

export interface LatexEngine {
  command: string
  extraArgs: string[]
}

export interface CompileOptions {
  timeoutMs?: number
}

const MAX_OUTPUT_BYTES = 1024 * 1024
const NEEDS_RERUN = /Rerun to get|Label\(s\) may have changed/

interface RunResult {
  code: number | null
  output: string
  timedOut: boolean
}

function run(command: string, args: string[], cwd: string | undefined, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let bytes = 0
    let timedOut = false
    const collect = (chunk: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) return
      chunks.push(chunk)
      bytes += chunk.length
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    const finish = (code: number | null) => {
      clearTimeout(timer)
      resolve({ code, output: Buffer.concat(chunks).toString('utf8'), timedOut })
    }
    child.on('error', () => finish(null)) // e.g. command not found
    child.on('close', finish)
  })
}

/** Finds a working pdflatex, or returns null if none is installed. */
export async function detectLatex(command = 'pdflatex'): Promise<LatexEngine | null> {
  const result = await run(command, ['--version'], undefined, 15_000)
  if (result.code !== 0) return null
  // MiKTeX can try to download missing packages mid-compile, which would
  // stall a server; make a missing package an ordinary error instead.
  const extraArgs = /MiKTeX/i.test(result.output) ? ['-disable-installer'] : []
  return { command, extraArgs }
}

export function parseErrors(log: string): LatexError[] {
  const errors: LatexError[] = []
  const seen = new Set<string>()
  const add = (line: number | null, message: string) => {
    const key = `${line}:${message}`
    if (seen.has(key)) return
    seen.add(key)
    errors.push({ line, message })
  }
  // With -file-line-error, errors look like "./main.tex:12: Undefined control sequence."
  for (const match of log.matchAll(/^(?:\.\/)?main\.tex:(\d+): (.+)$/gm)) {
    const message = match[2].trim()
    // "==> Fatal error occurred, no output PDF file produced!" is TeX's
    // closing summary, not a separate problem.
    if (message.startsWith('==>')) continue
    add(Number(match[1]), message)
  }
  // Errors without a source line look like "! Emergency stop."
  for (const match of log.matchAll(/^! (.+)$/gm)) {
    add(null, match[1].trim())
  }
  return errors
}

/**
 * Compiles `source` in `workDir`. The directory is reused between compiles of
 * the same document so auxiliary files (.aux, .nav, .toc) carry over.
 */
export async function compileLatex(
  engine: LatexEngine,
  source: string,
  workDir: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const started = performance.now()
  await mkdir(workDir, { recursive: true })
  await writeFile(path.join(workDir, 'main.tex'), source, 'utf8')

  const args = [
    '-interaction=nonstopmode',
    '-halt-on-error',
    '-file-line-error',
    '-no-shell-escape',
    ...engine.extraArgs,
    'main.tex',
  ]

  let result = await run(engine.command, args, workDir, timeoutMs)
  // Cross-references and slide navigation need a second pass to settle.
  if (result.code === 0 && NEEDS_RERUN.test(result.output)) {
    result = await run(engine.command, args, workDir, timeoutMs)
  }
  const durationMs = Math.round(performance.now() - started)
  const log = result.output

  if (result.timedOut) {
    const message = `Compilation timed out after ${Math.round(timeoutMs / 1000)} s`
    return { ok: false, pdf: null, log, errors: [{ line: null, message }], durationMs }
  }
  if (result.code !== 0) {
    const errors = parseErrors(log)
    if (errors.length === 0) errors.push({ line: null, message: 'Compilation failed' })
    return { ok: false, pdf: null, log, errors, durationMs }
  }

  // Read the PDF into memory so later requests never see a half-written file
  // from the next compile.
  const pdf = await readFile(path.join(workDir, 'main.pdf'))
  return { ok: true, pdf, log, errors: [], durationMs }
}
