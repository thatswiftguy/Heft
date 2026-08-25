import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allowanceFor, judge, splitForDisplay } from '../src/core/budget.js'
import { defaultConfig, parseConfig } from '../src/core/config.js'
import { diffManifests } from '../src/core/diff.js'
import { parseManifest } from '../src/core/manifest.js'
import type { Manifest } from '../src/core/types.js'

const dir = join(import.meta.dirname, 'fixtures/manifests')
const load = (name: string): Manifest =>
  parseManifest(readFileSync(join(dir, `${name}.json`), 'utf8'), name)

const base = load('base')

describe('diffManifests', () => {
  const diff = diffManifests(base, load('head'))
  const row = (label: string) => diff.deltas.find((delta) => delta.label === label)

  it('names the dependency bump as the cause, not the framework growth', () => {
    const lottie = row('Lottie.framework')
    expect(lottie?.cause.kind).toBe('dependency')
    expect(lottie?.cause.detail).toBe('dependency `4.3.0 → 4.4.1`')
    expect(lottie?.downloadDelta).toBe(184_000)
  })

  it('collapses a framework binary and its resources into one row', () => {
    // Lottie contributes a binary and an Info.plist; they are one event.
    expect(diff.deltas.filter((delta) => delta.label === 'Lottie.framework')).toHaveLength(1)
    expect(row('Lottie.framework')?.collapsed).toContain('Frameworks/Lottie.framework/Info.plist')
  })

  it('names a new asset with its scale', () => {
    const hero = row('onboarding-hero @3x')
    expect(hero?.cause.detail).toBe('new asset')
    expect(hero?.downloadDelta).toBe(96_000)
  })

  it('names a new loose resource', () => {
    expect(row('Onboarding.json')?.cause.detail).toBe('new resource')
  })

  it('reports a shrink as a negative delta', () => {
    expect(row('Alamofire.framework')?.downloadDelta).toBe(-41_000)
  })

  it('sorts biggest growth first, so the actionable row is at the top', () => {
    expect(diff.deltas[0]?.label).toBe('Lottie.framework')
    expect(diff.deltas[1]?.label).toBe('onboarding-hero @3x')
  })

  it('points a dependency row at the lockfile line that changed', () => {
    expect(row('Lottie.framework')?.location).toEqual({ file: 'Package.resolved', line: 7 })
  })

  it('gives an unchanged pin no location to annotate', () => {
    expect(row('Alamofire.framework')?.location).toBeUndefined()
  })

  it('reports the headline totals', () => {
    expect(diff.totals.downloadDelta).toBe(184_000 + 96_000 + 21_000 + 3_000 - 41_000)
  })

  it('balances the ledger exactly', () => {
    expect(diff.reconciliation).toBe(0)
    const summed = diff.deltas.reduce((total, delta) => total + delta.downloadDelta, 0)
    expect(summed).toBe(diff.totals.downloadDelta)
  })

  it('has no caveats when both sides match', () => {
    expect(diff.caveats).toEqual([])
  })
})

describe('diffManifests on a no-op change', () => {
  const diff = diffManifests(base, load('noop'))

  it('reports nothing at all', () => {
    expect(diff.deltas).toEqual([])
    expect(diff.totals.downloadDelta).toBe(0)
    expect(diff.reconciliation).toBe(0)
  })
})

describe('diffManifests on a pure shrink', () => {
  const diff = diffManifests(base, load('shrink'))

  it('reports the removal as a credit and still balances', () => {
    expect(diff.deltas).toHaveLength(1)
    expect(diff.deltas[0]?.cause.detail).toBe('asset removed')
    expect(diff.deltas[0]?.downloadDelta).toBe(-285_000)
    expect(diff.reconciliation).toBe(0)
  })
})

