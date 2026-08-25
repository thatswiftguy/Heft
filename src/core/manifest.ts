import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import picomatch from 'picomatch'
import { readCatalog, renditionId, type AssetCatalog } from './assets.js'
import { walkArtifact, type BundleFile, type WalkedBundle } from './bundle.js'
import { apportionDownloadBytes, type Apportionable } from './compress.js'
import type { ResolvedConfig } from './config.js'
import { buildDependencyIndex, readPins, type Pin } from './lockfiles.js'
import { readPlist, readPlistFromZip } from './plist.js'
import {
  compressionRatio,
  parseThinningReport,
  selectVariant,
  type ThinningVariant,
} from './thinning.js'
import { MANIFEST_VERSION, type Bytes, type Entry, type Fingerprint, type Manifest } from './types.js'

/**
 * Assemble one build into a `Manifest`.
 *
 * Everything upstream of this reads a specific format; everything downstream
 * reads only the manifest. That boundary is deliberate: it puts every tool that
 * needs macOS on one side, and makes the diff, attribution and reporting layers
 * testable as plain JSON.
 */

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

/** Synthetic entry id for the bytes a catalog spends on its own indexes. */
export function catalogOverheadId(catalogPath: string): string {
  return `${catalogPath}#(catalog overhead)`
}

export interface BuildManifestOptions {
  /** `.xcarchive`, `.ipa` or `.app`. */
  artifactPath: string
  /** `App Thinning Size Report.txt`. Optional, but the totals are better with it. */
  thinningReportPath?: string
  /** Lockfiles to read pins from. */
  lockfilePaths?: string[]
  config: ResolvedConfig
  /** Commit this build came from, for labelling the comparison. */
  commit?: string
  onNotice?: (message: string) => void
}

export function buildManifest(options: BuildManifestOptions): Manifest {
  const notice = options.onNotice ?? ((): void => {})
  const { config } = options
  const ignoresPath = createPathIgnorer(config)

  const walked = walkArtifact(options.artifactPath, { ignoresPath })

  const variants = readVariants(options.thinningReportPath, notice)
  const reference = variants ? selectVariant(variants, config.variant) : undefined
  if (variants && !reference) {
    throw new ManifestError(
      `variant "${config.variant}" is not in the thinning report. Available: ` +
        `${variants.map((variant) => variant.name).join(', ')}. Use \`variant: largest\` to ` +
        'take the worst case.',
    )
  }

  const { pins, files: lockfiles } = readPins(options.lockfilePaths ?? [])
  const dependencies = buildDependencyIndex(pins)

  const { entries, catalogsRead } = expandEntries(walked, notice)
  attachDependencies(entries, dependencies, config)

  // Scale to Xcode's compressed total for the reference variant. Without a
  // report there is nothing to scale to, and the caller says so in the footer.
  const target = reference
    ? scaleReportTotal(entries, reference)
    : undefined
  const download = apportionDownloadBytes(entries as Apportionable[], target)
  entries.forEach((entry, index) => {
    entry.downloadBytes = download[index] ?? 0
  })

  return {
    version: MANIFEST_VERSION,
    ...(options.commit === undefined ? {} : { commit: options.commit }),
    fingerprint: readFingerprint(walked, options.artifactPath),
    variants: variants ?? [
      {
        // No report: describe the one thing that was measured, and name it so
        // nobody mistakes it for a real thinned variant.
        name: 'unreported',
        downloadBytes: entries.reduce((total, entry) => total + entry.downloadBytes, 0),
        installBytes: entries.reduce((total, entry) => total + entry.installBytes, 0),
      },
    ],
    referenceVariant: reference?.name ?? 'unreported',
    entries: entries as Entry[],
    pins: Object.fromEntries(pins.map((pin) => [pin.name, pin.version])),
    pinLocations: Object.fromEntries(
      pins.map((pin) => [pin.name, { file: pin.file, line: pin.line, source: pin.source }]),
    ),
    capabilities: {
      assetutil: catalogsRead > 0,
      thinningReport: variants !== undefined,
      zipSizes: walked.fromZip,
      lockfiles: lockfiles.length > 0,
    },
  }
}

