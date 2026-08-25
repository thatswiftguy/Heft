import { isAbsolute, join } from 'node:path'
import { existsSync } from 'node:fs'
import fastGlob from 'fast-glob'
import { judge, type Verdict } from './core/budget.js'
import { loadConfig, type ResolvedConfig } from './core/config.js'
import { diffManifests, type DiffResult } from './core/diff.js'
import { buildManifest } from './core/manifest.js'
import {
  branchSource,
  directorySource,
  resolveBaseline,
  type BaselineSource,
  type ResolvedBaseline,
} from './core/baseline.js'
import type { Manifest } from './core/types.js'
import type { ReportInput } from './report/model.js'

/**
 * The whole check, in one call.
 *
 * Kept separate from `main.ts` so the engine can be exercised without the
 * GitHub Actions runtime: every test drives this directly, and nothing in here
 * touches `@actions/core`.
 */

export interface RunOptions {
  cwd: string
  /** `.xcarchive`, `.ipa` or `.app`. */
  artifactPath: string
  /** `App Thinning Size Report.txt`. Optional but strongly recommended. */
  thinningReportPath?: string
  /** Config file path. Relative paths resolve against `cwd`, not the process. */
  configPath: string
  /**
   * Explicit lockfile paths or globs. When absent, they are discovered under
   * `cwd`. Needed when the lockfile lives outside the working directory, which
   * a monorepo or a separated build workspace routinely does.
   */
  lockfiles?: string[]
  /** True when the user named the config path, making "not found" fatal. */
  configExplicit?: boolean
  /** Base branch to compare against, e.g. `main`. */
  baseRef?: string
  /** Directory holding restored baselines, e.g. from actions/cache. */
  baselineDirectory?: string
  /** Orphan branch holding `<sha>.json` baselines. */
  baselineBranch?: string
  /** Allow a git fetch when the base ref is missing. On in CI, off locally. */
  allowFetch?: boolean
  /** Commit this build came from. */
  commit?: string
  onNotice?: (message: string) => void
  /** Injected for tests; defaults to loading from disk. */
  config?: ResolvedConfig
}

export interface RunResult {
  manifest: Manifest
  config: ResolvedConfig
  diff: DiffResult
  verdict: Verdict
  baseline?: ResolvedBaseline
  input: ReportInput
}

export function run(options: RunOptions): RunResult {
  const notice = options.onNotice ?? ((): void => {})
  const configPath = isAbsolute(options.configPath)
    ? options.configPath
    : join(options.cwd, options.configPath)
  const config = options.config ?? loadConfig(configPath, options.configExplicit ?? false)

  const manifest = buildManifest({
    artifactPath: options.artifactPath,
    ...(options.thinningReportPath === undefined
      ? {}
      : { thinningReportPath: options.thinningReportPath }),
    lockfilePaths:
      options.lockfiles !== undefined && options.lockfiles.length > 0
        ? resolveLockfiles(options.cwd, options.lockfiles)
        : findLockfiles(options.cwd),
    config,
    ...(options.commit === undefined ? {} : { commit: options.commit }),
    onNotice: notice,
  })

  const baseline = options.baseRef
    ? resolveBaseline({
        cwd: options.cwd,
        baseRef: options.baseRef,
        sources: baselineSources(options),
        allowFetch: options.allowFetch ?? false,
        onNotice: notice,
      })
    : undefined

  // With no baseline this compares the build against itself, which yields no
  // deltas and correct absolute totals -- exactly what the first run should
  // report. The `absoluteOnly` flag is what stops the report implying a
  // comparison happened.
  const diff = diffManifests(baseline?.manifest ?? manifest, manifest)
  const verdict = judge(diff, config)

  return {
    manifest,
    config,
    diff,
    verdict,
    ...(baseline === undefined ? {} : { baseline }),
    input: {
      diff,
      verdict,
      config,
      manifest,
      baseline: {
        ...(baseline?.commit === undefined ? {} : { commit: baseline.commit }),
        how: baseline?.how ?? 'no baseline found',
      },
      ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
      ...(baseline === undefined ? { absoluteOnly: true } : {}),
    },
  }
}

function baselineSources(options: RunOptions): BaselineSource[] {
  const sources: BaselineSource[] = []
  // Cache first: it is a local file read, and the branch costs a git call.
  if (options.baselineDirectory !== undefined) {
    sources.push(directorySource(resolveAgainstCwd(options.cwd, options.baselineDirectory)))
  }
  if (options.baselineBranch !== undefined) {
    sources.push(branchSource(options.cwd, options.baselineBranch))
  }
  return sources
}

/**
 * Find dependency lockfiles in the repo.
 *
 * Bounded depth and a vendored-directory exclusion, because a repo with Pods
 * checked in contains hundreds of nested `Package.resolved` files belonging to
 * dependencies rather than to this project.
 */
export function findLockfiles(cwd: string): string[] {
  const found = fastGlob.sync(
    ['**/Package.resolved', '**/Podfile.lock', '**/Cartfile.resolved'],
    {
      cwd,
      absolute: true,
      dot: false,
      deep: 4,
      ignore: [
        '**/node_modules/**',
        '**/Pods/**',
        '**/Carthage/**',
        '**/.build/**',
        '**/DerivedData/**',
        '**/build/**',
        '**/*.xcarchive/**',
      ],
    },
  )
  // Shortest paths first: a root Package.resolved is the project's own, and
  // readPins keeps the first spelling on a name collision.
  return found.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
}

/**
 * Resolve a path that may already be absolute.
 *
 * `join` would turn `/runner/temp/baselines` into
 * `/repo/runner/temp/baselines`, silently finding no baseline and reporting a
 * first run -- a failure that looks like a legitimate state rather than a bug.
 */
function resolveAgainstCwd(cwd: string, path: string): string {
  return isAbsolute(path) ? path : join(cwd, path)
}

/**
 * Expand explicit lockfile paths or globs.
 *
 * Globs are expanded, plain paths are taken as given -- so a user who names one
 * file gets that file, and is not silently dropped if it happens to contain a
 * glob character.
 */
export function resolveLockfiles(cwd: string, patterns: string[]): string[] {
  const literal: string[] = []
  const globs: string[] = []
  for (const pattern of patterns) {
    if (/[*?[\]{}]/.test(pattern)) globs.push(pattern)
    else literal.push(isAbsolute(pattern) ? pattern : join(cwd, pattern))
  }
  const expanded =
    globs.length > 0 ? fastGlob.sync(globs, { cwd, absolute: true, dot: false }) : []
  return [...new Set([...literal, ...expanded])].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
  )
}

/**
 * Process exit code for a completed run.
 *
 * 0 clean, 1 a regression, 2 misconfigured. Callers ask this rather than
 * deriving it themselves, so the action and the tests cannot drift.
 */
export function exitCodeFor(result: RunResult): 0 | 1 {
  return result.verdict.passed ? 0 : 1
}

/** True when the artifact the user pointed at is not there at all. */
export function artifactMissing(artifactPath: string): boolean {
  return !existsSync(artifactPath)
}
