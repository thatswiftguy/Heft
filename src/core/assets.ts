import { execFileSync } from 'node:child_process'
import type { Bytes, Rendition } from './types.js'

/**
 * Break a compiled `Assets.car` down into individual renditions via
 * `assetutil --info`.
 *
 * Without this, an asset catalog is one opaque multi-megabyte blob and the
 * report can only say "Assets.car grew 96 KB", which is barely better than
 * saying the app grew. With it, the report can name the image.
 *
 * Two things about `assetutil` shape this module.
 *
 * **Xcode packs small images into sheets.** Individual `Image` renditions come
 * back with a `SizeOnDisk` of a few hundred bytes -- a stub -- while the real
 * pixels live in `PackedImage` entries named `ZZZZPackedAsset-<scale>...`.
 * Reporting those verbatim would blame an internal Xcode artifact for a change
 * the developer made to *their* image, so packed bytes are apportioned back
 * across the images that went into the sheet, weighted by pixel area.
 *
 * **Its output is not reliably machine-readable.** Across Xcode versions it has
 * emitted diagnostics onto stdout ahead of the JSON. A strict parse of the
 * whole stream throws on those, so the array is located before it is parsed,
 * and a total failure degrades the catalog to one opaque entry rather than
 * failing the run.
 */

export interface AssetRendition extends Rendition {
  /** Bytes attributable to this rendition, after packed-sheet apportionment. */
  sizeOnDisk: Bytes
  /** `SizeOnDisk` exactly as `assetutil` reported it, before apportionment. */
  reportedBytes: Bytes
  /** Content hash, when present. Distinguishes a re-encode from a no-op. */
  sha1?: string
  /** `UIAppearanceDark` and friends. A dark variant is a separate rendition. */
  appearance?: string
  pixelWidth?: number
  pixelHeight?: number
}

export interface AssetCatalog {
  /** Renditions with real, apportioned sizes. Packed sheets are not included. */
  renditions: AssetRendition[]
  /** Sum of `sizeOnDisk` across renditions. */
  attributedBytes: Bytes
  /**
   * The catalog's own indexes and headers: the `.car` file size minus what the
   * renditions account for. Reported, never hidden -- a catalog is typically a
   * few percent overhead and the ledger has to close.
   */
  overheadBytes: Bytes
  /** Version string from the header, e.g. `Xcode 26.6 (17F113) ...`. */
  storageVersion?: string
}

/** Header keys that identify the leading non-rendition element. */
function isHeader(element: Record<string, unknown>): boolean {
  return element['AssetType'] === undefined
}

/** Packed sheets are named `ZZZZPackedAsset-<scale>.<version>-gamut<n>`. */
function isPacked(element: Record<string, unknown>): boolean {
  return element['AssetType'] === 'PackedImage'
}

/**
 * Locate and parse the JSON array in `assetutil` output.
 *
 * Returns undefined rather than throwing: a catalog we cannot read should cost
 * the breakdown, not the run.
 */
export function parseAssetutilOutput(output: string): Record<string, unknown>[] | undefined {
  const end = output.lastIndexOf(']')
  if (end === -1) return undefined

  for (const start of arrayStartCandidates(output, end)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(output.slice(start, end + 1))
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue
    return parsed.filter(
      (element): element is Record<string, unknown> =>
        typeof element === 'object' && element !== null && !Array.isArray(element),
    )
  }
  return undefined
}

/**
 * Candidate offsets for the start of the JSON array, best first.
 *
 * A diagnostic line printed ahead of the JSON commonly contains a bracket of
 * its own -- `assetutil[4123:99]` is the usual shape -- so the first `[` in the
 * stream is not necessarily the array. Brackets that open a line are tried
 * first, then any remaining ones, and the list is capped so that pathological
 * output cannot turn this into a quadratic parse.
 */
