import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { labelFor } from '../src/core/attribute.js'
import { judge } from '../src/core/budget.js'
import { defaultConfig, parseConfig, type ResolvedConfig } from '../src/core/config.js'
import { diffManifests } from '../src/core/diff.js'
import { parseManifest } from '../src/core/manifest.js'
import { planAnnotations } from '../src/report/annotations.js'
import {
  COMMENT_MARKER,
  isOurComment,
  renderComment,
  summaryLine,
  truncate,
} from '../src/report/comment.js'
import { baseRefLabel, buildLedger, bytes, code, percent, signedBytes } from '../src/report/model.js'
import type { ReportInput } from '../src/report/model.js'
import { renderSummary } from '../src/report/summary.js'
import type { Manifest } from '../src/core/types.js'

const dir = join(import.meta.dirname, 'fixtures/manifests')
const load = (name: string): Manifest =>
  parseManifest(readFileSync(join(dir, `${name}.json`), 'utf8'), name)

function input(
  headName: string,
  options: { config?: ResolvedConfig; baseName?: string } & Partial<ReportInput> = {},
): ReportInput {
  const { config = defaultConfig(), baseName = 'base', ...rest } = options
  const head = load(headName)
  const diff = diffManifests(load(baseName), head)
  return {
    diff,
    verdict: judge(diff, config),
    config,
    manifest: head,
    baseline: { commit: 'aaaaaaa1234567', how: 'merge base' },
    baseRef: 'main',
    ...rest,
  }
}

describe('bytes', () => {
  it('uses decimal units, matching what the App Store shows', () => {
    expect(bytes(999)).toBe('999 B')
    expect(bytes(1_000)).toBe('1 KB')
    expect(bytes(312_000)).toBe('312 KB')
    expect(bytes(21_400_000)).toBe('21.4 MB')
    expect(bytes(4_000_000_000)).toBe('4 GB')
  })

  it('drops a trailing .0', () => {
    expect(bytes(2_000_000)).toBe('2 MB')
  })
})

describe('signedBytes and percent', () => {
  it('signs a delta and renders zero as a dash', () => {
    expect(signedBytes(312_000)).toBe('+312 KB')
    expect(signedBytes(-41_000)).toBe('−41 KB')
    expect(signedBytes(0)).toBe('—')
  })

  it('reports a percentage against the baseline', () => {
    expect(percent(1_000_000, 1_014_000)).toBe('+1.4%')
    expect(percent(1_000_000, 986_000)).toBe('−1.4%')
    expect(percent(1_000_000, 1_000_000)).toBe('±0%')
    expect(percent(0, 100)).toBe('new')
  })
})

describe('code', () => {
  it('escapes a pipe so a path cannot break the table', () => {
    expect(code('weird|name')).toBe('`weird\\|name`')
  })

  it('switches fences for a value containing a backtick', () => {
    expect(code('a`b')).toBe('``a`b``')
  })
})