describe('caveats', () => {
  it('refuses to gate across toolchains, and says why', () => {
    const diff = diffManifests(base, load('toolchain-mismatch'))
    const caveat = diff.caveats.find((entry) => entry.kind === 'fingerprint')
    expect(caveat?.blocksGate).toBe(true)
    expect(caveat?.message).toContain('16C5032a')
    expect(caveat?.message).toContain('17F113')
  })

  it('refuses to gate across variants, which are different devices', () => {
    const diff = diffManifests(base, load('variant-mismatch'))
    const caveat = diff.caveats.find((entry) => entry.kind === 'variant')
    expect(caveat?.blocksGate).toBe(true)
    expect(caveat?.message).toContain('iPad13,1')
  })

  it('compares a catalog whole when only one side was broken down', () => {
    // Without alignment this would read as "every image deleted, one big
    // Assets.car added" -- a fabricated swing in both directions.
    const diff = diffManifests(base, load('opaque-catalog'))
    const fabricated = diff.deltas.filter((delta) => delta.label.startsWith('hero'))
    expect(fabricated).toEqual([])
    expect(diff.caveats.find((entry) => entry.kind === 'capabilities')).toBeDefined()
    expect(diff.reconciliation).toBe(0)
  })

  it('does not block the gate merely for comparing a catalog whole', () => {
    const diff = diffManifests(base, load('opaque-catalog'))
    expect(diff.caveats.find((entry) => entry.kind === 'capabilities')?.blocksGate).toBe(false)
  })
})

describe('the reconciliation invariant holds for every fixture pair', () => {
  const names = ['base', 'head', 'noop', 'opaque-catalog', 'shrink', 'toolchain-mismatch', 'variant-mismatch', 'apportionment-drift', 'multi-rendition']
  for (const left of names) {
    for (const right of names) {
      it(`${left} -> ${right}`, () => {
        const diff = diffManifests(load(left), load(right))
        const summed = diff.deltas.reduce((total, delta) => total + delta.downloadDelta, 0)
        expect(summed).toBe(diff.totals.downloadDelta)
        expect(diff.reconciliation).toBe(0)
      })
    }
  }
})

describe('allowanceFor', () => {
  it('takes the larger of the absolute and proportional budgets', () => {
    const config = defaultConfig()
    // Small app: the 100 KB absolute wins over 0.5% of 2 MB.
    expect(allowanceFor(config, 2_000_000)).toBe(100_000)
    // Large app: 0.5% of 200 MB wins over 100 KB.
    expect(allowanceFor(config, 200_000_000)).toBe(1_000_000)
  })
})

describe('judge', () => {
  const diff = diffManifests(base, load('head'))

  it('names rows above the noise floor and aggregates the rest', () => {
    const verdict = judge(diff, defaultConfig())
    expect(verdict.named.map((delta) => delta.label)).toEqual([
      'Lottie.framework',
      'onboarding-hero @3x',
      'Onboarding.json',
    ])
    // Only the 3 KB binary change is noise. The 41 KB Alamofire shrink is well
    // above the floor and gets its own row rather than being called noise.
    expect(verdict.noise.count).toBe(1)
    expect(verdict.noise.downloadDelta).toBe(3_000)
  })

  it('balances: named plus shrunk plus noise is the headline delta', () => {
    const verdict = judge(diff, defaultConfig())
    const sum = (deltas: { downloadDelta: number }[]): number =>
      deltas.reduce((total, delta) => total + delta.downloadDelta, 0)
    expect(sum(verdict.named) + sum(verdict.shrunk) + verdict.noise.downloadDelta).toBe(
      diff.totals.downloadDelta,
    )
  })

  it('never files a significant shrink as noise', () => {
    // A 285 KB deletion is not "below the 8 KB noise floor".
    const verdict = judge(diffManifests(base, load('shrink')), defaultConfig())
    expect(verdict.noise.count).toBe(0)
    expect(verdict.shrunk).toHaveLength(1)
  })

  it('fails when growth exceeds the allowance', () => {
    const verdict = judge(diff, defaultConfig())
    expect(verdict.allowance).toBe(100_000)
    expect(verdict.passed).toBe(false)
  })

  it('passes when the allowance is raised above the growth', () => {
    expect(judge(diff, parseConfig('budget:\n  increase: 500KB\n')).passed).toBe(true)
  })

  it('credits what shrank without gating on it', () => {
    const verdict = judge(diff, defaultConfig())
    expect(verdict.shrunk.map((delta) => delta.label)).toEqual(['Alamofire.framework'])
  })

  it('passes a no-op', () => {
    expect(judge(diffManifests(base, load('noop')), defaultConfig()).passed).toBe(true)
  })

  it('passes a shrink', () => {
    expect(judge(diffManifests(base, load('shrink')), defaultConfig()).passed).toBe(true)
  })

  it('reports without gating when the toolchain differs', () => {
    const verdict = judge(diffManifests(base, load('toolchain-mismatch')), defaultConfig())
    expect(verdict.gated).toBe(false)
    // Same growth as the gated case, but it must not fail the pull request.
    expect(verdict.passed).toBe(true)
    expect(verdict.blockingCaveats).toHaveLength(1)
  })

  it('applies an absolute ceiling when one is configured', () => {
    const verdict = judge(diff, parseConfig('budget:\n  increase: 1MB\n  total: 4MB\n'))
    expect(verdict.overTotal).toEqual({ total: 4_000_000, actual: diff.totals.afterDownload })
    expect(verdict.passed).toBe(false)
  })

  it('does not apply a ceiling that is not configured', () => {
    expect(judge(diff, defaultConfig()).overTotal).toBeUndefined()
  })

  it('respects a raised noise floor', () => {
    const verdict = judge(diff, parseConfig('noiseFloor: 100KB\n'))
    expect(verdict.named.map((delta) => delta.label)).toEqual(['Lottie.framework'])
  })
})