function createPathIgnorer(config: ResolvedConfig): (path: string) => boolean {
  return picomatch(config.ignorePaths, { dot: true })
}

function readVariants(
  path: string | undefined,
  notice: (message: string) => void,
): ThinningVariant[] | undefined {
  if (path === undefined) return undefined
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    notice(
      `could not read the thinning report at ${path}; download sizes will be an uncalibrated estimate`,
    )
    return undefined
  }
  try {
    return parseThinningReport(text)
  } catch (error) {
    notice(`${path}: ${(error as Error).message}`)
    return undefined
  }
}

/**
 * The compressed total to apportion against.
 *
 * The report's install figure and the exact file walk will not agree -- the
 * report is rounded to one decimal place, and it measures a thinned variant
 * while the walk sees the universal bundle. So the report's *ratio* is applied
 * to the exact install total rather than its compressed figure being used
 * directly. That keeps the total consistent with the bytes actually measured.
 */
function scaleReportTotal(entries: WorkingEntry[], reference: ThinningVariant): Bytes {
  const installTotal = entries.reduce((total, entry) => total + entry.installBytes, 0)
  return Math.round(installTotal * compressionRatio(reference))
}

/** An entry under construction: download bytes are filled in last. */
interface WorkingEntry extends Omit<Entry, 'downloadBytes'> {
  downloadBytes: Bytes
  compressedBytes?: Bytes
}

/**
 * Turn walked files into entries, expanding every asset catalog it can.
 *
 * A catalog that `assetutil` cannot read stays as one opaque entry. That is a
 * worse report, not a broken one, and the capability flag says which happened.
 */
function expandEntries(
  walked: WalkedBundle,
  notice: (message: string) => void,
): { entries: WorkingEntry[]; catalogsRead: number } {
  const entries: WorkingEntry[] = []
  let catalogsRead = 0

  for (const file of walked.files) {
    if (file.category !== 'asset' || walked.appPath === undefined) {
      entries.push(toEntry(file))
      continue
    }

    const catalog = readCatalog(join(walked.appPath, file.path), file.installBytes)
    if (!catalog) {
      notice(
        `could not break down ${file.path} with assetutil; it is reported as one entry. ` +
          'Individual images will not be named.',
      )
      entries.push(toEntry(file))
      continue
    }
    catalogsRead += 1
    entries.push(...catalogEntries(file, catalog))
  }

  return { entries, catalogsRead }
}

function toEntry(file: BundleFile): WorkingEntry {
  return {
    id: file.path,
    path: file.path,
    category: file.category,
    installBytes: file.installBytes,
    downloadBytes: 0,
    ...(file.compressedBytes === undefined ? {} : { compressedBytes: file.compressedBytes }),
  }
}

/** One entry per rendition, plus one for the catalog's own overhead. */
function catalogEntries(file: BundleFile, catalog: AssetCatalog): WorkingEntry[] {
  const entries: WorkingEntry[] = catalog.renditions.map((rendition) => ({
    id: renditionId(file.path, rendition),
    path: file.path,
    category: 'asset',
    installBytes: rendition.sizeOnDisk,
    downloadBytes: 0,
    rendition: {
      name: rendition.name,
      ...(rendition.scale === undefined ? {} : { scale: rendition.scale }),
      ...(rendition.idiom === undefined ? {} : { idiom: rendition.idiom }),
      ...(rendition.kind === undefined ? {} : { kind: rendition.kind }),
    },
  }))

  if (catalog.overheadBytes > 0) {
    entries.push({
      id: catalogOverheadId(file.path),
      path: file.path,
      category: 'asset',
      installBytes: catalog.overheadBytes,
      downloadBytes: 0,
      rendition: { name: '(catalog overhead)' },
    })
  }
  return entries
}

/** Tag framework entries with the package that built them. */
function attachDependencies(
  entries: WorkingEntry[],
  dependencies: { match: (name: string) => Pin | undefined },
  config: ResolvedConfig,
): void {
  const ignored = new Set(config.ignoreDependencies.map((name) => name.toLowerCase()))
  for (const entry of entries) {
    if (entry.category !== 'framework') continue
    const frameworkName = frameworkNameOf(entry.path)
    if (frameworkName === undefined) continue
    const pin = dependencies.match(frameworkName)
    if (!pin || ignored.has(pin.name.toLowerCase())) continue
    entry.dependency = pin.name
  }
}

