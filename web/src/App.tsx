import { useCallback, useEffect, useState } from 'react'
import { MAIN_FILE } from '../../shared/project.ts'
import { type CompileStatus, useCompileStatus } from './compileStatus'
import { Editor, type Jump } from './Editor'
import { Files } from './Files'
import { loadIdentity, saveIdentity } from './identity'
import { Preview } from './Preview'
import {
  type ConnectionState,
  openSession,
  type Peer,
  type ProjectFile,
  type Session,
} from './session'

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
    // Read the current state as well as listening for changes: the socket may
    // already have connected before this effect ran (it does when the page is
    // slow to render, e.g. in a background tab), and that event is then gone.
    setState(session.provider.wsconnected ? 'connected' : 'connecting')
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

function useFiles(session: Session | null): ProjectFile[] {
  const [files, setFiles] = useState<ProjectFile[]>([])
  useEffect(() => {
    if (!session) return
    const update = () => setFiles(session.listFiles())
    update()
    return session.onFilesChange(update)
  }, [session])
  return files
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
  const files = useFiles(session)
  const compile = useCompileStatus(docId, connection === 'connected')
  const [activePath, setActivePath] = useState(MAIN_FILE)
  const [jump, setJump] = useState<Jump | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    session?.setUser(identity)
    saveIdentity(identity)
  }, [session, identity])

  // If someone deletes the file you have open, fall back to main.tex.
  useEffect(() => {
    if (files.length > 0 && !files.some((file) => file.path === activePath)) {
      setActivePath(MAIN_FILE)
    }
  }, [files, activePath])

  const onJump = useCallback(
    (file: string, line: number) => {
      // Errors in files outside the project (a package, say) open main.tex.
      const path = session?.getText(file) ? file : MAIN_FILE
      setActivePath(path)
      setJump({ path, line: path === file ? line : 1, id: Date.now() })
    },
    [session],
  )

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.href)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('Copy this link to share the document:', location.href)
    }
  }

  // `files` is in scope so this re-reads when a file is created or replaced.
  const activeText = files.length > 0 ? (session?.getText(activePath) ?? null) : null

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
        <section className="pane pane-files">
          {session && (
            <Files session={session} files={files} activePath={activePath} onOpen={setActivePath} />
          )}
        </section>
        <section className="pane" aria-label={`Source of ${activePath}`}>
          {session && activeText ? (
            <Editor session={session} path={activePath} text={activeText} jump={jump} />
          ) : (
            <p className="pane-empty">Loading…</p>
          )}
        </section>
        <section className="pane pane-preview" aria-label="Preview">
          <Preview docId={docId} compile={compile} onJump={onJump} />
        </section>
      </main>
    </div>
  )
}