describe('splitForDisplay', () => {
  it('holds the tail back rather than dropping it', () => {
    const diff = diffManifests(base, load('head'))
    const { named } = judge(diff, defaultConfig())
    const { shown, hidden } = splitForDisplay(named, 2)
    expect(shown).toHaveLength(2)
    expect(hidden).toHaveLength(1)
    expect([...shown, ...hidden]).toEqual(named)
  })
})

describe('apportionment drift', () => {
  it('is never itemised as a change to a file nobody touched', () => {
    // Download bytes are a share of a total, so when the total moves every
    // share moves. That is arithmetic, not a regression.
    const diff = diffManifests(base, load('apportionment-drift'))
    expect(diff.deltas.every((delta) => delta.apportionmentOnly === true)).toBe(true)
    const verdict = judge(diff, defaultConfig())
    expect(verdict.named).toEqual([])
    expect(verdict.shrunk).toEqual([])
  })

  it('keeps its bytes in the ledger rather than discarding them', () => {
    const diff = diffManifests(base, load('apportionment-drift'))
    const verdict = judge(diff, defaultConfig())
    expect(verdict.noise.downloadDelta).toBe(diff.totals.downloadDelta)
  })

  it('does not suppress a real change that happens to be small', () => {
    // The app binary moves 3 KB of install and 3 KB of download: real, small.
    const diff = diffManifests(base, load('head'))
    const binary = diff.deltas.find((delta) => delta.label === 'MyApp')
    expect(binary?.apportionmentOnly).toBeUndefined()
    expect(binary?.installDelta).toBe(6_000)
  })

  it('treats a download-only change as real when the ipa measured it', () => {
    const measured = { ...load('base'), capabilities: { ...load('base').capabilities, zipSizes: true } }
    const head = { ...load('apportionment-drift'), capabilities: { ...load('base').capabilities, zipSizes: true } }
    const diff = diffManifests(measured, head)
    expect(diff.deltas.some((delta) => delta.apportionmentOnly === true)).toBe(false)
  })
})

describe('asset renditions collapse onto the asset', () => {
  const diff = diffManifests(base, load('multi-rendition'))

  it('reports one new image as one row, not four', () => {
    const rows = diff.deltas.filter((delta) => delta.label === 'illustration')
    expect(rows).toHaveLength(1)
    expect(diff.deltas).toHaveLength(1)
  })

  it('says how many renditions moved, so the row does not understate it', () => {
    expect(diff.deltas[0]?.cause.detail).toBe('new asset, 4 renditions')
  })

  it('drops the scale from the label, since the row covers every scale', () => {
    expect(diff.deltas[0]?.label).toBe('illustration')
  })

  it('sums every rendition into the one row', () => {
    expect(diff.deltas[0]?.downloadDelta).toBe(74_000 + 240_000 + 480_000 + 1_140_000)
    expect(diff.reconciliation).toBe(0)
  })

  it('keeps a single-rendition change labelled with its scale', () => {
    const single = diffManifests(base, load('head'))
    expect(single.deltas.find((delta) => delta.label === 'onboarding-hero @3x')).toBeDefined()
  })

  it('does not collapse different assets in the same catalog together', () => {
    const shrink = diffManifests(base, load('shrink'))
    expect(shrink.deltas.every((delta) => delta.label !== 'icon')).toBe(true)
  })
})
