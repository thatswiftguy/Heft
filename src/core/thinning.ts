import type { Bytes, Variant } from './types.js'

/**
 * Parser for Xcode's `App Thinning Size Report.txt`.
 *
 * Produced by `xcodebuild -exportArchive` when the export options plist carries
 * `thinning: <thin-for-all-variants>`. It is the only place a build machine can
 * get Apple's own view of compressed (download) versus uncompressed (install)
 * size without uploading anything.
 *
 * A worked example of the format:
 *
 *     App Thinning Size Report for All Variants of MyApp
 *
 *     Variant: MyApp-7433FC8E-1DF4-4299-A7E8-E00768671BEB.ipa
 *     Supported variant descriptors: [device: iPhone12,1, os-version: 13.0] and
 *     [device: iPhone11,8, os-version: 13.0]
 *     App + On Demand Resources size: 5.4 MB compressed, 13.7 MB uncompressed
 *     App size: 5.4 MB compressed, 13.7 MB uncompressed
 *     On Demand Resources size: Zero KB compressed, Zero KB uncompressed
 *
 * Three things about this format drive the design of everything downstream.
 *
 * **It is rounded to one decimal place.** `5.4 MB` means somewhere in
 * [5.35, 5.45) MB -- a +-50 KB band, which is wider than the default 100 KB
 * gate. So these totals are never used to measure a delta. Install bytes come
 * from the exact file walk, and this report contributes the compression
 * *ratio*, which is far better conditioned: the same ratio applies to both
 * sides of a diff, so it scales an exact install delta rather than adding its
 * own error to a subtraction of two coarse numbers.
 *
 * **The numbers are locale-formatted.** A build machine set to a European
 * locale writes `5,4 MB`. Reading that as `54` would inflate a report tenfold,
 * so both separators are accepted.
 *
 * **`Zero KB` is a literal.** Not `0 KB`.
 */

/** Thrown only when the file exists but contains no variant at all. */
export class ThinningReportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ThinningReportError'
  }
}

export interface ThinningVariant extends Variant {
  /** On Demand Resources, reported separately. Usually zero. */
  odrDownloadBytes: Bytes
  odrInstallBytes: Bytes
  /**
   * The raw strings, kept so the report can quote Xcode verbatim instead of
   * re-rendering a rounded number and implying precision it does not have.
   */
  raw: { download: string; install: string }
}

const UNITS: Record<string, number> = {
  bytes: 1,
  byte: 1,
  b: 1,
  kb: 1_000,
  mb: 1_000_000,
  gb: 1_000_000_000,
}

/**
 * Parse one size token, e.g. `5.4 MB`, `13,7 MB`, `Zero KB`, `912 bytes`.
 *
 * Returns undefined for anything unrecognised rather than throwing: one
 * unreadable line should cost that line, not the whole report.
 */
export function parseSize(token: string): Bytes | undefined {
  const text = token.trim()
  if (/^zero\b/i.test(text)) return 0

  // Accept both decimal separators. A European build machine writes "5,4 MB",
  // and reading that as 54 would overstate the app by 10x.
  const match = /^([\d]+(?:[.,]\d+)?)\s*([a-zA-Z]+)$/.exec(text)
  if (!match) return undefined
  const [, amount, unit] = match
  const multiplier = UNITS[(unit ?? '').toLowerCase()]
  if (multiplier === undefined) return undefined
  return Math.round(Number((amount ?? '').replace(',', '.')) * multiplier)
}

/** `5.4 MB compressed, 13.7 MB uncompressed` -> both figures. */
function parseSizePair(
  value: string,
): { download: Bytes; install: Bytes; raw: { download: string; install: string } } | undefined {
  const parts = value.split(',')
  // A locale using "," as the decimal separator makes the comma split ambiguous:
  // "5,4 MB compressed, 13,7 MB uncompressed" yields four parts, not two. Anchor
  // on the keywords instead of on position.
  const compressed = /([\d.,]+\s*[a-zA-Z]+|Zero\s+[a-zA-Z]+)\s+compressed/i.exec(value)
  const uncompressed = /([\d.,]+\s*[a-zA-Z]+|Zero\s+[a-zA-Z]+)\s+uncompressed/i.exec(value)
  if (!compressed || !uncompressed) {
    void parts
    return undefined
  }
  const rawDownload = (compressed[1] ?? '').trim()
  const rawInstall = (uncompressed[1] ?? '').trim()
  const download = parseSize(rawDownload)
  const install = parseSize(rawInstall)
  if (download === undefined || install === undefined) return undefined
  return { download, install, raw: { download: rawDownload, install: rawInstall } }
}

/** `[device: iPhone12,1, os-version: 13.0] and [device: iPhone11,8, ...]` -> models. */
export function parseDescriptors(value: string): string[] {
  const devices: string[] = []
  // Device models contain a comma (`iPhone12,1`), so the capture cannot stop at
  // the first one -- it has to run to `, os-version` or the closing bracket.
  for (const match of value.matchAll(/device:\s*([^\]]+?)(?:\s*,\s*os-version\s*:|\s*\])/gi)) {
    const device = (match[1] ?? '').trim()
    if (device) devices.push(device)
  }
  return devices
}

