// Runs pdflatex on untrusted input. The process is given a fixed argument
// list (no shell), shell escape is disabled, and it is killed on timeout.
//
// This is NOT a full sandbox: TeX can still read files the server user can
// read. Before exposing the server publicly, run compiles inside a container.
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isValidPath, MAIN_FILE } from '../../shared/project.ts'
import type { AssetEntry } from './assets.ts'

/** Everything needed to compile a project at one moment in time. */
export interface ProjectSnapshot {
  /** Text files by project path; must include main.tex to compile. */
  texts: Map<string, string>
  assets: AssetEntry[]
}

export interface LatexError {
  /** Project file the error is in, when TeX reported one. */
  file: string | null
  /** 1-based line in that file. */
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
  const add = (file: string | null, line: number | null, message: string) => {
    const key = `${file}:${line}:${message}`
    if (seen.has(key)) return
    seen.add(key)
    errors.push({ file, line, message })
  }
  // With -file-line-error, errors look like
  // "./figures/disks.tex:12: Undefined control sequence."
  let stoppedAt: { file: string; line: number } | null = null
  for (const match of log.matchAll(/^(?:\.\/)?([A-Za-z0-9_][A-Za-z0-9._/-]*):(\d+): (.+)$/gm)) {
    const message = match[3].trim()
    const location = { file: match[1], line: Number(match[2]) }
    // "Emergency stop." and "==> Fatal error occurred, no output PDF file
    // produced!" are TeX giving up, not separate problems.
    if (message === 'Emergency stop.') stoppedAt = location
    if (message === 'Emergency stop.' || message.startsWith('==>')) continue
    add(location.file, location.line, message)
  }
  // Some errors are printed without a location, e.g.
  // "! LaTeX Error: File `x' not found." They are what made TeX stop, so the
  // place it stopped is where they are.
  for (const match of log.matchAll(/^! (.+)$/gm)) {
    const message = match[1].trim()
    if (message === 'Emergency stop.') continue
    add(stoppedAt?.file ?? null, stoppedAt?.line ?? null, message)
  }
  return errors
}

const MANIFEST = '.collab-tex.json'

/**
 * Makes `workDir` hold exactly the project's files. The directory is reused
 * between compiles (so .aux and .nav files carry over), which means files
 * deleted from the project have to be removed here or TeX would still find
 * them. A manifest records what we put there last time.
 */
async function syncWorkDir(workDir: string, project: ProjectSnapshot): Promise<void> {
  await mkdir(workDir, { recursive: true })
  let previous: Record<string, string> = {}
  try {
    previous = JSON.parse(await readFile(path.join(workDir, MANIFEST), 'utf8'))
  } catch {
    // First compile, or an unreadable manifest: treat the directory as empty.
  }

  const current: Record<string, string> = {}
  const place = async (projectPath: string) => {
    const target = path.join(workDir, ...projectPath.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    return target
  }

  for (const [projectPath, content] of project.texts) {
    if (!isValidPath(projectPath)) continue // never write outside workDir
    await writeFile(await place(projectPath), content, 'utf8')
    current[projectPath] = 'text'
  }
  for (const asset of project.assets) {
    if (!isValidPath(asset.path) || asset.path in current) continue
    const version = `${asset.size}:${asset.mtimeMs}`
    // Figures rarely change, so only copy the ones that did.
    if (previous[asset.path] !== version) await copyFile(asset.file, await place(asset.path))
    current[asset.path] = version
  }
  for (const projectPath of Object.keys(previous)) {
    if (projectPath in current || !isValidPath(projectPath)) continue
    await rm(path.join(workDir, ...projectPath.split('/')), { force: true })
  }
  await writeFile(path.join(workDir, MANIFEST), JSON.stringify(current))
}

/** Compiles a project's main.tex in `workDir`. */
export async function compileLatex(
  engine: LatexEngine,
  project: ProjectSnapshot,
  workDir: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const started = performance.now()
  if (!project.texts.has(MAIN_FILE)) {
    const message = `This project has no ${MAIN_FILE}, which is the file that gets compiled`
    return { ok: false, pdf: null, log: '', errors: [{ file: null, line: null, message }], durationMs: 0 }
  }
  await syncWorkDir(workDir, project)

  const args = [
    '-interaction=nonstopmode',
    '-halt-on-error',
    '-file-line-error',
    '-no-shell-escape',
    ...engine.extraArgs,
    MAIN_FILE,
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
    return { ok: false, pdf: null, log, errors: [{ file: null, line: null, message }], durationMs }
  }
  if (result.code !== 0) {
    const errors = parseErrors(log)
    if (errors.length === 0) {
      errors.push({ file: null, line: null, message: 'Compilation failed; see the log for details' })
    }
    return { ok: false, pdf: null, log, errors, durationMs }
  }

  // Read the PDF into memory so later requests never see a half-written file
  // from the next compile.
  const pdf = await readFile(path.join(workDir, 'main.pdf'))
  return { ok: true, pdf, log, errors: [], durationMs }
}
