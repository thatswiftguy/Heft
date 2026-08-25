import type { Verdict } from '../core/budget.js'
import type { Caveat, DiffResult } from '../core/diff.js'
import type { ResolvedConfig } from '../core/config.js'
import type { Bytes, Delta, Manifest } from '../core/types.js'

/** Everything the reporting surfaces need, computed once by the caller. */
export interface ReportInput {
  diff: DiffResult
  verdict: Verdict
  config: ResolvedConfig
  /** Head manifest, for capability and variant provenance. */
  manifest: Manifest
  /** Commit the baseline came from, and how it was found. */
  baseline: {
    commit?: string
    /** `merge-base`, `walked back N commits`, ... shown verbatim in the footer. */
    how: string
  }
  /** Base branch name for display, e.g. `main`. */
  baseRef?: string
  /** True when no baseline was found and only absolute figures exist. */
  absoluteOnly?: boolean
  /** Annotations the per-level cap discarded. */
  annotationsDropped?: number
}

/** Inline code that survives a Markdown table cell. */
export function code(value: string): string {
  if (value === '') return '``'
  const fence = value.includes('`') ? '``' : '`'
  const padded = value.startsWith('`') || value.endsWith('`') ? ` ${value} ` : value
  return `${fence}${padded.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')}${fence}`
}

/**
 * Format a byte count the way Apple does: decimal units, one decimal place.
 *
 * Decimal because that is what the App Store shows and what the 200 MB
 * threshold means. Rendering 1 KB as 1024 bytes here would make the report
 * disagree with the number a reviewer can look up.
 */
export function bytes(value: Bytes): string {
  const magnitude = Math.abs(value)
  if (magnitude < 1_000) return `${value} B`
  if (magnitude < 1_000_000) return `${trim(value / 1_000)} KB`
  if (magnitude < 1_000_000_000) return `${trim(value / 1_000_000)} MB`
  return `${trim(value / 1_000_000_000)} GB`
}

function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** A signed byte count, for a delta column. */
export function signedBytes(value: Bytes): string {
  if (value === 0) return '—'
  return `${value > 0 ? '+' : '−'}${bytes(Math.abs(value))}`
}

/** A delta with its direction marker, e.g. `🔺 +312 KB`. */
export function deltaCell(value: Bytes): string {
  if (value === 0) return '—'
  return `${value > 0 ? '🔺' : '🔻'} ${signedBytes(value)}`
}

export function percent(before: Bytes, after: Bytes): string {
  if (before <= 0) return 'new'
  const change = ((after - before) / before) * 100
  if (Math.abs(change) < 0.05) return '±0%'
  return `${change > 0 ? '+' : '−'}${Math.abs(change).toFixed(1)}%`
}

export function pluralise(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n')
}

/** The download/install summary table. */
export function renderTotalsTable(input: ReportInput): string {
  const { totals } = input.diff
  if (input.absoluteOnly) {
    return table(
      ['', 'Size'],
      [
        ['**Download**', bytes(totals.afterDownload)],
        ['**Install**', bytes(totals.afterInstall)],
      ],
    )
  }
  return table(
    ['', 'Before', 'After', 'Δ'],
    [
      [
        '**Download**',
        bytes(totals.beforeDownload),
        bytes(totals.afterDownload),
        `${deltaCell(totals.downloadDelta)} (${percent(totals.beforeDownload, totals.afterDownload)})`,
      ],
      [
        '**Install**',
        bytes(totals.beforeInstall),
        bytes(totals.afterInstall),
        `${deltaCell(totals.installDelta)} (${percent(totals.beforeInstall, totals.afterInstall)})`,
      ],
    ],
  )
}

/** One row of the ledger table. */
export interface LedgerRow {
  what: string
  why: string
  downloadDelta: Bytes
  /** True for an aggregate row, which is not rendered as inline code. */
  aggregate?: boolean
}

/**
 * The rows of the contributors table, guaranteed to sum to the headline delta.
 *
 * This is the "ledger balances" promise made visible. Anything held back for
 * length becomes an explicit aggregate row carrying its own subtotal, so the
 * column a reviewer can add up in their head is the same number as the
 * headline. A table that does not reconcile gets checked once and disbelieved
 * from then on.
 */
export function buildLedger(verdict: Verdict, config: ResolvedConfig): LedgerRow[] {
  const rows: LedgerRow[] = []
  const limit = config.topContributors

  const shownGrowth = verdict.named.slice(0, limit)
  const hiddenGrowth = verdict.named.slice(limit)
  for (const delta of shownGrowth) {
    rows.push({ what: delta.label, why: delta.cause.detail, downloadDelta: delta.downloadDelta })
  }
  if (hiddenGrowth.length > 0) {
    rows.push({
      what: pluralise(hiddenGrowth.length, 'smaller increase'),
      why: 'itemised in the job summary',
      downloadDelta: hiddenGrowth.reduce((total, delta) => total + delta.downloadDelta, 0),
      aggregate: true,
    })
  }

  const shownShrinks = verdict.shrunk.slice(0, 3)
  const hiddenShrinks = verdict.shrunk.slice(3)
  for (const delta of shownShrinks) {
    rows.push({ what: delta.label, why: delta.cause.detail, downloadDelta: delta.downloadDelta })
  }
  if (hiddenShrinks.length > 0) {
    rows.push({
      what: pluralise(hiddenShrinks.length, 'smaller decrease'),
      why: 'itemised in the job summary',
      downloadDelta: hiddenShrinks.reduce((total, delta) => total + delta.downloadDelta, 0),
      aggregate: true,
    })
  }

  if (verdict.noise.count > 0) {
    rows.push({
      what: pluralise(verdict.noise.count, 'change'),
      why: `below the ${bytes(config.noiseFloor)} noise floor`,
      downloadDelta: verdict.noise.downloadDelta,
      aggregate: true,
    })
  }
  return rows
}

