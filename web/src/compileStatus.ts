import { useEffect, useState } from 'react'

export interface LatexError {
  line: number | null
  message: string
}

/** Mirrors CompileStatus in server/src/compiler.ts. */
export type CompileStatus =
  | { state: 'unavailable' }
  | { state: 'idle' }
  | { state: 'compiling' }
  | { state: 'ok'; version: string; durationMs: number }
  | { state: 'error'; errors: LatexError[]; log: string; durationMs: number }

export interface CompileInfo {
  status: CompileStatus
  /** Version of the newest successful PDF, kept while later compiles fail. */
  pdfVersion: string | null
}

/**
 * Follows the server's compile status stream for a document.
 *
 * `online` is whether the document's WebSocket is connected. The stream is
 * reopened each time that connection comes back: after a server restart a
 * proxy can leave the old stream open but silent, with no error event to
 * react to, whereas the WebSocket reliably notices and reconnects.
 */
export function useCompileStatus(docId: string, online: boolean): CompileInfo {
  const [info, setInfo] = useState<CompileInfo>({ status: { state: 'idle' }, pdfVersion: null })

  useEffect(() => {
    if (!online) return
    let source: EventSource | null = null
    let retryTimer: number | undefined
    let attempts = 0
    let stopped = false

    const open = () => {
      source = new EventSource(`/api/docs/${docId}/events`)
      source.onopen = () => {
        attempts = 0
      }
      // The server replays the current status on every connect, so a
      // reconnected stream is immediately up to date.
      source.onmessage = (event) => {
        const status = JSON.parse(event.data) as CompileStatus
        setInfo((previous) => ({
          status,
          pdfVersion: status.state === 'ok' ? status.version : previous.pdfVersion,
        }))
      }
      source.onerror = () => {
        // The browser reconnects a dropped stream by itself, but gives up for
        // good when it gets an error response, such as a proxy's 502 while
        // the server restarts. In that case reconnect by hand, backing off.
        if (stopped || source?.readyState !== EventSource.CLOSED) return
        const delay = Math.min(10_000, 500 * 2 ** attempts++)
        retryTimer = window.setTimeout(open, delay)
      }
    }
    open()

    return () => {
      stopped = true
      window.clearTimeout(retryTimer)
      source?.close()
    }
  }, [docId, online])

  return info
}
