import type { ResolvedConfig } from './config.js'
import type { Caveat, DiffResult } from './diff.js'
import type { Bytes, Delta } from './types.js'

/**
 * Decide what to show and whether to fail.
 *
 * Two ideas, both learned the hard way by every size check that got switched
 * off in its first fortnight.
 *
 * **A noise floor.** Swift compilation is not byte-reproducible: two builds of
 * one commit differ by a few KB, and a check that calls that a regression is
 * noise by construction. Sub-floor rows are aggregated, still visible, and
 * never gated on.
 *
 * **A ratchet, not an absolute.** The gate is what *this branch* added. An
 * absolute ceiling exists as an option, because the 200 MB cellular threshold
 * is a real cliff worth guarding, but it is off by default -- an absolute gate
 * fails on the first pull request of a mature app and gets removed.
 */

export interface Verdict {
  /** Rows large enough to name individually, biggest growth first. */
  named: Delta[]
  /** Rows below the noise floor, aggregated into one line. */
  noise: { count: number; downloadDelta: Bytes; installDelta: Bytes }
  /** Growth that shrank, shown as credit. Never gates. */
  shrunk: Delta[]
  /** The allowance this run was measured against. */
  allowance: Bytes
  /** True when the gate was not applied, because the comparison is untrustworthy. */
  gated: boolean
  passed: boolean
  /** Why the gate did not apply, when it did not. */
  blockingCaveats: Caveat[]
  /** Set when an absolute ceiling is configured and exceeded. */
  overTotal?: { total: Bytes; actual: Bytes }
}

/**
 * The per-PR allowance: the larger of the absolute and the proportional budget.
 *
 * Percent alone under-protects a small app and over-protects a large one;
 * absolute alone does the reverse. Taking the larger means a 2 MB app is not
 * gated at 10 KB and a 200 MB app is not gated at 100 KB.
 */
export function allowanceFor(config: ResolvedConfig, baselineDownload: Bytes): Bytes {
  const proportional = Math.round((baselineDownload * config.budget.increasePercent) / 100)
  return Math.max(config.budget.increase, proportional)
}

export function judge(diff: DiffResult, config: ResolvedConfig): Verdict {
  const floor = config.noiseFloor

  // Significance is about magnitude, not direction. Sorting shrinks into the
  // noise bucket regardless of size would label a 285 KB deletion as "below the
  // 8 KB noise floor", and would count it both there and in the credit line.
  const significant = diff.deltas.filter(
    (delta) => delta.apportionmentOnly !== true && Math.abs(delta.downloadDelta) >= floor,
  )
  const named = significant.filter((delta) => delta.downloadDelta > 0)
  const shrunk = significant
    .filter((delta) => delta.downloadDelta < 0)
    .sort((a, b) => a.downloadDelta - b.downloadDelta)

  // Only genuinely small movement is aggregated. named + shrunk + noise is the
  // headline delta, exactly, which is what lets the report show one table whose
  // column adds up to its own total.
  const rest = diff.deltas.filter((delta) => !significant.includes(delta))
  const noise = {
    count: rest.length,
    downloadDelta: rest.reduce((total, delta) => total + delta.downloadDelta, 0),
    installDelta: rest.reduce((total, delta) => total + delta.installDelta, 0),
  }

  const allowance = allowanceFor(config, diff.totals.beforeDownload)
  const blockingCaveats = diff.caveats.filter((caveat) => caveat.blocksGate)
  const gated = blockingCaveats.length === 0

  const overTotal =
    config.budget.total !== undefined && diff.totals.afterDownload > config.budget.total
      ? { total: config.budget.total, actual: diff.totals.afterDownload }
      : undefined

  // An untrustworthy comparison reports and passes. The alternative -- failing
  // a pull request on a number the tool itself does not stand behind -- teaches
  // reviewers to ignore the check, which costs more than the missed regression.
  const withinAllowance = diff.totals.downloadDelta <= allowance
  const passed = gated ? withinAllowance && overTotal === undefined : true

  return {
    named,
    noise,
    shrunk,
    allowance,
    gated,
    passed,
    blockingCaveats,
    ...(overTotal === undefined ? {} : { overTotal }),
  }
}

/**
 * Rows to show above the fold, and how many were held back.
 *
 * The rest go in a collapsed block rather than being dropped: a reviewer who
 * wants the full list should not have to re-run anything to get it.
 */
export function splitForDisplay(
  named: Delta[],
  limit: number,
): { shown: Delta[]; hidden: Delta[] } {
  return { shown: named.slice(0, limit), hidden: named.slice(limit) }
}
