import {
  buildLedger,
  bytes,
  code,
  deltaCell,
  headline,
  renderBudget,
  renderCaveats,
  renderContributorsTable,
  renderLedgerTable,
  renderProvenance,
  renderTotalsTable,
  table,
  type ReportInput,
} from './model.js'

/**
 * The job summary: the same report, untruncated, plus the full change list.
 *
 * This is the surface that still works on a fork pull request, where the token
 * is read-only and no comment can be posted. It is deliberately the most
 * complete of the three rather than the least.
 */
export function renderSummary(input: ReportInput): string {
  const { verdict } = input
  const lines: string[] = [
    `## ⚖️ heft — ${input.absoluteOnly ? 'baseline recorded' : verdict.passed ? 'passed' : 'failed'}`,
    '',
    headline(input),
    '',
    renderTotalsTable(input),
    '',
  ]

  const budget = renderBudget(input)
  if (budget !== '') lines.push(budget, '')

  const ledger = renderLedgerTable(buildLedger(verdict, input.config))
  if (ledger !== '') lines.push('### What changed', '', ledger, '')

  if (verdict.shrunk.length > 0) {
    lines.push(
      '### What shrank',
      '',
      renderContributorsTable(verdict.shrunk),
      '',
    )
  }

  // Every row, including sub-floor movement, so nothing is only ever hidden.
  if (input.diff.deltas.length > 0) {
    lines.push(
      '<details><summary>Every change</summary>',
      '',
      table(
        ['What', 'Why', 'Before', 'After', 'Δ download', 'Δ install'],
        input.diff.deltas.map((delta) => [
          code(delta.label),
          delta.cause.detail,
          delta.beforeDownload === undefined ? '—' : bytes(delta.beforeDownload),
          delta.afterDownload === undefined ? '—' : bytes(delta.afterDownload),
          deltaCell(delta.downloadDelta),
          deltaCell(delta.installDelta),
        ]),
      ),
      '',
      '</details>',
      '',
    )
  }

  const caveats = renderCaveats(input.diff.caveats)
  if (caveats !== '') lines.push(caveats, '')

  lines.push(`<sub>${renderProvenance(input).join(' · ')}</sub>`)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

/** Shown instead of a report when the run could not measure anything. */
export function renderFailure(message: string): string {
  return ['## ⚖️ heft — could not run', '', message].join('\n')
}
