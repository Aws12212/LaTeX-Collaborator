import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { fileKind, MAIN_FILE, normalizePath } from '../../shared/project.ts'
import { describeImport, importFiles, isProjectFolder } from './importFiles'
import type { ProjectFile, Session } from './session'

interface FilesProps {
  session: Session
  files: ProjectFile[]
  activePath: string
  onOpen: (path: string) => void
}

export function Files({ session, files, activePath, onOpen }: FilesProps) {
  const filesInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // React has no prop for this attribute, which makes the picker choose a folder.
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '')
  }, [])

  function newFile() {
    const input = window.prompt('Name for the new file, for example sections/intro.tex')
    if (!input) return
    const path = normalizePath(input)
    if (!path || fileKind(path) !== 'text') {
      setNotice(
        'Use letters, digits, dots, dashes and underscores, and end the name in .tex, .sty, .cls, .bib or .txt.',
      )
      return
    }
    if (!session.getText(path)) session.writeTextFile(path, '')
    setNotice(null)
    onOpen(path)
  }

  async function onPicked(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? [])
    event.target.value = '' // let the same selection be picked again later
    if (picked.length === 0) return
    if (
      isProjectFolder(picked) &&
      !window.confirm(`This folder has its own ${MAIN_FILE}, which will replace the current one. Continue?`)
    ) {
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      setNotice(describeImport(await importFiles(session, picked)))
    } finally {
      setBusy(false)
    }
  }

  async function remove(file: ProjectFile) {
    if (!window.confirm(`Delete ${file.path} for everyone?`)) return
    try {
      await session.deleteFile(file)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <nav className="files" aria-label="Project files">
      <ul className="file-list">
        {files.map((file) => (
          <li key={file.path} className={file.path === activePath ? 'file file-active' : 'file'}>
            {file.kind === 'text' ? (
              <button className="file-name" onClick={() => onOpen(file.path)} title={file.path}>
                {file.path}
              </button>
            ) : (
              <span className="file-name file-asset" title={`${file.path} (figure)`}>
                {file.path}
              </span>
            )}
            {file.path !== MAIN_FILE && (
              <button
                className="file-delete"
                aria-label={`Delete ${file.path}`}
                title="Delete"
                onClick={() => void remove(file)}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>

      {notice && (
        <p className="files-notice" role="status">
          {notice}
        </p>
      )}

      <div className="files-actions">
        <button className="button" onClick={newFile}>
          New file
        </button>
        <button className="button" disabled={busy} onClick={() => filesInput.current?.click()}>
          {busy ? 'Adding…' : 'Add files'}
        </button>
        <button className="button" disabled={busy} onClick={() => folderInput.current?.click()}>
          Add folder
        </button>
        <input ref={filesInput} type="file" multiple hidden onChange={(event) => void onPicked(event)} />
        <input ref={folderInput} type="file" hidden onChange={(event) => void onPicked(event)} />
      </div>
    </nav>
  )
}
