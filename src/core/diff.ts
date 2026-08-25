import { attribute, groupKeyOf, labelFor, locationFor } from './attribute.js'
import { diffPins, type PinChange } from './lockfiles.js'
import { manifestTotals } from './manifest.js'
import type { Bytes, Delta, Entry, Manifest } from './types.js'

/**
 * Compare two manifests.
 *
 * The one invariant this module owes the reader: **the ledger balances.** Every
 * byte of movement is either in a named row or in the aggregated remainder, and
 * the two sum to the reported total exactly. A size report whose column does not
 * add up to its own headline gets checked once and disbelieved thereafter.
 */

/** Why a comparison cannot be trusted enough to gate on. */
export type CaveatKind = 'fingerprint' | 'variant' | 'capabilities' | 'reconciliation'

export interface Caveat {
  kind: CaveatKind
  message: string
  /** True when this alone means the run must report without gating. */
  blocksGate: boolean
}

export interface DiffResult {
  deltas: Delta[]
  totals: {
    beforeDownload: Bytes
    afterDownload: Bytes
    beforeInstall: Bytes
    afterInstall: Bytes
    downloadDelta: Bytes
    installDelta: Bytes
  }
  /**
   * Sum of the per-row deltas minus the headline delta. Zero by construction;
   * surfaced rather than asserted so that a bug shows up in the report instead
   * of silently skewing it.
   */
  reconciliation: Bytes
  pinChanges: Map<string, PinChange>
  caveats: Caveat[]
}

export function diffManifests(before: Manifest, after: Manifest): DiffResult {
  const caveats: Caveat[] = []
  const { before: alignedBefore, after: alignedAfter, aligned } = alignCatalogs(before, after)
  if (aligned.length > 0) {
    caveats.push({
      kind: 'capabilities',
      message:
        `${aligned.length === 1 ? 'One asset catalog was' : `${aligned.length} asset catalogs were`} ` +
        'broken down on only one side of the comparison, so it is compared whole. ' +
        'Individual images are not named for it.',
      // Not gate-blocking: the totals are still right, only the detail is coarser.
      blocksGate: false,
    })
  }

  if (before.referenceVariant !== after.referenceVariant) {
    caveats.push({
      kind: 'variant',
      message:
        `the baseline was measured on variant \`${before.referenceVariant}\` and this build on ` +
        `\`${after.referenceVariant}\`. Those are different devices, so the difference is not a ` +
        'regression. Pin `variant:` in .heft.yml to compare like with like.',
      blocksGate: true,
    })
  }

  const fingerprintCaveat = compareFingerprints(before, after)
  if (fingerprintCaveat) caveats.push(fingerprintCaveat)

  const pinChanges = diffPins(before.pins ?? {}, after.pins ?? {})
  // With measured zip sizes a download-only change is real recompression. Without
  // them, download is derived from install, so install holding still means the
  // download movement is pure apportionment drift.
  const measuredCompression = before.capabilities?.zipSizes === true && after.capabilities?.zipSizes === true
  const deltas = buildDeltas(alignedBefore, alignedAfter, pinChanges, after, measuredCompression)

  const beforeTotals = manifestTotals({ ...before, entries: alignedBefore })
  const afterTotals = manifestTotals({ ...after, entries: alignedAfter })
  const downloadDelta = afterTotals.download - beforeTotals.download
  const installDelta = afterTotals.install - beforeTotals.install

  const summed = deltas.reduce((total, delta) => total + delta.downloadDelta, 0)
  const reconciliation = summed - downloadDelta
  if (reconciliation !== 0) {
    caveats.push({
      kind: 'reconciliation',
      message:
        `the itemised rows sum to ${summed} download bytes but the totals moved ${downloadDelta}. ` +
        'This is a bug in heft, not in your app -- please report it.',
      blocksGate: true,
    })
  }

  return {
    deltas,
    totals: {
      beforeDownload: beforeTotals.download,
      afterDownload: afterTotals.download,
      beforeInstall: beforeTotals.install,
      afterInstall: afterTotals.install,
      downloadDelta,
      installDelta,
    },
    reconciliation,
    pinChanges,
    caveats,
  }
}

/**
 * Put both sides on the same footing for every asset catalog.
 *
 * A catalog is either one opaque entry or a set of renditions, depending on
 * whether `assetutil` ran. Comparing an expanded side against an unexpanded one
 * would read as "every image deleted, one big Assets.car added" -- a fabricated
 * multi-megabyte swing in both directions. Where the two sides disagree, the
 * expanded one is collapsed back to a single entry so the comparison is honest,
 * if coarser.
 */
function alignCatalogs(
  before: Manifest,
  after: Manifest,
): { before: Entry[]; after: Entry[]; aligned: string[] } {
  const expandedIn = (manifest: Manifest): Set<string> => {
    const paths = new Set<string>()
    for (const entry of manifest.entries) {
      if (entry.category === 'asset' && entry.rendition !== undefined) paths.add(entry.path)
    }
    return paths
  }

  const beforeExpanded = expandedIn(before)
  const afterExpanded = expandedIn(after)
  const aligned = [
    ...[...beforeExpanded].filter((path) => !afterExpanded.has(path)),
    ...[...afterExpanded].filter((path) => !beforeExpanded.has(path)),
  ]
  if (aligned.length === 0) return { before: before.entries, after: after.entries, aligned }

  const toCollapse = new Set(aligned)
  return {
    before: collapseCatalogs(before.entries, toCollapse),
    after: collapseCatalogs(after.entries, toCollapse),
    aligned,
  }
}

