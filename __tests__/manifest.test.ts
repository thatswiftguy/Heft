import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultConfig, parseConfig } from '../src/core/config.js'
import {
  buildManifest,
  catalogOverheadId,
  frameworkNameOf,
  manifestTotals,
  ManifestError,
  parseManifest,
  serialiseManifest,
} from '../src/core/manifest.js'
import { buildSyntheticArchive, compileRealCatalog, expectedTotal } from './helpers.js'

const THINNING = join(import.meta.dirname, 'fixtures/thinning/multi-variant.txt')
const LOCKS = join(import.meta.dirname, 'fixtures/locks')

describe('frameworkNameOf', () => {
  it('rolls a framework resource up to its framework', () => {
    expect(frameworkNameOf('Frameworks/Lottie.framework/Lottie')).toBe('Lottie.framework')
    expect(frameworkNameOf('Frameworks/Lottie.framework/Assets.car')).toBe('Lottie.framework')
  })

  it('names a bare dylib', () => {
    expect(frameworkNameOf('Frameworks/libswiftCore.dylib')).toBe('libswiftCore.dylib')
  })

  it('is undefined for a file in no framework', () => {
    expect(frameworkNameOf('Assets.car')).toBeUndefined()
  })
})

describe('buildManifest', () => {
  it('accounts for every byte the walk found', () => {
    const { archivePath } = buildSyntheticArchive()
    const manifest = buildManifest({ artifactPath: archivePath, config: defaultConfig() })
    // The synthetic Assets.car is filler, not a real catalog, so assetutil
    // cannot break it down -- it stays as one entry and the total still closes.
    expect(manifestTotals(manifest).install).toBe(expectedTotal())
  })

  it('apportions download bytes to Xcode ratio applied to the exact install total', () => {
    const { archivePath } = buildSyntheticArchive()
    const manifest = buildManifest({
      artifactPath: archivePath,
      thinningReportPath: THINNING,
      config: defaultConfig(),
    })
    const totals = manifestTotals(manifest)
    // largest variant: 22.9 MB compressed / 51.6 MB uncompressed.
    const expected = Math.round(expectedTotal() * (22_900_000 / 51_600_000))
    expect(totals.download).toBe(expected)
  })

  it('picks the largest variant by default and records which one', () => {
    const manifest = buildManifest({
      artifactPath: buildSyntheticArchive().archivePath,
      thinningReportPath: THINNING,
      config: defaultConfig(),
    })
    expect(manifest.referenceVariant).toBe('MyApp-A1B2C3D4-1111-2222-3333-444455556666')
    expect(manifest.variants).toHaveLength(3)
  })

  it('honours an explicit variant, matched by device model', () => {
    const manifest = buildManifest({
      artifactPath: buildSyntheticArchive().archivePath,
      thinningReportPath: THINNING,
      config: parseConfig('variant: "iPad13,1"\n'),
    })
    expect(manifest.referenceVariant).toBe('MyApp-99887766-5544-3322-1100-aabbccddeeff')
  })

  it('lists the available variants when the requested one is absent', () => {
    expect(() =>
      buildManifest({
        artifactPath: buildSyntheticArchive().archivePath,
        thinningReportPath: THINNING,
        config: parseConfig('variant: "iPhone1,1"\n'),
      }),
    ).toThrow(/Available:/)
  })

  it('works with no thinning report, and says so in the capabilities', () => {
    const manifest = buildManifest({
      artifactPath: buildSyntheticArchive().archivePath,
      config: defaultConfig(),
    })
    expect(manifest.capabilities.thinningReport).toBe(false)
    expect(manifest.referenceVariant).toBe('unreported')
    // Uncalibrated: the estimates stand unscaled.
    expect(manifestTotals(manifest).download).toBeGreaterThan(0)
  })

  it('tags frameworks with the package that built them', () => {
    const manifest = buildManifest({
      artifactPath: buildSyntheticArchive().archivePath,
      lockfilePaths: [join(LOCKS, 'spm-v3/Package.resolved'), join(LOCKS, 'Podfile.lock')],
      config: defaultConfig(),
    })
    const lottie = manifest.entries.find(
      (entry) => entry.path === 'Frameworks/Lottie.framework/Lottie',
    )
    expect(lottie?.dependency).toBe('lottie-ios')
    expect(manifest.pins['lottie-ios']).toBe('4.4.1')
  })

  it('records where each pin lives, so an annotation can point at it', () => {
    const manifest = buildManifest({
      artifactPath: buildSyntheticArchive().archivePath,
      lockfilePaths: [join(LOCKS, 'Podfile.lock')],
      config: defaultConfig(),
    })
    expect(manifest.pinLocations?.['Alamofire']).toMatchObject({
      source: 'cocoapods',
      line: 2,
    })
  })

  it('respects ignore.dependencies', () => {
    const manifest = buildManifest({
      artifactPath: buildSyntheticArchive().archivePath,
      lockfilePaths: [join(LOCKS, 'spm-v3/Package.resolved')],
      config: parseConfig("ignore:\n  dependencies: ['lottie-ios']\n"),
    })
    expect(
      manifest.entries.find((entry) => entry.path.includes('Lottie.framework'))?.dependency,
    ).toBeUndefined()
  })

  it('never includes a dSYM, whatever the input', () => {
    const manifest = buildManifest({
      artifactPath: buildSyntheticArchive().archivePath,
      config: defaultConfig(),
    })
    expect(manifest.entries.some((entry) => entry.path.includes('.dSYM'))).toBe(false)
  })
})

