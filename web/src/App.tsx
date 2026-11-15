import type { EditorView } from 'codemirror'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type CompileStatus, useCompileStatus } from './compileStatus'
import { Editor, jumpToLine } from './Editor'
import { loadIdentity, saveIdentity } from './identity'
import { Preview } from './Preview'
import { type ConnectionState, openSession, type Peer, type Session } from './session'

function useSession(docId: string): Session | null {
  const [session, setSession] = useState<Session | null>(null)
  useEffect(() => {
    const opened = openSession(docId)
    setSession(opened)
    return () => {
      opened.destroy()
      setSession(null)
    }
  }, [docId])
  return session
}

function useConnection(session: Session | null): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting')
  useEffect(() => {
    if (!session) return
    const onStatus = (event: { status: ConnectionState }) => setState(event.status)
    session.provider.on('status', onStatus)
    return () => session.provider.off('status', onStatus)
  }, [session])
  return state
}

function usePeers(session: Session | null): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([])
  useEffect(() => {
    if (!session) return
    const update = () => setPeers(session.peers())
    update()
    session.provider.awareness.on('change', update)
    return () => session.provider.awareness.off('change', update)
  }, [session])
  return peers
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Offline — edits will sync when you reconnect',
}

function compileLabel(status: CompileStatus): string {
  switch (status.state) {
    case 'compiling':
      return 'Compiling…'
    case 'ok':
      return `Compiled in ${(status.durationMs / 1000).toFixed(1)} s`
    case 'error':
      return status.errors.length === 1 ? '1 error' : `${status.errors.length} errors`
    case 'unavailable':
      return 'No preview'
    case 'idle':
      return 'Waiting'
  }
}

export function App({ docId }: { docId: string }) {
  const [identity, setIdentity] = useState(loadIdentity)
  const session = useSession(docId)
  const connection = useConnection(session)
  const peers = usePeers(session)
  const compile = useCompileStatus(docId, connection === 'connected')
  const editorRef = useRef<EditorView | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    session?.setUser(identity)
    saveIdentity(identity)
  }, [session, identity])

  const onView = useCallback((view: EditorView | null) => {
    editorRef.current = view
  }, [])

  const onJumpToLine = useCallback((line: number) => {
    if (editorRef.current) jumpToLine(editorRef.current, line)
  }, [])

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.href)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('Copy this link to share the document:', location.href)
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">collab-tex</span>
          <span className={`dot dot-${connection}`} title={CONNECTION_LABEL[connection]} />
          <span className="muted connection-label">{CONNECTION_LABEL[connection]}</span>
        </div>

        <div className="topbar-right">
          <span className={`pill pill-${compile.status.state}`}>{compileLabel(compile.status)}</span>
          <button
            className="button"
            disabled={compile.status.state === 'unavailable' || compile.status.state === 'compiling'}
            onClick={() => void fetch(`/api/docs/${docId}/compile`, { method: 'POST' })}
          >
            Recompile
          </button>

          <ul className="peers" aria-label="People in this document">
            {peers.map((peer) => (
              <li
                key={peer.clientId}
                className="avatar"
                style={{ backgroundColor: peer.color }}
                title={peer.isSelf ? `${peer.name} (you)` : peer.name}
              >
                {peer.name.trim().charAt(0).toUpperCase() || '?'}
              </li>
            ))}
          </ul>

          <input
            className="name"
            aria-label="Your name"
            value={identity.name}
            maxLength={32}
            onChange={(event) => setIdentity({ ...identity, name: event.target.value })}
          />
          <button className="button button-primary" onClick={() => void copyLink()}>
            {copied ? 'Link copied' : 'Copy link'}
          </button>
        </div>
      </header>

      <main className="panes">
        <section className="pane" aria-label="Source">
          {session && <Editor session={session} onView={onView} />}
        </section>
        <section className="pane pane-preview" aria-label="Preview">
          <Preview docId={docId} compile={compile} onJumpToLine={onJumpToLine} />
        </section>
      </main>
    </div>
  )
}
