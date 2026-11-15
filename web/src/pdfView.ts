// Renders a PDF into a container, one canvas per page, at the container's
// width. Kept outside React because it owns imperative, cancellable work.
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export class PdfView {
  private readonly container: HTMLElement
  private doc: PDFDocumentProxy | null = null
  private loadGeneration = 0
  private renderGeneration = 0
  private renderedWidth = 0
  private tasks: RenderTask[] = []
  private destroyed = false

  constructor(container: HTMLElement) {
    this.container = container
  }

  /** Shows a new PDF. If another load starts meanwhile, this one is dropped. */
  async load(data: ArrayBuffer): Promise<void> {
    const generation = ++this.loadGeneration
    const doc = await pdfjs.getDocument({ data }).promise
    if (this.destroyed || generation !== this.loadGeneration) {
      void doc.loadingTask.destroy()
      return
    }
    const previous = this.doc
    this.doc = doc
    await this.render(true)
    void previous?.loadingTask.destroy()
  }

  /** Re-renders if the container width changed (or always, when forced). */
  async render(force = false): Promise<void> {
    const doc = this.doc
    const width = this.container.clientWidth
    if (!doc || width <= 0) return
    if (!force && width === this.renderedWidth) return

    const generation = ++this.renderGeneration
    this.cancelTasks()
    const stale = () => this.destroyed || generation !== this.renderGeneration

    try {
      const pixelRatio = window.devicePixelRatio || 1
      const canvases: HTMLCanvasElement[] = []
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        const page = await doc.getPage(pageNumber)
        if (stale()) return
        const base = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: (width / base.width) * pixelRatio })
        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.aspectRatio = `${base.width} / ${base.height}`
        const task = page.render({ canvas, viewport })
        this.tasks.push(task)
        await task.promise
        if (stale()) return
        canvases.push(canvas)
      }
      // Swap every page in at once: no flicker, and the scroll position holds.
      this.container.replaceChildren(...canvases)
      this.renderedWidth = width
    } catch (err) {
      // A cancelled render rejects; that is expected when a newer one started.
      if (!stale()) throw err
    }
  }

  destroy(): void {
    this.destroyed = true
    this.cancelTasks()
    void this.doc?.loadingTask.destroy()
    this.doc = null
  }

  private cancelTasks(): void {
    for (const task of this.tasks) task.cancel()
    this.tasks = []
  }
}
