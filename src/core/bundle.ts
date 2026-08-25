import { lstatSync, readdirSync, statSync } from 'node:fs'
import { basename, join, posix, relative, sep } from 'node:path'
import type { Bytes, Category } from './types.js'
import { readZipEntries, type ZipEntry } from './zip.js'

/**
 * Walk a build artifact into an exact per-file size list.
 *
 * This -- not the thinning report -- is where install bytes come from. The
 * report rounds to one decimal place, which is a wider band than the default
 * gate, so it can describe an app but cannot measure a change to one. The
 * filesystem and the zip central directory can.
 */

export class BundleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BundleError'
  }
}

export interface BundleFile {
  /** Path relative to the `.app` root, POSIX separators. */
  path: string
  category: Category
  /** Exact: from `lstat`, or from the zip central directory. */
  installBytes: Bytes
  /**
   * Real compressed size, present only for `.ipa` input. Where this exists,
   * download apportionment is measured rather than modelled.
   */
  compressedBytes?: Bytes
  /**
   * Which nested bundle owns this file: `''` for the main app, otherwise the
   * app-relative path of the `.appex`, nested `.app` or App Clip.
   */
  owner: string
}

export interface WalkedBundle {
  /** Display name of the app, e.g. `MyApp.app`. */
  appName: string
  files: BundleFile[]
  /** True when sizes came from a zip central directory. */
  fromZip: boolean
  /**
   * Absolute path to the `.app` on disk, when there is one. Absent for `.ipa`
   * input, where nothing was extracted -- which is why `assetutil` cannot run
   * against an ipa without unpacking it first.
   */
  appPath?: string
}

/** Bundle directory suffixes that own their contents for rollup purposes. */
const NESTED_BUNDLE_SUFFIXES = ['.appex', '.app']

/**
 * Classify by path.
 *
 * Deliberately path-driven rather than content-sniffing: reading Mach-O magic
 * off every file would cost a full pass over the bundle to answer a question
 * the layout already answers.
 */
export function classify(path: string, appExecutable?: string): Category {
  const name = posix.basename(path)
  const segments = path.split('/')

  if (name === 'Assets.car') return 'asset'

  // A framework's own binary and its resources both roll up to the framework.
  if (segments.includes('Frameworks')) return 'framework'
  if (/\.(framework|dylib)$/.test(name)) return 'framework'

  // The main executable sits at the bundle root with no extension.
  if (appExecutable !== undefined && path === appExecutable) return 'executable'
  if (segments.length === 1 && !name.includes('.')) return 'executable'

  if (
    /\.(png|jpg|jpeg|heic|heif|gif|pdf|svg|webp|json|plist|strings|stringsdict|nib|storyboardc|car|ttf|otf|woff2?|mp3|mp4|mov|m4a|wav|aiff|caf|mlmodelc|mlmodel|scn|usdz|xcprivacy|momd|bundle|lproj|metallib|css|js|html|txt|md|xml|csv|db|sqlite|realm|zip|gz)$/i.test(
      name,
    )
  ) {
    return 'resource'
  }
  if (segments.some((segment) => segment.endsWith('.lproj') || segment.endsWith('.bundle'))) {
    return 'resource'
  }
  return 'other'
}

/** Which nested bundle, if any, owns a bundle-relative path. */
export function ownerOf(path: string): string {
  const segments = path.split('/')
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const segment = segments[index] ?? ''
    if (NESTED_BUNDLE_SUFFIXES.some((suffix) => segment.endsWith(suffix))) {
      return segments.slice(0, index + 1).join('/')
    }
  }
  return ''
}

/**
 * Resolve whatever the user pointed at to the app bundle inside it.
 *
 * Accepts an `.xcarchive`, an `.ipa` or a bare `.app`, because CI pipelines
 * produce different ones and making the user normalise is work this tool can
 * do itself.
 */
export function walkArtifact(
  artifactPath: string,
  options: { ignoresPath?: (path: string) => boolean } = {},
): WalkedBundle {
  const ignoresPath = options.ignoresPath ?? ((): boolean => false)

  if (/\.ipa$/i.test(artifactPath)) return walkIpa(artifactPath, ignoresPath)

  let stats
  try {
    stats = statSync(artifactPath)
  } catch {
    throw new BundleError(`could not read ${artifactPath}`)
  }
  if (!stats.isDirectory()) {
    throw new BundleError(
      `${artifactPath} is not an .xcarchive, .ipa or .app -- point \`archive:\` at one of those`,
    )
  }

  // Be forgiving about the suffix: CI often renames or untars an archive, so a
  // directory carrying Products/Applications is treated as one either way.
  if (/\.xcarchive$/i.test(artifactPath) || hasArchiveLayout(artifactPath)) {
    return walkAppDirectory(findArchiveApp(artifactPath), ignoresPath)
  }
  if (!/\.app$/i.test(artifactPath)) {
    throw new BundleError(
      `${artifactPath} is a directory, but not an .app or an .xcarchive ` +
        '(no Products/Applications inside it). Point `archive:` at the .xcarchive, ' +
        'the exported .ipa, or the .app itself.',
    )
  }
  return walkAppDirectory(artifactPath, ignoresPath)
}

