import { useEffect, useRef, useState } from 'react'
import { MAIN_FILE } from '../../shared/project.ts'
import type { CompileInfo } from './compileStatus'
import { PdfView } from './pdfView'

interface PreviewProps {
  docId: string
  compile: CompileInfo
  onJump: (file: string, line: number) => void
}

export function Preview({ docId, compile, onJump }: PreviewProps) {
  const pagesRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<PdfView | null>(null)
  const [showLog, setShowLog] = useState(false)
  const { status, pdfVersion } = compile

  useEffect(() => {
    const pages = pagesRef.current!
    const view = new PdfView(pages)
    viewRef.current = view

    let timer: number | undefined
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void view.render().catch(console.error), 150)
    })
    observer.observe(pages)

    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
      view.destroy()
      viewRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!pdfVersion) return
    const controller = new AbortController()
    fetch(`/api/docs/${docId}/pdf?v=${pdfVersion}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`PDF request failed: ${response.status}`)
        return response.arrayBuffer()
      })
      .then((data) => viewRef.current?.load(data))
      .catch((err) => {
        if (!controller.signal.aborted) console.error(err)
      })
    return () => controller.abort()
  }, [docId, pdfVersion])

  return (
    <div className="preview">
      <div className="preview-scroll">
        {!pdfVersion && (
          <p className="preview-empty">
            {status.state === 'unavailable'
              ? 'The server has no LaTeX installed, so there is no preview. Editing still works.'
              : status.state === 'error'
                ? 'Fix the errors below to see a preview.'
                : 'Compiling the first preview…'}
          </p>
        )}
        <div className="preview-pages" ref={pagesRef} />
      </div>

      {status.state === 'error' && (
        <div className="errors" role="alert">
          <div className="errors-head">
            <strong>
              {status.errors.length === 1 ? '1 error' : `${status.errors.length} errors`}
            </strong>
            {pdfVersion && <span className="muted">Showing the last version that compiled</span>}
            {status.log && (
              <button className="link" onClick={() => setShowLog((shown) => !shown)}>
                {showLog ? 'Hide log' : 'Show log'}
              </button>
            )}
          </div>
          <ul>
            {status.errors.map((error, index) => (
              <li key={index}>
                {error.line !== null ? (
                  <button
                    className="link"
                    onClick={() => onJump(error.file ?? MAIN_FILE, error.line!)}
                  >
                    {error.file && error.file !== MAIN_FILE
                      ? `${error.file}:${error.line}`
                      : `Line ${error.line}`}
                  </button>
                ) : (
                  <span className="muted">General</span>
                )}
                <span>{error.message}</span>
              </li>
            ))}
          </ul>
          {showLog && <pre className="log">{status.log}</pre>}
        </div>
      )}
    </div>
  )
}
