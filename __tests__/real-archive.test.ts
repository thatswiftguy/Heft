import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { judge } from '../src/core/budget.js'
import { defaultConfig } from '../src/core/config.js'
import { diffManifests } from '../src/core/diff.js'
import { parseManifest } from '../src/core/manifest.js'
import type { DiffResult } from '../src/core/diff.js'
import type { Verdict } from '../src/core/budget.js'
import type { Manifest } from '../src/core/types.js'
import { renderComment } from '../src/report/comment.js'
import { buildLedger } from '../src/report/model.js'

/**
 * Exercises the diff at real scale against manifests captured from a genuine
 * app -- thousands of asset renditions rather than a hand-written handful.
 *
 * Captures are far too large to commit, so this runs only when pointed at a
 * pair. To use it against your own app:
 *
 *     HEFT_REAL_HEAD=head.json HEFT_REAL_BASE=base.json npm test
 *
 * It was developed against an 843 MB archive with 9044 entries, where it caught
 * both the rendition-collapsing and unscaled-label problems.
 */
const HEAD = process.env['HEFT_REAL_HEAD']
const BASE = process.env['HEFT_REAL_BASE']
const available = HEAD !== undefined && BASE !== undefined && existsSync(HEAD) && existsSync(BASE)

/**
 * Loaded lazily, inside the tests.
 *
 * `describe.skipIf` skips the tests but still runs the describe callback, so
 * reading the files at describe level throws during collection when the
 * captures are absent -- which is the normal case, including in CI.
 */
function load(): { diff: DiffResult; verdict: Verdict; head: Manifest } {
  const head = parseManifest(readFileSync(HEAD as string, 'utf8'), 'head')
  const base = parseManifest(readFileSync(BASE as string, 'utf8'), 'base')
  const diff = diffManifests(base, head)
  return { diff, verdict: judge(diff, defaultConfig()), head }
}

describe.skipIf(!available)('a real archive at scale', () => {
  it('has thousands of entries to compare', () => {
    expect(load().head.entries.length).toBeGreaterThan(5_000)
  })

  it('balances the ledger over thousands of renditions', () => {
    const { diff } = load()
    expect(diff.reconciliation).toBe(0)
    const summed = diff.deltas.reduce((total, delta) => total + delta.downloadDelta, 0)
    expect(summed).toBe(diff.totals.downloadDelta)
  })

  it('balances the displayed table too', () => {
    const { diff, verdict } = load()
    const rows = buildLedger(verdict, defaultConfig())
    expect(rows.reduce((total, row) => total + row.downloadDelta, 0)).toBe(
      diff.totals.downloadDelta,
    )
  })

  it('produces a readable number of rows, not one per rendition', () => {
    // The failure this guards: an app with thousands of renditions producing a
    // row for every scale of every changed image.
    expect(load().verdict.named.length).toBeLessThan(50)
  })

  it('keeps the comment short and inside the length limit', () => {
    const { diff, verdict, head } = load()
    const body = renderComment({
      diff,
      verdict,
      config: defaultConfig(),
      manifest: head,
      baseline: { commit: 'deadbee', how: 'merge base' },
      baseRef: 'main',
    })
    expect(body.length).toBeLessThan(60_000)
    expect(body.split('\n').length).toBeLessThan(40)
  })
})
