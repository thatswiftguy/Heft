import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classify, ownerOf, totalInstallBytes, walkArtifact, BundleError } from '../src/core/bundle.js'
import { createIgnoreMatchers, defaultConfig } from '../src/core/config.js'
import { buildSyntheticArchive, expectedTotal } from './helpers.js'

const ignoresPath = createIgnoreMatchers(defaultConfig()).ignoresPath

describe('classify', () => {
  it('calls the compiled catalog an asset', () => {
    expect(classify('Assets.car')).toBe('asset')
  })

  it('rolls everything under Frameworks up to framework', () => {
    expect(classify('Frameworks/Lottie.framework/Lottie')).toBe('framework')
    expect(classify('Frameworks/Lottie.framework/Info.plist')).toBe('framework')
    expect(classify('Frameworks/libswiftCore.dylib')).toBe('framework')
  })

  it('recognises the main executable at the bundle root', () => {
    expect(classify('MyApp', 'MyApp')).toBe('executable')
    expect(classify('SomeBinary')).toBe('executable')
  })

  it('recognises loose resources by extension and by container', () => {
    expect(classify('FeatureFlags.json')).toBe('resource')
    expect(classify('en.lproj/Localizable.strings')).toBe('resource')
    expect(classify('Media.bundle/thing.dat')).toBe('resource')
  })

  it('falls back to other for anything unrecognised', () => {
    expect(classify('weird.qqq')).toBe('other')
  })
})

describe('ownerOf', () => {
  it('is empty for files in the main app', () => {
    expect(ownerOf('Assets.car')).toBe('')
    expect(ownerOf('Frameworks/Lottie.framework/Lottie')).toBe('')
  })

  it('names the nested extension that owns a file', () => {
    expect(ownerOf('PlugIns/Widget.appex/Widget')).toBe('PlugIns/Widget.appex')
    expect(ownerOf('PlugIns/Widget.appex/Assets.car')).toBe('PlugIns/Widget.appex')
  })

  it('names an App Clip', () => {
    expect(ownerOf('AppClips/MyClip.app/MyClip')).toBe('AppClips/MyClip.app')
  })
})

describe('walkArtifact on an .xcarchive', () => {
  it('finds the app under Products/Applications', () => {
    const { archivePath } = buildSyntheticArchive()
    expect(walkArtifact(archivePath, { ignoresPath }).appName).toBe('MyApp.app')
  })

  it('excludes dSYMs, which are in the archive but never ship', () => {
    const { archivePath } = buildSyntheticArchive()
    const walked = walkArtifact(archivePath, { ignoresPath })
    expect(walked.files.some((file) => file.path.includes('.dSYM'))).toBe(false)
    // The 900 KB dSYM would dominate the app if it leaked in.
    expect(totalInstallBytes(walked.files)).toBeLessThan(900_000)
  })

  it('excludes the code signature', () => {
    const walked = walkArtifact(buildSyntheticArchive().archivePath, { ignoresPath })
    expect(walked.files.some((file) => file.path.includes('_CodeSignature'))).toBe(false)
  })

  it('counts a hardlinked pair once', () => {
    const walked = walkArtifact(buildSyntheticArchive().archivePath, { ignoresPath })
    const shared = walked.files.filter((file) => file.path.startsWith('Shared'))
    expect(shared).toHaveLength(1)
    expect(shared[0]?.installBytes).toBe(10_000)
  })

  it('does not count a symlinked framework alias as a second copy', () => {
    const walked = walkArtifact(buildSyntheticArchive().archivePath, { ignoresPath })
    expect(walked.files.some((file) => file.path.endsWith('Lottie.alias'))).toBe(false)
    expect(
      walked.files.find((file) => file.path === 'Frameworks/Lottie.framework/Lottie')?.installBytes,
    ).toBe(200_000)
  })

  it('attributes nested extension files to their owner', () => {
    const walked = walkArtifact(buildSyntheticArchive().archivePath, { ignoresPath })
    const widget = walked.files.filter((file) => file.owner === 'PlugIns/Widget.appex')
    expect(widget.map((file) => file.path).sort()).toEqual([
      'PlugIns/Widget.appex/Assets.car',
      'PlugIns/Widget.appex/Widget',
    ])
  })

  it('sums to exactly the bytes that ship', () => {
    const walked = walkArtifact(buildSyntheticArchive().archivePath, { ignoresPath })
    // 40000 main + 2000 Info + 120000 Assets + 5000 json + 3000 strings
    // + 200000 Lottie + 1000 Lottie Info + 150000 Alamofire + 300000 dylib
    // + 10000 hardlink pair (once) + 25000 Widget + 15000 Widget Assets
    expect(totalInstallBytes(walked.files)).toBe(expectedTotal())
  })

  it('names the accepted inputs when pointed at the wrong directory', () => {
    const empty = mkdtempSync(join(tmpdir(), 'heft-empty-'))
    expect(() => walkArtifact(empty, { ignoresPath })).toThrow(BundleError)
    expect(() => walkArtifact(empty, { ignoresPath })).toThrow(/not an \.app or an \.xcarchive/)
  })
})

describe('walkArtifact on a bare .app', () => {
  it('walks it directly', () => {
    const { appPath } = buildSyntheticArchive()
    const walked = walkArtifact(appPath, { ignoresPath })
    expect(walked.appName).toBe('MyApp.app')
    expect(totalInstallBytes(walked.files)).toBe(expectedTotal())
  })
})

describe('walkArtifact on an .ipa', () => {
  /** Repackage the synthetic app as an ipa, the way Xcode's export does. */
  function makeIpa(): string {
    const { appPath } = buildSyntheticArchive()
    const staging = mkdtempSync(join(tmpdir(), 'heft-ipa-'))
    execFileSync('mkdir', ['-p', join(staging, 'Payload')])
    execFileSync('cp', ['-R', appPath, join(staging, 'Payload')])
    const ipa = join(dirname(staging), `${Date.now()}-MyApp.ipa`)
    execFileSync('zip', ['-q', '-r', '-y', ipa, 'Payload'], { cwd: staging })
    return ipa
  }

  it('finds the app under Payload and reports the same install bytes', () => {
    const walked = walkArtifact(makeIpa(), { ignoresPath })
    expect(walked.appName).toBe('MyApp.app')
    expect(walked.fromZip).toBe(true)
    // `cp -R` turns the hardlink into two real files, so the ipa legitimately
    // carries both copies. Every other figure matches the directory walk.
    expect(totalInstallBytes(walked.files)).toBe(expectedTotal() + 10_000)
  })

  it('carries real compressed sizes, which is why an ipa is the better input', () => {
    const walked = walkArtifact(makeIpa(), { ignoresPath })
    const assets = walked.files.find((file) => file.path === 'Assets.car')
    expect(assets?.compressedBytes).toBeDefined()
    expect(assets?.compressedBytes).toBeLessThan(assets!.installBytes)
  })

  it('still excludes dSYMs and code signatures', () => {
    const walked = walkArtifact(makeIpa(), { ignoresPath })
    expect(walked.files.some((file) => file.path.includes('_CodeSignature'))).toBe(false)
    expect(walked.files.some((file) => file.path.includes('.dSYM'))).toBe(false)
  })
})