/**
 * The framework a path belongs to.
 *
 * `Frameworks/Lottie.framework/Lottie` and `Frameworks/Lottie.framework/x.nib`
 * both answer `Lottie.framework`, so a framework's resources roll up with its
 * binary rather than appearing as unrelated rows.
 */
export function frameworkNameOf(path: string): string | undefined {
  const segments = path.split('/')
  const bundle = segments.find((segment) => segment.endsWith('.framework'))
  if (bundle !== undefined) return bundle
  const last = segments[segments.length - 1]
  return last !== undefined && last.endsWith('.dylib') ? last : undefined
}

/** Read the toolchain fingerprint from the app's `Info.plist`. */
function readFingerprint(walked: WalkedBundle, artifactPath: string): Fingerprint {
  const values =
    walked.appPath !== undefined
      ? readPlist(join(walked.appPath, 'Info.plist'))
      : readPlistFromZip(artifactPath, `Payload/${walked.appName}/Info.plist`)

  const asString = (key: string): string | undefined => {
    const value = values[key]
    return typeof value === 'string' && value !== ''
      ? value
      : typeof value === 'number'
        ? String(value)
        : undefined
  }

  const architectures =
    walked.appPath === undefined
      ? undefined
      : readArchitectures(join(walked.appPath, walked.appName.replace(/\.app$/i, '')))

  return {
    ...(asString('DTXcodeBuild') === undefined ? {} : { xcodeBuild: asString('DTXcodeBuild') }),
    ...(asString('DTSDKName') === undefined ? {} : { sdk: asString('DTSDKName') }),
    ...(asString('DTCompiler') === undefined ? {} : { swift: asString('DTCompiler') }),
    ...(asString('MinimumOSVersion') === undefined
      ? {}
      : { deploymentTarget: asString('MinimumOSVersion') }),
    ...(asString('CFBundleShortVersionString') === undefined
      ? {}
      : { version: asString('CFBundleShortVersionString') }),
    ...(asString('CFBundleVersion') === undefined ? {} : { build: asString('CFBundleVersion') }),
    ...(architectures === undefined ? {} : { architectures }),
  }
}

/**
 * Architectures in the main binary.
 *
 * Worth recording because dropping or adding a slice is a size cliff, not a
 * drift -- and it is exactly the kind of change that would otherwise look like
 * an inexplicable multi-megabyte regression.
 */
function readArchitectures(executablePath: string): string[] | undefined {
  try {
    const output = execFileSync('lipo', ['-archs', executablePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const archs = output.trim().split(/\s+/).filter(Boolean).sort()
    return archs.length > 0 ? archs : undefined
  } catch {
    return undefined
  }
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                              */
/* -------------------------------------------------------------------------- */

export function serialiseManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * Read a stored manifest.
 *
 * A manifest from a future major version is refused rather than guessed at: a
 * silently mis-parsed baseline would produce a confident, wrong regression.
 */
export function parseManifest(text: string, source: string): Manifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ManifestError(`${source}: not valid JSON (${(error as Error).message})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ManifestError(`${source}: expected a manifest object`)
  }
  const manifest = parsed as Manifest
  if (manifest.version !== MANIFEST_VERSION) {
    throw new ManifestError(
      `${source}: manifest version ${String(manifest.version)} cannot be read by this version of ` +
        `heft (expects ${MANIFEST_VERSION})`,
    )
  }
  if (!Array.isArray(manifest.entries)) {
    throw new ManifestError(`${source}: manifest has no entries`)
  }
  return manifest
}

/** Totals for the reference variant, from the entries themselves. */
export function manifestTotals(manifest: Manifest): { download: Bytes; install: Bytes } {
  return {
    download: manifest.entries.reduce((total, entry) => total + entry.downloadBytes, 0),
    install: manifest.entries.reduce((total, entry) => total + entry.installBytes, 0),
  }
}
