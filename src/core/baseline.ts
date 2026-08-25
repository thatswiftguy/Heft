import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { parseManifest } from './manifest.js'
import type { Manifest } from './types.js'

/**
 * Find the manifest to compare against.
 *
 * The exact merge base very often has no stored manifest: the cache expired,
 * the main-branch run was skipped, the branch was cut before heft was
 * installed. So this walks first-parent history back from the merge base until
 * it finds one, and **reports which commit it actually used**. A tool that
 * silently compares against something other than what it claims is worse than
 * one that admits the gap, because the first kind gets believed.
 */

export class BaseRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BaseRefError'
  }
}

/** How far back to walk before giving up. */
const MAX_WALK = 50

export interface BaselineSource {
  /** Return the stored manifest text for a commit, or undefined. */
  read: (commit: string) => string | undefined
  /** Shown in the footer, e.g. `cache` or `heft-baselines branch`. */
  name: string
}

export interface ResolvedBaseline {
  manifest: Manifest
  commit: string
  /** Human description for the footer: `merge base`, `3 commits before …`. */
  how: string
}

export interface ResolveOptions {
  cwd: string
  /** Base branch, e.g. `main`, or a commit sha for a push event. */
  baseRef: string
  sources: BaselineSource[]
  allowFetch?: boolean
  onNotice?: (message: string) => void
}

/**
 * Resolve the merge base with the base ref.
 *
 * The merge base, not the tip: work that landed on `main` after this branch was
 * cut is not this pull request's doing, and blaming it here would make the
 * report wrong in the one direction that costs trust.
 */
export function resolveMergeBase(options: {
  cwd: string
  baseRef: string
  allowFetch?: boolean
  onNotice?: (message: string) => void
}): string {
  const notice = options.onNotice ?? ((): void => {})
  const { cwd, baseRef } = options

  const candidates = [baseRef, `origin/${baseRef}`, `refs/remotes/origin/${baseRef}`]
  for (const candidate of candidates) {
    const base = tryGit(cwd, ['merge-base', 'HEAD', candidate])
    if (base !== undefined) return base
  }

  if (options.allowFetch === true) {
    notice(`could not find ${baseRef} locally; fetching it`)
    // A shallow clone is the default in Actions, so the merge base is often
    // simply absent until fetched.
    tryGit(cwd, ['fetch', '--no-tags', '--depth=100', 'origin', baseRef])
    for (const candidate of [`origin/${baseRef}`, 'FETCH_HEAD']) {
      const base = tryGit(cwd, ['merge-base', 'HEAD', candidate])
      if (base !== undefined) return base
    }
  }

  throw new BaseRefError(
    `could not work out the merge base with "${baseRef}". Check out with full history:\n\n` +
      '    - uses: actions/checkout@v5\n' +
      '      with:\n' +
      '        fetch-depth: 0',
  )
}

/** Commits from `start` backwards along first-parent history. */
export function firstParentChain(cwd: string, start: string, limit = MAX_WALK): string[] {
  const output = tryGit(cwd, ['rev-list', '--first-parent', `--max-count=${limit}`, start])
  if (output === undefined) return [start]
  return output.split('\n').map((line) => line.trim()).filter(Boolean)
}

/**
 * Walk back from the merge base until a stored manifest turns up.
 *
 * Returns undefined when nothing is found within the walk limit, which is a
 * legitimate first-run state: the report shows absolute figures and does not
 * gate.
 */
export function resolveBaseline(options: ResolveOptions): ResolvedBaseline | undefined {
  const notice = options.onNotice ?? ((): void => {})
  const mergeBase = resolveMergeBase(options)
  const chain = firstParentChain(options.cwd, mergeBase)

  for (const [distance, commit] of chain.entries()) {
    for (const source of options.sources) {
      const text = source.read(commit)
      if (text === undefined) continue
      let manifest: Manifest
      try {
        manifest = parseManifest(text, `baseline ${commit.slice(0, 7)} (${source.name})`)
      } catch (error) {
        // A corrupt stored baseline should not end the search: the next commit
        // back is very likely fine.
        notice(`skipping baseline at ${commit.slice(0, 7)}: ${(error as Error).message}`)
        continue
      }
      return {
        manifest,
        commit,
        how:
          distance === 0
            ? 'merge base'
            : `${distance} ${distance === 1 ? 'commit' : 'commits'} before the merge base`,
      }
    }
  }

  notice(
    `no stored baseline found in the ${chain.length} commits before the merge base. ` +
      'Reporting absolute sizes without a gate.',
  )
  return undefined
}

/* -------------------------------------------------------------------------- */
/* Sources                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Baselines committed to an orphan branch as `<sha>.json`.
 *
 * The durable half of the storage pair: unlike the Actions cache this does not
 * expire, so a long-lived branch can still be compared months later. Read
 * straight out of git rather than checked out, so it costs one `git show`.
 */
export function branchSource(cwd: string, branch: string, directory = ''): BaselineSource {
  const prefix = directory === '' ? '' : `${directory.replace(/\/$/, '')}/`
  return {
    name: `${branch} branch`,
    read: (commit) => tryGit(cwd, ['show', `${branch}:${prefix}${commit}.json`]),
  }
}

/** Baselines restored into a local directory, e.g. by `actions/cache`. */
export function directorySource(directory: string, name = 'cache'): BaselineSource {
  return {
    name,
    read: (commit) => {
      const path = `${directory.replace(/\/$/, '')}/${commit}.json`
      if (!existsSync(path)) return undefined
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
    },
  }
}

/** Run git, returning undefined rather than throwing when it fails. */
function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}