function arrayStartCandidates(output: string, end: number): number[] {
  const lineInitial: number[] = []
  const rest: number[] = []
  for (let index = 0; index < end; index += 1) {
    if (output[index] !== '[') continue
    const before = output.slice(0, index)
    const lineStart = before.lastIndexOf('\n') + 1
    if (before.slice(lineStart).trim() === '') lineInitial.push(index)
    else rest.push(index)
  }
  return [...lineInitial, ...rest].slice(0, 8)
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Turn parsed `assetutil` elements into renditions with real sizes.
 *
 * @param carBytes actual size of the `.car` file, used to compute overhead
 */
export function buildCatalog(
  elements: Record<string, unknown>[],
  carBytes: Bytes,
): AssetCatalog {
  const header = elements.find(isHeader)
  const entries = elements.filter((element) => !isHeader(element))

  const packed = entries.filter(isPacked)
  const renditionElements = entries.filter((element) => !isPacked(element))

  // Packed bytes are pooled per scale, because a sheet only ever contains
  // images of one scale -- that is what the `-<scale>.` in its name means.
  const packedByScale = new Map<number, Bytes>()
  for (const sheet of packed) {
    const scale = numberOf(sheet['Scale']) ?? 1
    packedByScale.set(scale, (packedByScale.get(scale) ?? 0) + (numberOf(sheet['SizeOnDisk']) ?? 0))
  }

  const renditions: AssetRendition[] = renditionElements.map((element) => {
    const scale = numberOf(element['Scale'])
    const pixelWidth = numberOf(element['PixelWidth'])
    const pixelHeight = numberOf(element['PixelHeight'])
    return {
      name: stringOf(element['Name']) ?? '(unnamed)',
      ...(scale === undefined ? {} : { scale }),
      ...(stringOf(element['Idiom']) === undefined ? {} : { idiom: stringOf(element['Idiom']) }),
      ...(stringOf(element['AssetType']) === undefined
        ? {}
        : { kind: stringOf(element['AssetType']) }),
      reportedBytes: numberOf(element['SizeOnDisk']) ?? 0,
      sizeOnDisk: numberOf(element['SizeOnDisk']) ?? 0,
      ...(stringOf(element['SHA1Digest']) === undefined
        ? {}
        : { sha1: stringOf(element['SHA1Digest']) }),
      ...(stringOf(element['Appearance']) === undefined
        ? {}
        : { appearance: stringOf(element['Appearance']) }),
      ...(pixelWidth === undefined ? {} : { pixelWidth }),
      ...(pixelHeight === undefined ? {} : { pixelHeight }),
    }
  })

  apportionPackedBytes(renditions, packedByScale)

  const attributedBytes = renditions.reduce((total, rendition) => total + rendition.sizeOnDisk, 0)
  return {
    renditions,
    attributedBytes,
    // Clamped at zero: apportionment is exact by construction, but a `.car`
    // read from a different build than the dump would otherwise go negative.
    overheadBytes: Math.max(0, carBytes - attributedBytes),
    ...(stringOf(header?.['AssetStorageVersion']) === undefined
      ? {}
      : { storageVersion: stringOf(header?.['AssetStorageVersion']) }),
  }
}

/**
 * Push each packed sheet's bytes back onto the images that went into it.
 *
 * Weighted by pixel area, which is the only proxy `assetutil` gives us for an
 * image's share of a texture atlas. It is an apportionment, not a measurement --
 * but "your 3x hero image is most of this sheet" is true and useful, whereas
 * "ZZZZPackedAsset-3.1.0-gamut0 grew" is neither.
 *
 * When no image at that scale has pixel dimensions, the sheet is split evenly
 * rather than dropped, so the bytes stay in the ledger.
 */
function apportionPackedBytes(
  renditions: AssetRendition[],
  packedByScale: Map<number, Bytes>,
): void {
  for (const [scale, sheetBytes] of packedByScale) {
    if (sheetBytes <= 0) continue
    const candidates = renditions.filter(
      (rendition) => rendition.scale === scale && rendition.kind === 'Image',
    )
    if (candidates.length === 0) continue

    const areas = candidates.map(
      (rendition) => (rendition.pixelWidth ?? 0) * (rendition.pixelHeight ?? 0),
    )
    const totalArea = areas.reduce((total, area) => total + area, 0)

    let distributed = 0
    candidates.forEach((rendition, index) => {
      const share =
        totalArea > 0 ? (areas[index] ?? 0) / totalArea : 1 / candidates.length
      // Give the last candidate the remainder so the sheet's bytes are neither
      // lost nor invented by rounding.
      const bytes =
        index === candidates.length - 1
          ? sheetBytes - distributed
          : Math.round(sheetBytes * share)
      distributed += bytes
      rendition.sizeOnDisk += bytes
    })
  }
}

/**
 * Run `assetutil --info` against a `.car` on disk.
 *
 * Returns undefined when the tool is missing (a non-macOS runner) or fails, so
 * the caller can degrade the catalog to one opaque entry and say so.
 */
export function runAssetutil(carPath: string): string | undefined {
  for (const command of [
    ['assetutil', ['--info', carPath]],
    ['xcrun', ['--sdk', 'iphoneos', 'assetutil', '--info', carPath]],
  ] as const) {
    try {
      return execFileSync(command[0], command[1], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      continue
    }
  }
  return undefined
}

/** Read and break down a `.car`, or return undefined if it cannot be read. */
export function readCatalog(carPath: string, carBytes: Bytes): AssetCatalog | undefined {
  const output = runAssetutil(carPath)
  if (output === undefined) return undefined
  const elements = parseAssetutilOutput(output)
  if (elements === undefined || elements.length === 0) return undefined
  const catalog = buildCatalog(elements, carBytes)
  return catalog.renditions.length === 0 ? undefined : catalog
}

/**
 * Identity of a rendition for diffing.
 *
 * Scale, idiom and appearance are all part of it: a `@3x` addition next to an
 * existing `@2x` is a new thing, not a change to the old one, and a dark-mode
 * variant is a separate cost from the light one.
 */
export function renditionId(catalogPath: string, rendition: AssetRendition): string {
  const parts = [
    rendition.name,
    rendition.scale === undefined ? '' : `${rendition.scale}x`,
    rendition.idiom ?? '',
    rendition.appearance ?? '',
  ]
  return `${catalogPath}#${parts.join('/')}`
}
