import { describe, expect, it } from 'vitest'
import { fileKind, isValidPath, matchesFileType, normalizePath } from '../../shared/project.ts'

describe('project paths', () => {
  it('accepts ordinary source and figure paths', () => {
    expect(normalizePath('main.tex')).toBe('main.tex')
    expect(normalizePath('figures_tikz/disks.tex')).toBe('figures_tikz/disks.tex')
    expect(normalizePath('figures/shatter0.pdf')).toBe('figures/shatter0.pdf')
    expect(normalizePath('refs.bib')).toBe('refs.bib')
  })

  it('canonicalises separators and surrounding space', () => {
    expect(normalizePath('  figures\\disks.pdf ')).toBe('figures/disks.pdf')
    expect(normalizePath('./sections/intro.tex')).toBe('sections/intro.tex')
  })

  it.each([
    ['parent directory', '../secret.tex'],
    ['parent directory mid-path', 'figures/../../secret.tex'],
    ['absolute path', '/etc/passwd.tex'],
    ['drive letter', 'C:/Windows/win.tex'],
    ['UNC path', '//server/share/a.tex'],
    ['hidden file', '.git/config.tex'],
    ['empty segment', 'figures//a.tex'],
    ['trailing slash', 'figures/'],
    ['space in name', 'my file.tex'],
    ['Windows device name', 'aux.tex'],
    ['Windows device name in a folder', 'figures/NUL.pdf'],
    ['null byte', 'a\0.tex'],
    ['unsupported type', 'script.js'],
    ['no extension', 'Makefile'],
    ['the compiler output', 'main.pdf'],
    ['too deep', 'a/b/c/d/e/f/g.tex'],
    ['too long', `${'a'.repeat(250)}.tex`],
    ['empty', ''],
  ])('rejects %s', (_label, input) => {
    expect(normalizePath(input)).toBeNull()
    expect(isValidPath(input)).toBe(false)
  })

  it('classifies files by extension', () => {
    expect(fileKind('a.tex')).toBe('text')
    expect(fileKind('a.STY')).toBe('text')
    expect(fileKind('a.pdf')).toBe('asset')
    expect(fileKind('a.JPG')).toBe('asset')
    expect(fileKind('a.exe')).toBeNull()
  })

  it('checks that upload contents match the extension', () => {
    const bytes = (text: string) => new TextEncoder().encode(text)
    expect(matchesFileType('a.pdf', bytes('%PDF-1.5 ...'))).toBe(true)
    expect(matchesFileType('a.pdf', bytes('<html>'))).toBe(false)
    expect(matchesFileType('a.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
    expect(matchesFileType('a.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true)
    expect(matchesFileType('a.png', bytes('%PDF-1.5'))).toBe(false)
  })
})