/**
 * The contributors table: what changed, why, and by how much.
 *
 * The `Why` column is the point of the whole tool. A path and a number is
 * something a reviewer has to go and investigate; a path, a number and
 * "dependency 4.3.0 -> 4.4.1" is the investigation already done.
 */
export function renderLedgerTable(rows: LedgerRow[]): string {
  if (rows.length === 0) return ''
  return table(
    ['What', 'Why', 'Δ download'],
    rows.map((row) => [
      row.aggregate === true ? row.what : code(row.what),
      row.why,
      deltaCell(row.downloadDelta),
    ]),
  )
}

/** A plain table of deltas, for the job summary's supplementary sections. */
export function renderContributorsTable(deltas: Delta[]): string {
  if (deltas.length === 0) return ''
  return table(
    ['What', 'Why', 'Δ download'],
    deltas.map((delta) => [code(delta.label), delta.cause.detail, deltaCell(delta.downloadDelta)]),
  )
}

/**
 * Display form of the base ref.
 *
 * A branch name is shown as written; a raw commit sha is abbreviated, because a
 * 40-character hex string in the middle of a sentence is unreadable.
 */
export function baseRefLabel(baseRef: string | undefined): string {
  if (baseRef === undefined) return 'the base branch'
  return code(/^[0-9a-f]{40}$/i.test(baseRef) ? baseRef.slice(0, 7) : baseRef)
}

/** A one-line headline naming the dominant cause. */
export function headline(input: ReportInput): string {
  const { totals } = input.diff
  const base = baseRefLabel(input.baseRef)

  if (input.absoluteOnly) {
    return `Download size **${bytes(totals.afterDownload)}**. No baseline to compare against yet.`
  }
  if (totals.downloadDelta === 0) {
    return `No change in download size vs ${base}.`
  }

  const direction = totals.downloadDelta > 0 ? 'Download size' : 'Download size'
  const magnitude = `**${signedBytes(totals.downloadDelta)}** (${percent(
    totals.beforeDownload,
    totals.afterDownload,
  )})`

  // Name the dominant cause in the first sentence. A number alone makes the
  // reader open the table; the cause is what they came for.
  const dominant = input.verdict.named[0]
  if (dominant === undefined || totals.downloadDelta < 0) {
    return `${direction} ${magnitude} vs ${base}.`
  }
  return `${direction} ${magnitude} vs ${base} — mostly ${describeCause(dominant)}.`
}

function describeCause(delta: Delta): string {
  const { cause } = delta
  if (cause.kind === 'dependency' && cause.from !== undefined && cause.to !== undefined) {
    return `**${cause.dependency} ${cause.from} → ${cause.to}**`
  }
  if (cause.kind === 'dependency' && cause.to !== undefined) {
    return `the new **${cause.dependency}** dependency`
  }
  return `**${delta.label}** (${cause.detail})`
}

/** The budget line, framed as a budget rather than as a bare comparison. */
export function renderBudget(input: ReportInput): string {
  const { verdict, diff } = input
  if (input.absoluteOnly) return ''

  const lines: string[] = []
  if (diff.totals.downloadDelta > 0) {
    const over = diff.totals.downloadDelta - verdict.allowance
    lines.push(
      over > 0
        ? `Budget: **${signedBytes(diff.totals.downloadDelta)}** against **${signedBytes(
            verdict.allowance,
          )}** allowed for one change — over by **${bytes(over)}**.`
        : `Budget: **${signedBytes(diff.totals.downloadDelta)}** of **${signedBytes(
            verdict.allowance,
          )}** allowed for one change.`,
    )
  }
  if (verdict.overTotal !== undefined) {
    lines.push(
      `Ceiling: **${bytes(verdict.overTotal.actual)}** exceeds the configured limit of ` +
        `**${bytes(verdict.overTotal.total)}**.`,
    )
  }
  return lines.join('\n\n')
}

/** Caveats, rendered so the reader knows what the numbers do and do not mean. */
export function renderCaveats(caveats: Caveat[]): string {
  if (caveats.length === 0) return ''
  return caveats.map((caveat) => `> [!NOTE]\n> ${caveat.message}`).join('\n\n')
}

/**
 * Provenance line.
 *
 * Says which variant, which baseline, and -- crucially -- where the download
 * numbers came from. An apportioned figure presented as Apple's would be a
 * quiet lie, and the one thing a size tool cannot recover from is being caught
 * overstating what it knows.
 */
export function renderProvenance(input: ReportInput): string[] {
  const parts: string[] = []
  const { capabilities, referenceVariant } = input.manifest

  if (referenceVariant !== 'unreported') parts.push(`variant ${code(referenceVariant)}`)
  if (input.baseline.commit !== undefined) {
    parts.push(`baseline ${code(input.baseline.commit.slice(0, 7))} (${input.baseline.how})`)
  }

  parts.push(
    capabilities.thinningReport
      ? capabilities.zipSizes
        ? "download bytes measured from the ipa, scaled to Xcode's reported total"
        : "download bytes apportioned from Xcode's reported total"
      : '**download bytes are an uncalibrated estimate** — no App Thinning Size Report was supplied',
  )
  if (!capabilities.assetutil) parts.push('asset catalogs not broken down')
  if (!capabilities.lockfiles) parts.push('no lockfile found, so dependencies are not named')
  if (!input.verdict.gated) parts.push('**reporting only, not gating**')

  return parts
}
