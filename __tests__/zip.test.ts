import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readZipEntries, ZipError } from '../src/core/zip.js'

/** Build a real zip with the system `zip`, so the parser faces real bytes. */
function makeZip(build: (root: string) => void, zipArgs: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'heft-zip-'))
  const root = join(dir, 'Payload')
  mkdirSync(root, { recursive: true })
  build(root)
  const archive = join(dir, 'app.ipa')
  execFileSync('zip', ['-q', '-r', '-y', ...zipArgs, archive, 'Payload'], { cwd: dir })
  return archive
}

describe('readZipEntries', () => {
  it('reports the compressed and uncompressed size of every member', () => {
    // Highly compressible content, so the two sizes are clearly different.
    const archive = makeZip((root) => {
      writeFileSync(join(root, 'compressible.json'), 'a'.repeat(50_000))
      writeFileSync(join(root, 'small.txt'), 'hello')
    })
    const entries = readZipEntries(archive)
    const json = entries.find((entry) => entry.name.endsWith('compressible.json'))
    expect(json?.uncompressedBytes).toBe(50_000)
    expect(json?.compressedBytes).toBeLessThan(1_000)
    expect(entries.find((entry) => entry.name.endsWith('small.txt'))?.uncompressedBytes).toBe(5)
  })

  it('flags symlinks, so they are not counted as their target', () => {
    const archive = makeZip((root) => {
      writeFileSync(join(root, 'real'), 'x'.repeat(1_000))
      symlinkSync('real', join(root, 'alias'))
    })
    const entries = readZipEntries(archive)
    expect(entries.find((entry) => entry.name.endsWith('/alias'))?.symlink).toBe(true)
    expect(entries.find((entry) => entry.name.endsWith('/real'))?.symlink).toBe(false)
  })

  it('flags directory members, which occupy no space', () => {
    const archive = makeZip((root) => {
      mkdirSync(join(root, 'Frameworks'))
      writeFileSync(join(root, 'Frameworks', 'a.dylib'), 'x')
    })
    const entries = readZipEntries(archive)
    expect(entries.some((entry) => entry.directory)).toBe(true)
    expect(entries.find((entry) => entry.name.endsWith('a.dylib'))?.directory).toBe(false)
  })

  it('finds the end record past a trailing archive comment', () => {
    const archive = makeZip((root) => {
      writeFileSync(join(root, 'a.txt'), 'hello')
    })
    // `zip -z` needs the comment on stdin.
    execFileSync('zip', ['-q', '-z', archive], { input: 'a comment that follows the EOCD\n' })
    expect(readZipEntries(archive).some((entry) => entry.name.endsWith('a.txt'))).toBe(true)
  })

  it('reads a zip64 archive, which a >4GB ipa requires', () => {
    const archive = makeZip((root) => {
      writeFileSync(join(root, 'a.txt'), 'hello')
    }, ['-fz'])
    expect(readZipEntries(archive).some((entry) => entry.name.endsWith('a.txt'))).toBe(true)
  })

  it('refuses a file that is not a zip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heft-zip-'))
    const bogus = join(dir, 'not.ipa')
    writeFileSync(bogus, 'x'.repeat(1_000))
    expect(() => readZipEntries(bogus)).toThrow(ZipError)
  })

  it('refuses a file too small to hold an end record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heft-zip-'))
    const tiny = join(dir, 'tiny.ipa')
    writeFileSync(tiny, 'x')
    expect(() => readZipEntries(tiny)).toThrow(/too small/)
  })
})