function hasArchiveLayout(path: string): boolean {
  try {
    return statSync(join(path, 'Products', 'Applications')).isDirectory()
  } catch {
    return false
  }
}

/** `MyApp.xcarchive/Products/Applications/MyApp.app` */
function findArchiveApp(archivePath: string): string {
  const applications = join(archivePath, 'Products', 'Applications')
  let entries: string[]
  try {
    entries = readdirSync(applications)
  } catch {
    throw new BundleError(
      `${archivePath}: no Products/Applications directory -- this does not look like an .xcarchive`,
    )
  }
  const apps = entries.filter((entry) => entry.endsWith('.app'))
  if (apps.length === 0) {
    throw new BundleError(`${archivePath}: no .app found under Products/Applications`)
  }
  // More than one .app at the top level is unusual; take the first by name so
  // the choice is at least deterministic, rather than filesystem-order.
  apps.sort()
  return join(applications, apps[0] as string)
}

function walkAppDirectory(appPath: string, ignoresPath: (path: string) => boolean): WalkedBundle {
  const files: BundleFile[] = []
  // Hardlinked files -- common inside .framework bundles, where a versioned
  // binary and its top-level alias can be the same inode -- must be counted
  // once. Both copies occupy one file's worth of disk and one file's worth of
  // download.
  const seenInodes = new Set<string>()
  const appExecutable = basename(appPath).replace(/\.app$/i, '')

  const walk = (directory: string): void => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const relativePath = relative(appPath, absolute).split(sep).join('/')
      if (ignoresPath(relativePath)) continue

      if (entry.isSymbolicLink()) {
        // A symlink's own size is the length of its target string -- a few
        // bytes. Counting the target through the link would double-count it,
        // and the target is walked in its own right.
        continue
      }
      if (entry.isDirectory()) {
        walk(absolute)
        continue
      }
      if (!entry.isFile()) continue

      let stats
      try {
        stats = lstatSync(absolute)
      } catch {
        continue
      }
      if (stats.nlink > 1) {
        const key = `${stats.dev}:${stats.ino}`
        if (seenInodes.has(key)) continue
        seenInodes.add(key)
      }

      files.push({
        path: relativePath,
        category: classify(relativePath, appExecutable),
        installBytes: stats.size,
        owner: ownerOf(relativePath),
      })
    }
  }

  walk(appPath)
  if (files.length === 0) {
    throw new BundleError(`${appPath}: no files found in the app bundle`)
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { appName: basename(appPath), files, fromZip: false, appPath }
}

function walkIpa(ipaPath: string, ignoresPath: (path: string) => boolean): WalkedBundle {
  const entries = readZipEntries(ipaPath)

  // `Payload/MyApp.app/...` is the layout Apple defines for an ipa.
  const appPrefix = findIpaAppPrefix(entries, ipaPath)
  const appName = appPrefix.split('/').filter(Boolean).slice(-1)[0] ?? 'app'
  const appExecutable = appName.replace(/\.app$/i, '')

  const files: BundleFile[] = []
  for (const entry of entries) {
    if (entry.directory || entry.symlink) continue
    if (!entry.name.startsWith(appPrefix)) continue
    const relativePath = entry.name.slice(appPrefix.length)
    if (relativePath === '' || ignoresPath(relativePath)) continue

    files.push({
      path: relativePath,
      category: classify(relativePath, appExecutable),
      installBytes: entry.uncompressedBytes,
      compressedBytes: entry.compressedBytes,
      owner: ownerOf(relativePath),
    })
  }

  if (files.length === 0) throw new BundleError(`${ipaPath}: no files found under ${appPrefix}`)
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { appName, files, fromZip: true }
}

function findIpaAppPrefix(entries: ZipEntry[], ipaPath: string): string {
  const candidates = new Set<string>()
  for (const entry of entries) {
    const match = /^(Payload\/[^/]+\.app\/)/.exec(entry.name)
    if (match?.[1]) candidates.add(match[1])
  }
  if (candidates.size === 0) {
    throw new BundleError(
      `${ipaPath}: no Payload/*.app found -- is this an ipa exported from Xcode?`,
    )
  }
  // Nested app bundles produce longer prefixes; the shortest is the outer app.
  return [...candidates].sort((a, b) => a.length - b.length || a.localeCompare(b))[0] as string
}

/** Total exact install bytes of a walk. */
export function totalInstallBytes(files: BundleFile[]): Bytes {
  return files.reduce((total, file) => total + file.installBytes, 0)
}
