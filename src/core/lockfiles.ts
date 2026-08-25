import { readFileSync } from 'node:fs'
import type { PinSource } from './types.js'

/**
 * Read resolved dependency versions out of the three lockfiles an iOS project
 * might have.
 *
 * This is the cheapest and highest-value attribution signal in the tool. A
 * framework growing 184 KB is a fact; "Lottie went from 4.3.0 to 4.4.1" is the
 * reason, and it comes from a text diff that needs no build artifact at all.
 */

export interface Pin {
  /** Package name as the lockfile spells it. */
  name: string
  version: string
  source: PinSource
  /** Repo-relative path of the lockfile, for annotations. */
  file: string
  /** 1-based line the pin sits on, for annotations. */
  line: number
}

export interface PinSet {
  pins: Pin[]
  /** Lockfiles that were found and read. */
  files: string[]
}

/* -------------------------------------------------------------------------- */
/* Package.resolved                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Swift Package Manager's lockfile.
 *
 * Three shapes in the wild: v1 nests the array under `object.pins` and names
 * the field `package`; v2 and v3 hoist it to `pins` and name it `identity`.
 * All three are handled because a repo's lockfile version is decided by
 * whichever Xcode last touched it, not by anything the user controls.
 */
export function parsePackageResolved(text: string, file: string): Pin[] {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof root !== 'object' || root === null) return []

  const record = root as Record<string, unknown>
  const object = record['object'] as Record<string, unknown> | undefined
  const raw = (record['pins'] ?? object?.['pins']) as unknown
  if (!Array.isArray(raw)) return []

  const pins: Pin[] = []
  for (const element of raw) {
    if (typeof element !== 'object' || element === null) continue
    const pin = element as Record<string, unknown>
    const state = pin['state'] as Record<string, unknown> | undefined

    // v1 calls it `package`, v2/v3 call it `identity`. `location` is the repo
    // URL, whose last path component is often the better match for a framework
    // name than the identity is.
    const identity =
      asString(pin['identity']) ?? asString(pin['package']) ?? repoName(asString(pin['location']))
    if (identity === undefined) continue

    // A branch or revision pin has no version. Use the short revision, so a
    // moving branch pin still shows as a change rather than as nothing.
    const version =
      asString(state?.['version']) ??
      asString(state?.['branch']) ??
      asString(state?.['revision'])?.slice(0, 7)
    if (version === undefined) continue

    pins.push({
      name: identity,
      version,
      source: 'spm',
      file,
      line: findLine(text, identity),
    })
  }
  return pins
}

function repoName(location: string | undefined): string | undefined {
  if (location === undefined) return undefined
  const last = location.replace(/\.git$/, '').split('/').pop()
  return last === '' ? undefined : last
}

/* -------------------------------------------------------------------------- */
/* Podfile.lock                                                                */
/* -------------------------------------------------------------------------- */

/**
 * CocoaPods' lockfile.
 *
 * Parsed line-wise rather than as YAML on purpose: the `PODS:` section is the
 * only part needed, its entries are `- Name (1.2.3)` or `- Name/Subspec
 * (1.2.3):`, and a real YAML load of a large lockfile costs far more than
 * matching that. Subspecs collapse onto their parent pod, because `Firebase/Core`
 * and `Firebase/Auth` are one version bump, not two.
 */
