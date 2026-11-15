import { StreamLanguage } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { basicSetup, EditorView } from 'codemirror'
import { useEffect, useRef } from 'react'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
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

/** A request to move the cursor; `id` makes repeated jumps to one line distinct. */
export interface Jump {
  path: string
  line: number
  id: number
}

interface EditorProps {
  session: Session
  /** Project path of the file being edited. */
  path: string
  /** That file's shared text. */
  text: Y.Text
  jump: Jump | null
}

export function Editor({ session, path, text, jump }: EditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    // Undo only your own edits to this file, never a collaborator's.
    const undoManager = new Y.UndoManager(text)
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          // Listed before basicSetup so undo/redo use the shared-document
          // history instead of CodeMirror's local one.
          keymap.of(yUndoManagerKeymap),
          basicSetup,
          StreamLanguage.define(stex),
          EditorView.lineWrapping,
          // Binds the editor to the shared text and draws remote cursors.
          yCollab(text, session.provider.awareness, { undoManager }),
          theme,
        ],
      }),
    })
    viewRef.current = view
    return () => {
      viewRef.current = null
      view.destroy()
      undoManager.destroy()
    }
  }, [session, text])

  // Declared after the effect above, so the editor for a newly opened file
  // already exists when a jump into that file arrives.
  const handledJump = useRef(0)
  useEffect(() => {
    const view = viewRef.current
    if (!view || !jump || jump.path !== path || jump.id === handledJump.current) return
    handledJump.current = jump.id // don't repeat it when this file is reopened later
    const line = Math.min(Math.max(jump.line, 1), view.state.doc.lines)
    const position = view.state.doc.line(line).from
    view.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: 'center' }),
    })
    view.focus()
  }, [jump, path, text])

  return <div className="editor" ref={hostRef} />
}
