// Rules for what a project may contain. Shared by the server and the web app
// so both agree, but only the server's checks are a security boundary: file
// names arrive from browsers and end up as paths on the server's disk.

/** The file pdflatex is run on. */
export const MAIN_FILE = 'main.tex'

/** Keys inside the shared Y.Doc. */
export const FILES_KEY = 'files' // Y.Map<Y.Text>: collaboratively edited text files
export const ASSETS_KEY = 'assets' // Y.Map<AssetInfo>: uploaded figures (metadata only)

export const MAX_FILES = 300
export const MAX_TEXT_BYTES = 1024 * 1024
export const MAX_ASSET_BYTES = 10 * 1024 * 1024
export const MAX_PROJECT_ASSET_BYTES = 50 * 1024 * 1024

export type FileKind = 'text' | 'asset'

export interface AssetInfo {
  size: number
}

const TEXT_EXTENSIONS = new Set(['tex', 'sty', 'cls', 'bib', 'bst', 'tikz', 'txt'])
const ASSET_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg'])

// One path segment: no slashes, colons or leading dots, so "..", hidden
// files, drive letters and absolute paths can never be expressed.
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/
// Device names Windows refuses to create, with or without an extension.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const MAX_DEPTH = 6
const MAX_PATH_LENGTH = 200

export function fileKind(path: string): FileKind | null {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  const extension = path.slice(dot + 1).toLowerCase()
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  if (ASSET_EXTENSIONS.has(extension)) return 'asset'
  return null
}

/**
 * Turns user input into a canonical project path ("figures/disks.pdf"), or
 * null if it is not an acceptable one.
 */
export function normalizePath(input: string): string | null {
  const path = input.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return null
  const segments = path.split('/')
  if (segments.length > MAX_DEPTH) return null
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment.endsWith('.')) return null
    if (WINDOWS_RESERVED.test(segment.split('.')[0])) return null
  }
  // The compiler writes its output here.
  if (path.toLowerCase() === 'main.pdf') return null
  return fileKind(path) ? path : null
}

/** True if `path` is already in canonical form. */
export function isValidPath(path: string): boolean {
  return normalizePath(path) === path
}

/** Whether the first bytes of an upload match what its extension claims. */
export function matchesFileType(path: string, bytes: Uint8Array): boolean {
  const startsWith = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte)
  switch (path.slice(path.lastIndexOf('.') + 1).toLowerCase()) {
    case 'pdf':
      return startsWith(0x25, 0x50, 0x44, 0x46, 0x2d) // %PDF-
    case 'png':
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    case 'jpg':
    case 'jpeg':
      return startsWith(0xff, 0xd8, 0xff)
    default:
      return false
  }
}
