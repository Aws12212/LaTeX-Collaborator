// Decides when to compile. Compilation is driven by the server, not by each
// browser: however many people are editing, a change triggers one compile,
// and every subscriber is told about the result.
import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  compileLatex,
  type CompileResult,
  type LatexEngine,
  type LatexError,
  type ProjectSnapshot,
} from './latex.ts'

export type CompileStatus =
  | { state: 'unavailable' }
  | { state: 'idle' }
  | { state: 'compiling' }
  | { state: 'ok'; version: string; durationMs: number }
  | { state: 'error'; errors: LatexError[]; log: string; durationMs: number }

type Subscriber = (status: CompileStatus) => void
type GetProject = () => ProjectSnapshot | Promise<ProjectSnapshot>
type CompileFn = (project: ProjectSnapshot, workDir: string) => Promise<CompileResult>

interface DocState {
  status: CompileStatus
  pdf: Buffer | null
  /** Hash of the project contents that produced the current status. */
  compiledHash: string | null
  timer: NodeJS.Timeout | null
  running: boolean
  /** A change arrived while compiling; compile again when done. */
  dirty: boolean
  getProject: GetProject | null
  subscribers: Set<Subscriber>
}

export interface CompilerOptions {
  buildDir: string
  debounceMs?: number
  maxConcurrent?: number
  maxSourceBytes?: number
  timeoutMs?: number
  /** Replaces the real LaTeX run; used by tests. */
  compile?: CompileFn
}

const MAX_LOG_CHARS = 20_000

/** Identifies a project's contents: same hash, same PDF. */
function hashProject(project: ProjectSnapshot): string {
  const hash = createHash('sha256')
  for (const filePath of [...project.texts.keys()].sort()) {
    hash.update(`text\0${filePath}\0${project.texts.get(filePath)}\0`)
  }
  // Figures are identified by size and modification time; hashing their
  // bytes on every keystroke-triggered compile would be wasteful.
  for (const asset of [...project.assets].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`asset\0${asset.path}\0${asset.size}\0${asset.mtimeMs}\0`)
  }
  return hash.digest('hex').slice(0, 16)
}

function failed(message: string): CompileStatus {
  return { state: 'error', errors: [{ file: null, line: null, message }], log: '', durationMs: 0 }
}

export class Compiler {
  private readonly buildDir: string
  private readonly debounceMs: number
  private readonly maxConcurrent: number
  private readonly maxSourceBytes: number
  private readonly compile: CompileFn | null
  private readonly docs = new Map<string, DocState>()
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(engine: LatexEngine | null, options: CompilerOptions) {
    this.buildDir = options.buildDir
    this.debounceMs = options.debounceMs ?? 700
    this.maxConcurrent = options.maxConcurrent ?? 2
    this.maxSourceBytes = options.maxSourceBytes ?? 4 * 1024 * 1024
    const timeoutMs = options.timeoutMs
    this.compile =
      options.compile ??
      (engine ? (project, workDir) => compileLatex(engine, project, workDir, { timeoutMs }) : null)
  }

  get available(): boolean {
    return this.compile !== null
  }

  status(id: string): CompileStatus {
    return this.state(id).status
  }

  pdf(id: string): Buffer | null {
    return this.docs.get(id)?.pdf ?? null
  }

  /** Calls `subscriber` with the current status now and on every change. */
  subscribe(id: string, subscriber: Subscriber): () => void {
    const doc = this.state(id)
    doc.subscribers.add(subscriber)
    subscriber(doc.status)
    return () => {
      doc.subscribers.delete(subscriber)
    }
  }

  /**
   * Asks for a compile of the project's current contents after `delayMs` of
   * quiet. Repeated calls restart the wait, so a burst of typing compiles once.
   */
  request(id: string, getProject: GetProject, delayMs = this.debounceMs): void {
    if (!this.compile) return
    const doc = this.state(id)
    doc.getProject = getProject
    if (doc.timer) clearTimeout(doc.timer)
    doc.timer = setTimeout(() => {
      doc.timer = null
      void this.runCompile(id, doc)
    }, delayMs)
  }

  /** Drops a document's state once nobody is editing or watching it. */
  forget(id: string): void {
    const doc = this.docs.get(id)
    if (!doc || doc.subscribers.size > 0 || doc.running || doc.timer) return
    this.docs.delete(id)
  }

  close(): void {
    for (const doc of this.docs.values()) {
      if (doc.timer) clearTimeout(doc.timer)
      doc.subscribers.clear()
    }
    this.docs.clear()
  }

  private state(id: string): DocState {
    let doc = this.docs.get(id)
    if (!doc) {
      doc = {
        status: this.compile ? { state: 'idle' } : { state: 'unavailable' },
        pdf: null,
        compiledHash: null,
        timer: null,
        running: false,
        dirty: false,
        getProject: null,
        subscribers: new Set(),
      }
      this.docs.set(id, doc)
    }
    return doc
  }

  private publish(doc: DocState, status: CompileStatus): void {
    doc.status = status
    for (const subscriber of doc.subscribers) subscriber(status)
  }

  private async runCompile(id: string, doc: DocState): Promise<void> {
    if (!this.compile || !doc.getProject) return
    if (doc.running) {
      doc.dirty = true
      return
    }
    doc.running = true
    try {
      const project = await doc.getProject()
      const hash = hashProject(project)
      if (hash === doc.compiledHash) return // nothing changed since the last compile

      this.publish(doc, { state: 'compiling' })
      let bytes = 0
      for (const content of project.texts.values()) bytes += Buffer.byteLength(content)
      if (bytes > this.maxSourceBytes) {
        this.publish(doc, failed('This project is too large to compile'))
      } else {
        await this.acquire()
        let result: CompileResult
        try {
          result = await this.compile(project, path.join(this.buildDir, id))
        } finally {
          this.release()
        }
        if (result.ok && result.pdf) {
          doc.pdf = result.pdf
          this.publish(doc, { state: 'ok', version: hash, durationMs: result.durationMs })
        } else {
          this.publish(doc, {
            state: 'error',
            errors: result.errors,
            log: result.log.slice(-MAX_LOG_CHARS),
            durationMs: result.durationMs,
          })
        }
      }
      doc.compiledHash = hash
    } catch (err) {
      console.error(`[compile ${id}] failed:`, err)
      this.publish(doc, failed('The compile service hit an internal error'))
    } finally {
      doc.running = false
    }

    if (doc.dirty) {
      doc.dirty = false
      void this.runCompile(id, doc)
    }
  }

  // A small counting semaphore so a busy server runs at most `maxConcurrent`
  // TeX processes at once.
  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) next() // hand the slot straight to the next waiter
    else this.active--
  }
}