/**
 * Parse a whole report into its variants.
 *
 * Tolerant by design: unknown lines are skipped, a variant missing its `App
 * size:` line falls back to the `App + On Demand Resources` figure, and
 * descriptors may wrap across lines (Xcode wraps long ones).
 */
export function parseThinningReport(text: string): ThinningVariant[] {
  const variants: ThinningVariant[] = []
  let current: Partial<ThinningVariant> & { name?: string } = {}
  let combined: ReturnType<typeof parseSizePair>
  let descriptorBuffer: string | undefined

  const flush = (): void => {
    if (!current.name) return
    // Prefer the app-only figure; fall back to app+ODR when Xcode omitted it.
    const sizes =
      current.downloadBytes === undefined || current.installBytes === undefined
        ? combined
        : {
            download: current.downloadBytes,
            install: current.installBytes,
            raw: current.raw ?? { download: '', install: '' },
          }
    if (!sizes) {
      current = {}
      combined = undefined
      descriptorBuffer = undefined
      return
    }
    variants.push({
      name: current.name,
      ...(current.devices && current.devices.length > 0 ? { devices: current.devices } : {}),
      downloadBytes: sizes.download,
      installBytes: sizes.install,
      odrDownloadBytes: current.odrDownloadBytes ?? 0,
      odrInstallBytes: current.odrInstallBytes ?? 0,
      raw: sizes.raw,
    })
    current = {}
    combined = undefined
    descriptorBuffer = undefined
  }

  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue

    const variantMatch = /^Variant:\s*(.+)$/i.exec(trimmed)
    if (variantMatch) {
      flush()
      // Strip the .ipa suffix: the bare name is what a reviewer recognises and
      // what the config's `variant:` option is matched against.
      current = { name: (variantMatch[1] ?? '').trim().replace(/\.ipa$/i, '') }
      continue
    }

    const descriptorMatch = /^Supported variant descriptors:\s*(.*)$/i.exec(trimmed)
    if (descriptorMatch) {
      descriptorBuffer = descriptorMatch[1] ?? ''
      current.devices = parseDescriptors(descriptorBuffer)
      continue
    }

    // Xcode wraps long descriptor lists onto following lines.
    if (descriptorBuffer !== undefined && trimmed.startsWith('[device:')) {
      descriptorBuffer += ` ${trimmed}`
      current.devices = parseDescriptors(descriptorBuffer)
      continue
    }

    const odrMatch = /^On Demand Resources size:\s*(.+)$/i.exec(trimmed)
    if (odrMatch) {
      const sizes = parseSizePair(odrMatch[1] ?? '')
      if (sizes) {
        current.odrDownloadBytes = sizes.download
        current.odrInstallBytes = sizes.install
      }
      descriptorBuffer = undefined
      continue
    }

    const combinedMatch = /^App \+ On Demand Resources size:\s*(.+)$/i.exec(trimmed)
    if (combinedMatch) {
      combined = parseSizePair(combinedMatch[1] ?? '')
      descriptorBuffer = undefined
      continue
    }

    const appMatch = /^App size:\s*(.+)$/i.exec(trimmed)
    if (appMatch) {
      const sizes = parseSizePair(appMatch[1] ?? '')
      if (sizes) {
        current.downloadBytes = sizes.download
        current.installBytes = sizes.install
        current.raw = sizes.raw
      }
      descriptorBuffer = undefined
      continue
    }
  }
  flush()

  if (variants.length === 0) {
    throw new ThinningReportError(
      'no variants found -- is this an App Thinning Size Report? It is produced by ' +
        '`xcodebuild -exportArchive` when the export options plist sets ' +
        '`thinning` to `<thin-for-all-variants>`.',
    )
  }
  return variants
}

/**
 * Pick the variant every per-entry figure is apportioned against.
 *
 * `largest` means largest download, deliberately: it is the worst case, and the
 * only one the 200 MB cellular threshold actually bites on.
 */
export function selectVariant(
  variants: ThinningVariant[],
  requested: string,
): ThinningVariant | undefined {
  if (requested !== 'largest') {
    const exact = variants.find((variant) => variant.name === requested)
    if (exact) return exact
    // Match on device model too, so `variant: iPhone16,2` works without anyone
    // having to copy a UUID-laden variant name out of the report.
    return variants.find((variant) => variant.devices?.includes(requested))
  }
  return variants.reduce<ThinningVariant | undefined>(
    (best, variant) => (best === undefined || variant.downloadBytes > best.downloadBytes ? variant : best),
    undefined,
  )
}

/**
 * Compressed-to-uncompressed ratio for a variant.
 *
 * This, not the absolute totals, is what the report contributes downstream. The
 * totals are rounded to one decimal place; the ratio derived from them is good
 * to about a percent, and because it multiplies an exact install delta rather
 * than participating in a subtraction, that percent applies to the delta rather
 * than to the whole app.
 */
export function compressionRatio(variant: ThinningVariant): number {
  if (variant.installBytes <= 0) return 1
  return variant.downloadBytes / variant.installBytes
}
