/**
 * Domain model shared by extraction, diffing and the reporters.
 *
 * The `Manifest` is the contract between the two halves of this tool.
 * Extraction needs macOS and a build artifact; everything downstream is pure
 * data. Keeping the seam here is what lets the diff, attribution and report
 * layers be tested as JSON in, JSON out -- no Xcode in the test runner.
 */

/** Bytes. Named so signatures read unambiguously; there is no other unit here. */
export type Bytes = number

/**
 * What kind of thing a bundle entry is.
 *
 * Deliberately coarse. v1 attributes causes for dependencies, asset-catalog
 * renditions and frameworks; everything else is enumerated so the ledger
 * balances but is not broken down further.
 */
export type Category = 'framework' | 'asset' | 'executable' | 'resource' | 'other'

/** Which dependency manager a version pin came from. */
export type PinSource = 'spm' | 'cocoapods' | 'carthage'

/**
 * A single asset-catalog rendition, as reported by `assetutil --info`.
 *
 * One catalog entry produces many renditions -- `@2x`, `@3x`, dark-mode
 * alternates, per-idiom variants -- and they have very different reach. A `@3x`
 * regression only lands on some devices, which is worth saying out loud.
 */
export interface Rendition {
  /** Asset name as authored in the catalog, e.g. `onboarding-hero`. */
  name: string
  /** 1, 2 or 3. Absent for renditions that carry no scale (data, colors). */
  scale?: number
  /** `universal`, `iphone`, `ipad`, ... as `assetutil` spells it. */
  idiom?: string
  /** `Image`, `Color`, `Data`, `Icon Image`, ... */
  kind?: string
}

/** One file, or one asset-catalog rendition, that occupies space in the bundle. */
export interface Entry {
  /**
   * Stable identity for diffing. Bundle-relative POSIX path for files; for
   * renditions, the catalog path plus a rendition discriminator, so that
   * adding an `@3x` next to an existing `@2x` reads as an addition rather than
   * a change to the same thing.
   */
  id: string
  /** Bundle-relative POSIX path of the file this came from. */
  path: string
  category: Category
  /** Exact, from the filesystem or the zip central directory. */
  installBytes: Bytes
  /**
   * Apportioned, not measured. The per-entry share of the reference variant's
   * compressed total. See `compress.ts` -- these sum to the total Xcode
   * reported, which is the only claim made for them.
   */
  downloadBytes: Bytes
  /** Package name, when this entry resolved to a dependency in a lockfile. */
  dependency?: string
  /** Set for asset-catalog renditions only. */
  rendition?: Rendition
}

/**
 * What produced the build. Two manifests are only comparable when these match.
 *
 * Swift builds are not byte-reproducible, and a toolchain bump on its own can
 * move megabytes -- Xcode's app-icon pipeline changing between major versions
 * is a documented example. A diff across mismatched fingerprints is reported
 * but never gated, because calling toolchain drift a regression is how a size
 * check loses its reviewers' trust for good.
 */
export interface Fingerprint {
  /** Xcode build number, e.g. `16C5032a`. */
  xcodeBuild?: string
  /** Swift compiler version string. */
  swift?: string
  /** SDK the archive was built against, e.g. `iphoneos18.2`. */
  sdk?: string
  /** `Release`, `Debug`, or whatever the scheme called it. */
  configuration?: string
  /** Sorted, e.g. `["arm64"]`. */
  architectures?: string[]
  /** e.g. `17.0`. */
  deploymentTarget?: string
  /** Marketing version and build number, for display only. */
  version?: string
  build?: string
}

/** Per-variant totals as they appear in `App Thinning Size Report.txt`. */
export interface Variant {
  /**
   * Variant label exactly as the report spells it, e.g. `MyApp-iPhone16,2`,
   * or `universal` for a report with no thinning.
   */
  name: string
  /** Device models this variant serves, when the report lists them. */
  devices?: string[]
  /** The report's "compressed" figure: what the user downloads. */
  downloadBytes: Bytes
  /** The report's "uncompressed" figure: what lands on disk. */
  installBytes: Bytes
}

/**
 * What extraction was actually able to see.
 *
 * Reported to the user rather than kept private: a size tool that silently
 * measured less than it claims is worse than one that says what it missed.
 */
export interface Capabilities {
  /** `assetutil` ran, so asset catalogs are broken down per rendition. */
  assetutil: boolean
  /** An App Thinning Size Report was supplied, so totals are Xcode's. */
  thinningReport: boolean
  /** Input was an `.ipa`, so per-file compressed sizes are real, not modelled. */
  zipSizes: boolean
  /** At least one dependency lockfile was found and parsed. */
  lockfiles: boolean
}

/** Bump when the shape changes incompatibly; `diff` refuses mismatched majors. */
export const MANIFEST_VERSION = 1 as const

/** Everything measured about one build. This is what gets stored as a baseline. */
export interface Manifest {
  version: typeof MANIFEST_VERSION
  /** Commit this was built from, when known. Used to label the comparison. */
  commit?: string
  fingerprint: Fingerprint
  variants: Variant[]
  /** `name` of the variant every per-entry figure is apportioned against. */
  referenceVariant: string
  entries: Entry[]
  /** Package name -> resolved version, unioned across every lockfile found. */
  pins: Record<string, string>
  /** Where each pin came from, for the annotation's file and line. */
  pinLocations?: Record<string, { file: string; line: number; source: PinSource }>
  capabilities: Capabilities
}

/** Why an entry's size changed. Drives the "Why" column in the comment. */
export type CauseKind =
  /** A dependency's version pin moved. The framework delta follows from it. */
  | 'dependency'
  /** An asset-catalog rendition was added, removed or re-encoded. */
  | 'asset'
  /** A framework changed size with its pin unchanged -- a rebuild or a vendor drop. */
  | 'framework'
  /** A loose bundle resource. */
  | 'resource'
  /** The app's own executable. */
  | 'executable'
  /** Anything else that moved. */
  | 'other'

export interface Cause {
  kind: CauseKind
  /** One short phrase for the Why column, e.g. ``dependency `4.3.0 -> 4.4.1` ``. */
  detail: string
  /** Set when `kind` is `dependency`. */
  dependency?: string
  from?: string
  to?: string
}

/** How an entry (or a collapsed group of them) changed between two manifests. */
export interface Delta {
  /** Display label: a path, a dependency name, or an asset name with its scale. */
  label: string
  /** Stable identity, for dedup and for tests. */
  id: string
  category: Category
  /** `undefined` when the entry is new. */
  beforeDownload?: Bytes
  afterDownload?: Bytes
  beforeInstall?: Bytes
  afterInstall?: Bytes
  /** after - before, in download bytes. Negative means it shrank. */
  downloadDelta: Bytes
  installDelta: Bytes
  cause: Cause
  /** Entry ids folded into this row by cause collapsing. */
  collapsed?: string[]
  /**
   * True when nothing about this entry actually changed and the download figure
   * moved only because the apportionment total did.
   *
   * Download bytes are a share of a total, so when the total moves every share
   * moves with it. Itemising an untouched `Info.plist` as "resource changed,
   * +6 B" would be reporting an artifact of the arithmetic as a fact about the
   * app. These rows keep their bytes in the ledger but are not named.
   */
  apportionmentOnly?: boolean
  /** Where to hang an inline annotation, when there is a real location. */
  location?: { file: string; line?: number }
}
