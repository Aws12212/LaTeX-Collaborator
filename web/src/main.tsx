import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// A document lives at /d/<id>. Anyone with the link edits the same document.
const DOC_PATH = /^\/d\/([A-Za-z0-9_-]{1,64})$/

function newDocId(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789' // no look-alike characters
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

const match = DOC_PATH.exec(location.pathname)
if (!match) {
  location.replace(`/d/${newDocId()}`)
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App docId={match[1]} />
    </StrictMode>,
  )
}