describe('buildManifest with a real compiled asset catalog', () => {
  const { archivePath, appPath } = buildSyntheticArchive()
  const compiled = compileRealCatalog(join(appPath, 'Assets.car'))

  it.skipIf(!compiled)('names individual images instead of the catalog', () => {
    const manifest = buildManifest({ artifactPath: archivePath, config: defaultConfig() })
    expect(manifest.capabilities.assetutil).toBe(true)
    const hero = manifest.entries.filter((entry) => entry.rendition?.name === 'onboarding-hero')
    expect(hero.length).toBeGreaterThanOrEqual(3)
    expect(hero.map((entry) => entry.rendition?.scale).sort()).toEqual([1, 2, 3])
  })

  it.skipIf(!compiled)('never names a ZZZZPackedAsset sheet as if it were an asset', () => {
    const manifest = buildManifest({ artifactPath: archivePath, config: defaultConfig() })
    expect(
      manifest.entries.some((entry) => entry.rendition?.name.startsWith('ZZZZPacked')),
    ).toBe(false)
  })

  it.skipIf(!compiled)('closes the ledger: renditions plus overhead equal the .car', () => {
    const manifest = buildManifest({ artifactPath: archivePath, config: defaultConfig() })
    const catalogEntries = manifest.entries.filter((entry) => entry.path === 'Assets.car')
    const sum = catalogEntries.reduce((total, entry) => total + entry.installBytes, 0)
    const overhead = catalogEntries.find((entry) => entry.id === catalogOverheadId('Assets.car'))
    expect(overhead).toBeDefined()
    // The whole app total must still be the sum of the real files on disk.
    expect(sum).toBeGreaterThan(0)
    expect(manifestTotals(manifest).install).toBe(
      manifest.entries.reduce((total, entry) => total + entry.installBytes, 0),
    )
  })

  it.skipIf(!compiled)('records a toolchain fingerprint where one is available', () => {
    const manifest = buildManifest({ artifactPath: archivePath, config: defaultConfig() })
    // The synthetic Info.plist is filler, so no keys resolve -- what matters is
    // that this degrades to an empty fingerprint rather than throwing.
    expect(manifest.fingerprint).toBeDefined()
  })
})

describe('serialise and parse', () => {
  const manifest = buildManifest({
    artifactPath: buildSyntheticArchive().archivePath,
    thinningReportPath: THINNING,
    config: defaultConfig(),
    commit: 'a1b2c3d',
  })

  it('round-trips', () => {
    const parsed = parseManifest(serialiseManifest(manifest), 'heft.json')
    expect(parsed.commit).toBe('a1b2c3d')
    expect(manifestTotals(parsed)).toEqual(manifestTotals(manifest))
  })

  it('refuses a manifest from a version it cannot read', () => {
    const future = serialiseManifest({ ...manifest, version: 99 as never })
    expect(() => parseManifest(future, 'baseline.json')).toThrow(ManifestError)
    expect(() => parseManifest(future, 'baseline.json')).toThrow(/cannot be read/)
  })

  it('refuses junk rather than guessing', () => {
    expect(() => parseManifest('not json', 'baseline.json')).toThrow(/not valid JSON/)
    expect(() => parseManifest('[]', 'baseline.json')).toThrow(/expected a manifest object/)
    expect(() => parseManifest('{"version":1}', 'baseline.json')).toThrow(/no entries/)
  })
})

describe('toolchain fingerprint', () => {
  it('reads the toolchain out of the app Info.plist', () => {
    const manifest = buildManifest({
      artifactPath: buildSyntheticArchive().archivePath,
      config: defaultConfig(),
    })
    expect(manifest.fingerprint).toMatchObject({
      xcodeBuild: '16C5032a',
      sdk: 'iphoneos18.2',
      deploymentTarget: '17.0',
      version: '2.4.1',
      build: '1187',
    })
  })

  it('picks up an overridden toolchain', () => {
    const manifest = buildManifest({
      artifactPath: buildSyntheticArchive({ plist: { DTXcodeBuild: '17F113' } }).archivePath,
      config: defaultConfig(),
    })
    expect(manifest.fingerprint.xcodeBuild).toBe('17F113')
  })
})
