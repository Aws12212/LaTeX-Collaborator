// Decides when to compile. Compilation is driven by the server, not by each
// browser: however many people are editing, a change triggers one compile,
// and every subscriber is told about the result.
import { createHash } from 'node:crypto'
import path from 'node:path'
import { compileLatex, type CompileResult, type LatexEngine, type LatexError } from './latex.ts'

export type CompileStatus =
  | { state: 'unavailable' }
  | { state: 'idle' }
  | { state: 'compiling' }
  | { state: 'ok'; version: string; durationMs: number }
  | { state: 'error'; errors: LatexError[]; log: string; durationMs: number }

type Subscriber = (status: CompileStatus) => void
type CompileFn = (source: string, workDir: string) => Promise<CompileResult>

interface DocState {
  status: CompileStatus
  pdf: Buffer | null
  /** Hash of the source that produced the current status. */
  compiledHash: string | null
  timer: NodeJS.Timeout | null
  running: boolean
  /** A change arrived while compiling; compile again when done. */
  dirty: boolean
  getSource: (() => string) | null
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

export class Compiler {
  private readonly engine: LatexEngine | null
  private readonly buildDir: string
  private readonly debounceMs: number
  private readonly maxConcurrent: number
  private readonly maxSourceBytes: number
  private readonly compile: CompileFn | null
  private readonly docs = new Map<string, DocState>()
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(engine: LatexEngine | null, options: CompilerOptions) {
    this.engine = engine
    this.buildDir = options.buildDir
    this.debounceMs = options.debounceMs ?? 700
    this.maxConcurrent = options.maxConcurrent ?? 2
    this.maxSourceBytes = options.maxSourceBytes ?? 1024 * 1024
    const timeoutMs = options.timeoutMs
    this.compile =
      options.compile ??
      (engine ? (source, workDir) => compileLatex(engine, source, workDir, { timeoutMs }) : null)
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
   * Asks for a compile of the document's current source after `delayMs` of
   * quiet. Repeated calls restart the wait, so a burst of typing compiles once.
   */
  request(id: string, getSource: () => string, delayMs = this.debounceMs): void {
    if (!this.compile) return
    const doc = this.state(id)
    doc.getSource = getSource
    if (doc.timer) clearTimeout(doc.timer)
    doc.timer = setTimeout(() => {
      doc.timer = null
      void this.runCompile(id, doc)
    }, delayMs)
  }

  /** Drops a document's state once nobody is editing or watching it. */
  forget(id: string): void {
    const doc = this.docs.get(id)
    if (!doc || doc.subscribers.size > 0 || doc.running) return
    if (doc.timer) clearTimeout(doc.timer)
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
        getSource: null,
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
    if (!this.compile || !doc.getSource) return
    if (doc.running) {
      doc.dirty = true
      return
    }
    const source = doc.getSource()
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)
    if (hash === doc.compiledHash) return // nothing changed since the last compile

    doc.running = true
    this.publish(doc, { state: 'compiling' })
    try {
      if (Buffer.byteLength(source) > this.maxSourceBytes) {
        this.publish(doc, {
          state: 'error',
          errors: [{ line: null, message: 'Document is too large to compile' }],
          log: '',
          durationMs: 0,
        })
      } else {
        await this.acquire()
        let result: CompileResult
        try {
          result = await this.compile(source, path.join(this.buildDir, id))
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
      this.publish(doc, {
        state: 'error',
        errors: [{ line: null, message: 'The compile service hit an internal error' }],
        log: '',
        durationMs: 0,
      })
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
