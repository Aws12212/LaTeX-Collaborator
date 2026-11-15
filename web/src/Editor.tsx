import { StreamLanguage } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { basicSetup, EditorView } from 'codemirror'
import { useEffect, useRef } from 'react'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import type { Session } from './session'

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, "Cascadia Code", Consolas, Menlo, monospace',
    lineHeight: '1.55',
  },
  '.cm-content': { padding: '12px 0' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: '#9aa1ab' },
  '&.cm-focused': { outline: 'none' },
})

interface EditorProps {
  session: Session
  /** Receives the editor once mounted, and null when it goes away. */
  onView: (view: EditorView | null) => void
}

export function Editor({ session, onView }: EditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: session.ytext.toString(),
        extensions: [
          // Listed before basicSetup so undo/redo use the shared-document
          // history instead of CodeMirror's local one.
          keymap.of(yUndoManagerKeymap),
          basicSetup,
          StreamLanguage.define(stex),
          EditorView.lineWrapping,
          // Binds the editor to the shared text and draws remote cursors.
          yCollab(session.ytext, session.provider.awareness, {
            undoManager: session.undoManager,
          }),
          theme,
        ],
      }),
    })
    onView(view)
    return () => {
      onView(null)
      view.destroy()
    }
  }, [session, onView])

  return <div className="editor" ref={hostRef} />
}

export function jumpToLine(view: EditorView, line: number): void {
  const target = Math.min(Math.max(line, 1), view.state.doc.lines)
  const position = view.state.doc.line(target).from
  view.dispatch({
    selection: { anchor: position },
    effects: EditorView.scrollIntoView(position, { y: 'center' }),
  })
  view.focus()
}
