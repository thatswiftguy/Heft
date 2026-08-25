import { posix } from 'node:path'
import type { Bytes } from './types.js'

/**
 * Turn exact install bytes into download bytes that add up.
 *
 * The App Store recompresses and encrypts what it serves, so no number computed
 * on a build machine is Apple's download size. Rather than publish an
 * uncalibrated guess, this module apportions: each file gets a share of a total
 * that Xcode itself reported, so the column footer can say exactly what the
 * numbers are and the parts always sum to the whole.
 *
 * The estimate feeding the apportionment comes from one of two places:
 *
 * - **An `.ipa`.** The zip central directory records every member's compressed
 *   size. That is a measurement, and it makes the split between files real.
 * - **An `.xcarchive` or `.app`.** No compressed sizes exist yet, so a
 *   format-class ratio stands in. A PNG is already deflated and will not shrink
 *   again; a plist or a Mach-O binary will halve or better. Getting the
 *   *relative* weights roughly right is all this needs to do, because the
 *   absolute total is pinned separately.
 */

/**
 * Compressibility by format class.
 *
 * Ordered most-specific first. The values are deliberately coarse: they set the
 * relative weight of one file against another, and the total they scale to is
 * Xcode's, not theirs.
 */
const RATIOS: Array<{ test: RegExp; ratio: number }> = [
  // Already-compressed payloads. Recompressing these buys nothing, and
  // pretending otherwise would understate exactly the assets that dominate
  // most real regressions.
  { test: /\.(png|jpg|jpeg|heic|heif|webp|gif|mp3|mp4|m4a|m4v|mov|aac|zip|gz|woff2|jar|aar)$/i, ratio: 0.99 },
  // A compiled catalog holds renditions that are already deepmap-compressed.
  { test: /\.car$/i, ratio: 0.95 },
  // Core ML weights: partly float data, partly structure.
  { test: /\.(mlmodelc|mlmodel|espresso\.net|usdz|scn)$/i, ratio: 0.75 },
  { test: /\.(ttf|otf|woff)$/i, ratio: 0.55 },
  // Compiled interface files are binary plists.
  { test: /\.(nib|storyboardc|momd|omo)$/i, ratio: 0.5 },
  { test: /\.(json|plist|strings|stringsdict|xml|txt|md|html|css|js|csv|xcprivacy)$/i, ratio: 0.3 },
  { test: /\.(dylib|framework|a|o|metallib)$/i, ratio: 0.5 },
]

/** Mach-O binaries carry no extension, and they compress about 2:1. */
const BINARY_RATIO = 0.5
/** Anything unrecognised. Between text and incompressible. */
const DEFAULT_RATIO = 0.6

export function ratioFor(path: string): number {
  const name = posix.basename(path)
  for (const { test, ratio } of RATIOS) {
    if (test.test(name)) return ratio
  }
  // No extension at all: the app's or a framework's Mach-O binary.
  if (!name.includes('.')) return BINARY_RATIO
  return DEFAULT_RATIO
}

export interface Apportionable {
  /** Used to pick a format-class ratio when no measured size exists. */
  path: string
  installBytes: Bytes
  /** Measured compressed size, when the input was an `.ipa`. */
  compressedBytes?: Bytes
}

/**
 * Per-entry download bytes summing to exactly `targetTotal`.
 *
 * When `targetTotal` is undefined -- no thinning report was supplied -- the
 * estimates are returned unscaled and the caller must label them as an
 * uncalibrated estimate rather than as Xcode's figure.
 */
export function apportionDownloadBytes(
  entries: Apportionable[],
  targetTotal: Bytes | undefined,
): Bytes[] {
  const estimates = entries.map((entry) =>
    entry.compressedBytes !== undefined
      ? entry.compressedBytes
      : entry.installBytes * ratioFor(entry.path),
  )

  if (targetTotal === undefined) return estimates.map((estimate) => Math.round(estimate))

  const estimateTotal = estimates.reduce((total, estimate) => total + estimate, 0)
  if (estimateTotal <= 0 || targetTotal <= 0) return entries.map(() => 0)

  return distributeExactly(estimates, estimateTotal, targetTotal)
}

/**
 * Scale weights to a target and hand out the rounding remainder.
 *
 * Largest-remainder rather than plain rounding: rounding each entry
 * independently leaves the column not adding up to its own total, which is the
 * first thing a sceptical reviewer checks and the fastest way to lose them.
 */
function distributeExactly(weights: number[], weightTotal: number, target: Bytes): Bytes[] {
  const scaled = weights.map((weight) => (weight / weightTotal) * target)
  const floored = scaled.map((value) => Math.floor(value))
  let remainder = target - floored.reduce((total, value) => total + value, 0)

  // Hand the leftover bytes to the largest fractional parts, biggest first.
  const order = scaled
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)

  const result = [...floored]
  for (const { index } of order) {
    if (remainder <= 0) break
    result[index] = (result[index] ?? 0) + 1
    remainder -= 1
  }
  return result
}