export function parsePodfileLock(text: string, file: string): Pin[] {
  const pins = new Map<string, Pin>()
  const lines = text.split(/\r?\n/)
  let inPods = false

  for (const [index, line] of lines.entries()) {
    if (/^[A-Z][A-Z ]*:\s*$/.test(line)) {
      inPods = line.startsWith('PODS:')
      continue
    }
    if (!inPods) continue

    // Only top-level pods (two spaces of indent); deeper lines are the
    // dependencies of a pod, which repeat versions already recorded.
    const match = /^ {2}- ([^ (]+)(?:\/[^ (]+)? \(([^)]+)\):?\s*$/.exec(line)
    if (!match) continue
    const [, rawName, version] = match
    // The regex's optional group already dropped a subspec, but a pod written
    // as `Firebase/Core` puts the parent in group 1 only when a space follows.
    const name = (rawName ?? '').split('/')[0] ?? ''
    if (name === '' || version === undefined) continue
    if (!pins.has(name)) {
      pins.set(name, { name, version, source: 'cocoapods', file, line: index + 1 })
    }
  }
  return [...pins.values()]
}

/* -------------------------------------------------------------------------- */
/* Cartfile.resolved                                                           */
/* -------------------------------------------------------------------------- */

/** Carthage's lockfile: `github "Alamofire/Alamofire" "5.8.0"` per line. */
export function parseCartfileResolved(text: string, file: string): Pin[] {
  const pins: Pin[] = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = /^\s*(?:github|git|binary)\s+"([^"]+)"\s+"([^"]+)"\s*$/.exec(line)
    if (!match) continue
    const [, location, version] = match
    const name = (location ?? '').split('/').pop()
    if (!name || version === undefined) continue
    pins.push({ name, version, source: 'carthage', file, line: index + 1 })
  }
  return pins
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

/** Lockfile basenames and the parser each one needs. */
const PARSERS: Array<{
  matches: (path: string) => boolean
  parse: (text: string, file: string) => Pin[]
}> = [
  { matches: (path) => path.endsWith('Package.resolved'), parse: parsePackageResolved },
  { matches: (path) => path.endsWith('Podfile.lock'), parse: parsePodfileLock },
  { matches: (path) => path.endsWith('Cartfile.resolved'), parse: parseCartfileResolved },
]

/**
 * Read every lockfile given, unioning the pins.
 *
 * A project can legitimately use more than one dependency manager, so this
 * unions rather than picking a winner. On a name collision the first one read
 * wins, which keeps the result stable given a stable input order.
 */
export function readPins(files: string[]): PinSet {
  const pins: Pin[] = []
  const read: string[] = []
  const seen = new Set<string>()

  for (const file of files) {
    const parser = PARSERS.find((candidate) => candidate.matches(file))
    if (!parser) continue
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    read.push(file)
    for (const pin of parser.parse(text, file)) {
      const key = pin.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      pins.push(pin)
    }
  }
  return { pins, files: read }
}

/* -------------------------------------------------------------------------- */
/* Matching a framework to a package                                           */
/* -------------------------------------------------------------------------- */

/**
 * Normalise a name for matching.
 *
 * A package's lockfile identity and the framework it builds are routinely
 * spelled differently -- `lottie-ios` produces `Lottie.framework`,
 * `swift-collections` produces `Collections.framework` -- so matching is done
 * on a stripped, lowercased form rather than on equality.
 */
export function normaliseName(name: string): string {
  return name
    .replace(/\.(framework|dylib|bundle|xcframework)$/i, '')
    .replace(/[-_.\s]/g, '')
    .replace(/^(swift)(?=[a-z])/i, '')
    .replace(/(ios|swift|sdk|spm|lib)$/i, '')
    .toLowerCase()
}

export interface DependencyIndex {
  /** Resolve a framework or dylib file name to a pin, if one matches. */
  match: (frameworkName: string) => Pin | undefined
}

export function buildDependencyIndex(pins: Pin[]): DependencyIndex {
  const exact = new Map<string, Pin>()
  const loose = new Map<string, Pin>()
  for (const pin of pins) {
    const key = pin.name.toLowerCase()
    if (!exact.has(key)) exact.set(key, pin)
    const normalised = normaliseName(pin.name)
    if (normalised !== '' && !loose.has(normalised)) loose.set(normalised, pin)
  }

  return {
    match: (frameworkName) => {
      const bare = frameworkName.replace(/\.(framework|dylib|xcframework)$/i, '')
      return (
        exact.get(bare.toLowerCase()) ??
        loose.get(normaliseName(bare)) ??
        // Swift runtime dylibs ship with the OS toolchain, not a package;
        // returning undefined for them keeps them out of dependency rows.
        undefined
      )
    },
  }
}

/** Pins that changed between two manifests, keyed by lowercased package name. */
export interface PinChange {
  name: string
  from?: string
  to?: string
}

export function diffPins(
  before: Record<string, string>,
  after: Record<string, string>,
): Map<string, PinChange> {
  const changes = new Map<string, PinChange>()
  for (const [name, version] of Object.entries(after)) {
    const previous = before[name]
    if (previous !== version) {
      changes.set(name.toLowerCase(), {
        name,
        ...(previous === undefined ? {} : { from: previous }),
        to: version,
      })
    }
  }
  for (const [name, version] of Object.entries(before)) {
    if (after[name] === undefined) {
      changes.set(name.toLowerCase(), { name, from: version })
    }
  }
  return changes
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 1-based line where a token first appears, for annotations. Falls back to 1. */
function findLine(text: string, token: string): number {
  const index = text.indexOf(token)
  if (index === -1) return 1
  return text.slice(0, index).split('\n').length
}
