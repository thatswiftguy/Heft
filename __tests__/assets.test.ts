import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCatalog,
  parseAssetutilOutput,
  readCatalog,
  renditionId,
  type AssetRendition,
} from '../src/core/assets.js'

const dir = join(import.meta.dirname, 'fixtures/assetutil')
const fixture = (name: string): string => readFileSync(join(dir, name), 'utf8')
const REAL_CAR_BYTES = Number(fixture('xcode26-packed.carsize').trim())

function catalogFrom(name: string, carBytes = REAL_CAR_BYTES) {
  const elements = parseAssetutilOutput(fixture(name))
  expect(elements).toBeDefined()
  return buildCatalog(elements!, carBytes)
}

describe('parseAssetutilOutput', () => {
  it('parses real Xcode 26 output', () => {
    const elements = parseAssetutilOutput(fixture('xcode26-packed.json'))
    expect(elements).toHaveLength(12)
  })

  it('finds the array even when a diagnostic is printed ahead of it', () => {
    // The documented real-world failure: strict JSON.parse of the whole stream
    // throws, so the array has to be located first.
    expect(() => JSON.parse(fixture('noisy-prefix.json'))).toThrow()
    expect(parseAssetutilOutput(fixture('noisy-prefix.json'))).toHaveLength(12)
  })

  it('returns undefined for output that is not a JSON array at all', () => {
    expect(parseAssetutilOutput(fixture('unparseable.json'))).toBeUndefined()
    expect(parseAssetutilOutput('')).toBeUndefined()
  })
})

describe('buildCatalog on real packed output', () => {
  it('drops the header element and keeps only renditions', () => {
    const catalog = catalogFrom('xcode26-packed.json')
    expect(catalog.storageVersion).toContain('Xcode 26.6')
    expect(catalog.renditions.every((rendition) => rendition.name !== undefined)).toBe(true)
  })

  it('does not report ZZZZPackedAsset sheets as if they were assets', () => {
    // Naming an internal Xcode artifact in the report is the failure this
    // whole module exists to avoid.
    const catalog = catalogFrom('xcode26-packed.json')
    expect(catalog.renditions.some((rendition) => rendition.name.startsWith('ZZZZPacked'))).toBe(
      false,
    )
  })

  it('pushes packed bytes back onto the images that went into the sheet', () => {
    const catalog = catalogFrom('xcode26-packed.json')
    const hero3x = catalog.renditions.find(
      (rendition) => rendition.name === 'onboarding-hero' && rendition.scale === 3,
    )
    // assetutil reported a ~330 byte stub; the real pixels were in the sheet.
    expect(hero3x?.reportedBytes).toBe(330)
    expect(hero3x?.sizeOnDisk).toBeGreaterThan(50_000)
  })

  it('apportions by pixel area, so the big image takes the bigger share', () => {
    const catalog = catalogFrom('xcode26-packed.json')
    const at = (name: string, scale: number): AssetRendition | undefined =>
      catalog.renditions.find((r) => r.name === name && r.scale === scale)
    // onboarding-hero is 60pt, settings-icon is 16pt, at every scale.
    expect(at('onboarding-hero', 3)!.sizeOnDisk).toBeGreaterThan(at('settings-icon', 3)!.sizeOnDisk)
  })

  it('loses no packed bytes to rounding', () => {
    const catalog = catalogFrom('xcode26-packed.json')
    const elements = parseAssetutilOutput(fixture('xcode26-packed.json'))!
    const reported = elements
      .filter((element) => element['AssetType'] !== undefined)
      .reduce((total, element) => total + (element['SizeOnDisk'] as number), 0)
    // Apportionment moves bytes between renditions; it never creates or
    // destroys them.
    expect(catalog.attributedBytes).toBe(reported)
  })

  it('reports catalog overhead rather than hiding it', () => {
    const catalog = catalogFrom('xcode26-packed.json')
    expect(catalog.overheadBytes).toBe(REAL_CAR_BYTES - catalog.attributedBytes)
    expect(catalog.overheadBytes).toBeGreaterThan(0)
  })

  it('closes the ledger against the real .car file size', () => {
    const catalog = catalogFrom('xcode26-packed.json')
    expect(catalog.attributedBytes + catalog.overheadBytes).toBe(REAL_CAR_BYTES)
  })

  it('never reports negative overhead if the dump and the file disagree', () => {
    expect(catalogFrom('xcode26-packed.json', 1_000).overheadBytes).toBe(0)
  })
})

describe('buildCatalog on appearances and idioms', () => {
  it('keeps a dark-mode variant as its own rendition', () => {
    const catalog = catalogFrom('appearances.json', 300_000)
    const dark = catalog.renditions.find(
      (rendition) => rendition.appearance === 'UIAppearanceDark',
    )
    expect(dark?.sizeOnDisk).toBe(38_000)
  })

  it('keeps per-idiom variants separate', () => {
    const catalog = catalogFrom('appearances.json', 300_000)
    expect(catalog.renditions.filter((rendition) => rendition.idiom === 'ipad')).toHaveLength(1)
  })

  it('keeps the app icon, which has no pixel dimensions', () => {
    const catalog = catalogFrom('appearances.json', 300_000)
    expect(
      catalog.renditions.find((rendition) => rendition.kind === 'Icon Image')?.sizeOnDisk,
    ).toBe(120_000)
  })
})

describe('renditionId', () => {
  const base: AssetRendition = { name: 'hero', reportedBytes: 0, sizeOnDisk: 0 }

  it('separates scales, so a new @3x is an addition not a change', () => {
    expect(renditionId('Assets.car', { ...base, scale: 2 })).not.toBe(
      renditionId('Assets.car', { ...base, scale: 3 }),
    )
  })

  it('separates appearances, so dark mode is its own cost', () => {
    expect(renditionId('Assets.car', { ...base, appearance: 'UIAppearanceDark' })).not.toBe(
      renditionId('Assets.car', base),
    )
  })

  it('separates catalogs, so a nested extension does not collide with the app', () => {
    expect(renditionId('Assets.car', base)).not.toBe(
      renditionId('PlugIns/Widget.appex/Assets.car', base),
    )
  })
})

describe('readCatalog', () => {
  it('returns undefined when the file is not a readable catalog', () => {
    expect(readCatalog(join(dir, 'unparseable.json'), 100)).toBeUndefined()
  })
})