describe('the ledger table always balances', () => {
  const names = ['head', 'noop', 'shrink', 'opaque-catalog', 'toolchain-mismatch', 'apportionment-drift']
  for (const name of names) {
    it(`${name} — rows sum to the headline`, () => {
      const report = input(name)
      const rows = buildLedger(report.verdict, report.config)
      const summed = rows.reduce((total, row) => total + row.downloadDelta, 0)
      expect(summed).toBe(report.diff.totals.downloadDelta)
    })
  }

  it('holds back the tail as an aggregate row rather than dropping it', () => {
    const report = input('head', { config: parseConfig('topContributors: 1\n') })
    const rows = buildLedger(report.verdict, report.config)
    expect(rows.some((row) => row.aggregate === true && /smaller increase/.test(row.what))).toBe(
      true,
    )
    const summed = rows.reduce((total, row) => total + row.downloadDelta, 0)
    expect(summed).toBe(report.diff.totals.downloadDelta)
  })

  it('does not call a large shrink noise', () => {
    // A 285 KB deletion is not "below the 8 KB noise floor".
    const rows = buildLedger(input('shrink').verdict, defaultConfig())
    const noiseRow = rows.find((row) => /noise floor/.test(row.why))
    expect(noiseRow).toBeUndefined()
    expect(rows[0]?.downloadDelta).toBe(-285_000)
  })

  it('reports a shrink exactly once, as its own row', () => {
    const body = renderComment(input('head'))
    expect(body.match(/Alamofire\.framework/g)).toHaveLength(1)
    // And it is not swept into the noise aggregate.
    expect(body).not.toMatch(/2 changes \| below the 8 KB noise floor/)
  })

  it('shows no change table when there is no baseline to compare against', () => {
    const body = renderComment(
      input('head', { absoluteOnly: true, baseline: { how: 'none found' } }),
    )
    expect(body).not.toContain('Δ download')
    expect(body).not.toContain('Lottie.framework')
    expect(body).toContain('No baseline to compare against yet')
  })
})

describe('renderComment', () => {
  it('renders a dependency-driven regression', () => {
    expect(renderComment(input('head'))).toMatchSnapshot()
  })

  it('renders a clean run', () => {
    expect(renderComment(input('noop'))).toMatchSnapshot()
  })

  it('renders a pure improvement', () => {
    expect(renderComment(input('shrink'))).toMatchSnapshot()
  })

  it('renders a toolchain mismatch as reporting-only', () => {
    expect(renderComment(input('toolchain-mismatch'))).toMatchSnapshot()
  })

  it('renders a first run with no baseline', () => {
    expect(
      renderComment(input('head', { absoluteOnly: true, baseline: { how: 'none found' } })),
    ).toMatchSnapshot()
  })

  it('names the cause in the first sentence, not just a number', () => {
    const body = renderComment(input('head'))
    const firstSentence = body.split('\n').filter(Boolean)[1] ?? ''
    expect(firstSentence).toContain('lottie-ios')
    expect(firstSentence).toContain('4.3.0 → 4.4.1')
  })

  it('frames the gate as a budget', () => {
    expect(renderComment(input('head'))).toMatch(/Budget: \*\*\+263 KB\*\* against \*\*\+100 KB\*\*/)
  })

  it('says download bytes are apportioned, never implying they are Apple’s', () => {
    expect(renderComment(input('head'))).toContain("apportioned from Xcode's reported total")
  })

  it('warns loudly when there was no thinning report to calibrate against', () => {
    const head = load('head')
    head.capabilities.thinningReport = false
    const diff = diffManifests(load('base'), head)
    const config = defaultConfig()
    const body = renderComment({
      diff,
      verdict: judge(diff, config),
      config,
      manifest: head,
      baseline: { commit: 'aaaaaaa', how: 'merge base' },
      baseRef: 'main',
    })
    expect(body).toContain('uncalibrated estimate')
  })

  it('carries the marker that makes the comment sticky', () => {
    expect(renderComment(input('head'))).toContain(COMMENT_MARKER)
    expect(isOurComment(renderComment(input('head')))).toBe(true)
  })
})

describe('truncate', () => {
  it('leaves a short body alone', () => {
    const body = renderComment(input('head'))
    expect(truncate(body)).toBe(body)
  })

  it('keeps the marker, so a long report does not orphan its comment', () => {
    const body = `${'x'.repeat(80_000)}\n<sub>${COMMENT_MARKER}</sub>`
    const trimmed = truncate(body, 1_000)
    expect(trimmed.length).toBeLessThanOrEqual(1_000)
    expect(isOurComment(trimmed)).toBe(true)
    expect(trimmed).toContain('_Report truncated._')
  })

  it('appends a bare marker when the body did not end in one', () => {
    expect(isOurComment(truncate('y'.repeat(5_000), 500))).toBe(true)
  })
})

