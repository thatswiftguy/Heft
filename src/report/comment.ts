import {
  buildLedger,
  bytes,
  headline,
  renderBudget,
  renderCaveats,
  renderLedgerTable,
  renderProvenance,
  renderTotalsTable,
  signedBytes,
  type ReportInput,
} from './model.js'

/**
 * Hidden marker used to find our own comment on re-runs.
 *
 * The comment is sticky: we search the pull request for this marker and PATCH
 * the comment carrying it, so a branch with twenty pushes has one comment
 * rather than twenty.
 */
export const COMMENT_MARKER = '<!-- heft -->'

/** GitHub rejects comment bodies over 65536 characters. Leave headroom. */
export const MAX_COMMENT_LENGTH = 60_000

export function renderComment(input: ReportInput): string {
  const { verdict, config } = input
  const status = input.absoluteOnly
    ? '**baseline recorded**'
    : verdict.passed
      ? '**passed**'
      : '**failed**'

  const lines: string[] = [`### ⚖️ heft — ${status}`, '', headline(input), '']

  lines.push(renderTotalsTable(input), '')

  const budget = renderBudget(input)
  if (budget !== '') lines.push(budget, '')

  // One table, whose Δ column sums to the headline. Anything held back for
  // length appears as an aggregate row carrying its own subtotal.
  //
  // Skipped with no baseline: there are no deltas to show, and a table of
  // changes against nothing would be inventing a comparison.
  if (input.absoluteOnly !== true) {
    const ledger = renderLedgerTable(buildLedger(verdict, config))
    if (ledger !== '') lines.push(ledger, '')
  }

  const caveats = renderCaveats(input.diff.caveats)
  if (caveats !== '') lines.push(caveats, '')

  lines.push(footer(input))
  return truncate(lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd())
}

function footer(input: ReportInput): string {
  const parts = renderProvenance(input)
  if (input.annotationsDropped !== undefined && input.annotationsDropped > 0) {
    parts.push(`${input.annotationsDropped} annotations not shown inline — see the job summary`)
  }
  return `<sub>${parts.join(' · ')} · ${COMMENT_MARKER}</sub>`
}

/**
 * Trim an over-long body without losing the marker, which is what makes the
 * comment sticky -- a truncated body that dropped it would orphan the comment
 * and post a fresh one on every push.
 */
export function truncate(body: string, limit = MAX_COMMENT_LENGTH): string {
  if (body.length <= limit) return body

  const notice = '\n\n_Report truncated._\n'
  const marker = body.endsWith('</sub>') ? `\n<sub>${COMMENT_MARKER}</sub>` : `\n${COMMENT_MARKER}`
  const room = limit - notice.length - marker.length
  return `${body.slice(0, Math.max(0, room)).trimEnd()}${notice}${marker}`
}

export function isOurComment(body: string | undefined | null): boolean {
  return typeof body === 'string' && body.includes(COMMENT_MARKER)
}

/** One-line status for a check-run title or a log line. */
export function summaryLine(input: ReportInput): string {
  const { downloadDelta } = input.diff.totals
  if (input.absoluteOnly) return `download size ${bytes(input.diff.totals.afterDownload)}`
  if (downloadDelta === 0) return 'no change in download size'
  return `download size ${signedBytes(downloadDelta)}`
}