function collapseCatalogs(entries: Entry[], paths: Set<string>): Entry[] {
  const kept: Entry[] = []
  const totals = new Map<string, { install: Bytes; download: Bytes }>()

  for (const entry of entries) {
    if (entry.category === 'asset' && paths.has(entry.path)) {
      const running = totals.get(entry.path) ?? { install: 0, download: 0 }
      running.install += entry.installBytes
      running.download += entry.downloadBytes
      totals.set(entry.path, running)
      continue
    }
    kept.push(entry)
  }

  for (const [path, running] of totals) {
    kept.push({
      id: path,
      path,
      category: 'asset',
      installBytes: running.install,
      downloadBytes: running.download,
    })
  }
  return kept
}

interface Group {
  key: string
  representative: Entry
  beforeDownload: Bytes
  afterDownload: Bytes
  beforeInstall: Bytes
  afterInstall: Bytes
  ids: string[]
  presentBefore: boolean
  presentAfter: boolean
}

function buildDeltas(
  before: Entry[],
  after: Entry[],
  pinChanges: Map<string, PinChange>,
  afterManifest: Manifest,
  measuredCompression: boolean,
): Delta[] {
  const groups = new Map<string, Group>()

  const upsert = (entry: Entry, side: 'before' | 'after'): void => {
    const key = groupKeyOf(entry)
    let group = groups.get(key)
    if (group === undefined) {
      group = {
        key,
        representative: entry,
        beforeDownload: 0,
        afterDownload: 0,
        beforeInstall: 0,
        afterInstall: 0,
        ids: [],
        presentBefore: false,
        presentAfter: false,
      }
      groups.set(key, group)
    }
    // The head side names the row: a renamed or re-pinned thing should read as
    // what it is now, not as what it used to be.
    if (side === 'after') group.representative = entry
    if (side === 'before') {
      group.beforeDownload += entry.downloadBytes
      group.beforeInstall += entry.installBytes
      group.presentBefore = true
    } else {
      group.afterDownload += entry.downloadBytes
      group.afterInstall += entry.installBytes
      group.presentAfter = true
    }
    if (!group.ids.includes(entry.id)) group.ids.push(entry.id)
  }

  for (const entry of before) upsert(entry, 'before')
  for (const entry of after) upsert(entry, 'after')

  const deltas: Delta[] = []
  for (const group of groups.values()) {
    const downloadDelta = group.afterDownload - group.beforeDownload
    const installDelta = group.afterInstall - group.beforeInstall
    if (downloadDelta === 0 && installDelta === 0) continue

    const added = !group.presentBefore
    const removed = !group.presentAfter
    const cause = attribute({
      entry: group.representative,
      category: group.representative.category,
      added,
      removed,
      pinChanges,
      renditions: group.ids.length,
    })
    const location = locationFor(cause, afterManifest.pinLocations)

    deltas.push({
      id: group.key,
      label: labelFor(group.representative, group.ids.length),
      category: group.representative.category,
      ...(group.presentBefore ? { beforeDownload: group.beforeDownload } : {}),
      ...(group.presentAfter ? { afterDownload: group.afterDownload } : {}),
      ...(group.presentBefore ? { beforeInstall: group.beforeInstall } : {}),
      ...(group.presentAfter ? { afterInstall: group.afterInstall } : {}),
      downloadDelta,
      installDelta,
      cause,
      ...(group.ids.length > 1 ? { collapsed: group.ids } : {}),
      ...(location === undefined ? {} : { location }),
      ...(installDelta === 0 && !measuredCompression ? { apportionmentOnly: true } : {}),
    })
  }

  // Biggest growth first: that is the order a reviewer wants to read, and it
  // puts the actionable row above the fold. Ties break on label for stability.
  deltas.sort(
    (a, b) => b.downloadDelta - a.downloadDelta || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  )
  return deltas
}

/**
 * Compare toolchains and say when the comparison cannot be gated on.
 *
 * Swift builds are not byte-reproducible, and a toolchain bump alone moves real
 * megabytes. Blaming that on a pull request is the single fastest way for a size
 * check to lose its reviewers, so a mismatch downgrades the run to reporting.
 */
function compareFingerprints(before: Manifest, after: Manifest): Caveat | undefined {
  const fields: Array<[keyof Manifest['fingerprint'], string]> = [
    ['xcodeBuild', 'Xcode build'],
    ['sdk', 'SDK'],
    ['swift', 'compiler'],
    ['deploymentTarget', 'deployment target'],
  ]

  const differences: string[] = []
  for (const [field, label] of fields) {
    const left = before.fingerprint?.[field]
    const right = after.fingerprint?.[field]
    if (typeof left !== 'string' || typeof right !== 'string') continue
    if (left !== right) differences.push(`${label} \`${left}\` → \`${right}\``)
  }

  const leftArches = before.fingerprint?.architectures?.join(',')
  const rightArches = after.fingerprint?.architectures?.join(',')
  if (leftArches !== undefined && rightArches !== undefined && leftArches !== rightArches) {
    differences.push(`architectures \`${leftArches}\` → \`${rightArches}\``)
  }

  if (differences.length === 0) return undefined
  return {
    kind: 'fingerprint',
    message:
      `the two builds used different toolchains (${differences.join(', ')}). A toolchain change ` +
      'moves size on its own, so this difference is reported but not gated on.',
    blocksGate: true,
  }
}