describe('summaryLine', () => {
  it('is a one-liner fit for a log or a check title', () => {
    expect(summaryLine(input('head'))).toBe('download size +263 KB')
    expect(summaryLine(input('noop'))).toBe('no change in download size')
  })
})

describe('renderSummary', () => {
  it('itemises every change, including sub-floor movement', () => {
    const body = renderSummary(input('head'))
    expect(body).toContain('Every change')
    // The 3 KB binary wobble is named here even though the comment aggregates it.
    expect(body).toContain('MyApp')
  })

  it('renders the full report for a fork, where no comment can be posted', () => {
    expect(renderSummary(input('head'))).toMatchSnapshot()
  })
})

describe('planAnnotations', () => {
  it('annotates the lockfile line a version bump moved', () => {
    const report = input('head')
    const { annotations } = planAnnotations(report.diff.deltas, true)
    expect(annotations).toHaveLength(1)
    expect(annotations[0]).toMatchObject({
      level: 'warning',
      file: 'Package.resolved',
      line: 7,
    })
    expect(annotations[0]?.message).toContain('184 KB')
  })

  it('downgrades to a notice when the run is not gating', () => {
    const report = input('toolchain-mismatch')
    expect(planAnnotations(report.diff.deltas, false).annotations[0]?.level).toBe('notice')
  })

  it('does not annotate an asset, which has no line worth pointing at', () => {
    const report = input('head')
    const { annotations } = planAnnotations(report.diff.deltas, true)
    expect(annotations.some((annotation) => annotation.message.includes('onboarding-hero'))).toBe(
      false,
    )
  })

  it('caps at ten per level and reports what it held back', () => {
    const report = input('head')
    const many = Array.from({ length: 14 }, (_, index) => ({
      ...report.diff.deltas[0]!,
      label: `Dep${index}.framework`,
    }))
    const plan = planAnnotations(many, true)
    expect(plan.annotations).toHaveLength(10)
    expect(plan.totalDropped).toBe(4)
  })
})

describe('baseRefLabel', () => {
  it('shows a branch name as written', () => {
    expect(baseRefLabel('main')).toBe('`main`')
    expect(baseRefLabel('release/2.4')).toBe('`release/2.4`')
  })

  it('abbreviates a raw commit sha, which is unreadable in a sentence', () => {
    expect(baseRefLabel('05a17ab4b07b7b9b86529fd815e3d25f21d3a3a8')).toBe('`05a17ab`')
  })

  it('falls back when there is no base ref', () => {
    expect(baseRefLabel(undefined)).toBe('the base branch')
  })
})

describe('labelling renditions that carry no scale', () => {
  it('names the kind, so a vector asset called "2" is identifiable', () => {
    // Seen on a real app: a catalog of numbered vector illustrations produces
    // rows labelled `1`, `2`, `6` -- unactionable without the kind.
    expect(
      labelFor({
        id: 'Assets.car#2//',
        path: 'Assets.car',
        category: 'asset',
        installBytes: 12_045_000,
        downloadBytes: 11_400_000,
        rendition: { name: '2', idiom: 'universal', kind: 'Vector' },
      }),
    ).toBe('2 (Vector)')
  })

  it('leaves a scaled image alone', () => {
    expect(
      labelFor({
        id: 'Assets.car#hero/3x/universal/',
        path: 'Assets.car',
        category: 'asset',
        installBytes: 1,
        downloadBytes: 1,
        rendition: { name: 'hero', scale: 3, idiom: 'universal', kind: 'Image' },
      }),
    ).toBe('hero @3x')
  })

  it('still flags a non-default idiom', () => {
    expect(
      labelFor({
        id: 'Assets.car#hero/2x/ipad/',
        path: 'Assets.car',
        category: 'asset',
        installBytes: 1,
        downloadBytes: 1,
        rendition: { name: 'hero', scale: 2, idiom: 'ipad', kind: 'Image' },
      }),
    ).toBe('hero @2x (ipad)')
  })
})
