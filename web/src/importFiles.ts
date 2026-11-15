// Adds files picked from disk to the project: text files become shared,
// collaboratively edited files; figures are uploaded to the server.
import {
  fileKind,
  MAIN_FILE,
  MAX_ASSET_BYTES,
  MAX_TEXT_BYTES,
  normalizePath,
} from '../../shared/project.ts'
import type { Session } from './session'

export interface ImportSummary {
  added: string[]
  /** Files that are not LaTeX sources or figures (.aux, .log, ...). */
  unsupported: number
  /** Supported files that could not be added, with the reason. */
  failed: { name: string; reason: string }[]
}

interface Candidate {
  file: File
  /** Path relative to what the user picked; includes the folder name for folder uploads. */
  relative: string
}

/**
 * True if the selection is a single folder with main.tex directly inside it,
 * i.e. a whole LaTeX project rather than a folder of figures.
 */
export function isProjectFolder(files: File[]): boolean {
  const paths = files.map((file) => file.webkitRelativePath)
  if (paths.length === 0 || paths.some((path) => !path.includes('/'))) return false
  const top = paths[0].split('/')[0]
  return paths.every((path) => path.startsWith(`${top}/`)) && paths.includes(`${top}/${MAIN_FILE}`)
}

export async function importFiles(session: Session, files: File[]): Promise<ImportSummary> {
  // A project folder's contents go to the project root (its main.tex becomes
  // the project's main.tex). Any other folder keeps its name, so uploading
  // "figures" yields "figures/disks.pdf".
  const stripTop = isProjectFolder(files)
  const candidates: Candidate[] = files.map((file) => {
    const relative = file.webkitRelativePath || file.name
    return { file, relative: stripTop ? relative.slice(relative.indexOf('/') + 1) : relative }
  })

  const summary: ImportSummary = { added: [], unsupported: 0, failed: [] }
  for (const { file, relative } of candidates) {
    const path = normalizePath(relative)
    if (!path) {
      summary.unsupported++
      continue
    }
    try {
      if (fileKind(path) === 'text') {
        if (file.size > MAX_TEXT_BYTES) throw new Error('Text files are limited to 1 MB')
        session.writeTextFile(path, await file.text())
      } else {
        if (file.size > MAX_ASSET_BYTES) throw new Error('Figures are limited to 10 MB')
        await session.uploadAsset(path, file)
      }
      summary.added.push(path)
    } catch (err) {
      summary.failed.push({ name: relative, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return summary
}

export function describeImport(summary: ImportSummary): string {
  const parts: string[] = []
  const count = summary.added.length
  if (count > 0) parts.push(`Added ${count} ${count === 1 ? 'file' : 'files'}.`)
  if (summary.unsupported > 0) {
    parts.push(`Skipped ${summary.unsupported} that are not LaTeX sources or figures.`)
  }
  for (const failure of summary.failed) parts.push(`${failure.name}: ${failure.reason}.`)
  return parts.join(' ') || 'Nothing to add.'
}
