import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import * as core from '@actions/core'
import * as github from '@actions/github'
import { BaseRefError } from './core/baseline.js'
import { BundleError } from './core/bundle.js'
import { ConfigError, DEFAULT_CONFIG_PATH } from './core/config.js'
import { ManifestError, serialiseManifest } from './core/manifest.js'
import { ThinningReportError } from './core/thinning.js'
import { ZipError } from './core/zip.js'
import { planAnnotations } from './report/annotations.js'
import { COMMENT_MARKER, isOurComment, renderComment, summaryLine, truncate } from './report/comment.js'
import { renderFailure, renderSummary } from './report/summary.js'
import { artifactMissing, exitCodeFor, run, type RunResult } from './run.js'

/** Action outputs have a size limit; the full report lives in the job summary. */
const MAX_REPORT_OUTPUT = 50_000

async function runAction(): Promise<void> {
  const artifactPath = required('archive')
  if (artifactMissing(artifactPath)) {
    return misconfigured(
      `no such file or directory: ${artifactPath}\n\n` +
        'Point `archive:` at the .xcarchive, the exported .ipa, or the .app. It has to exist by ' +
        'the time this step runs, so put this step after the build.',
    )
  }

  const shouldComment = readBoolean('comment', true)
  const shouldAnnotate = readBoolean('annotations', true)
  const shouldFail = readBoolean('fail', true)
  const configPath = core.getInput('config') || DEFAULT_CONFIG_PATH

  const result: RunResult = run({
    cwd: process.cwd(),
    artifactPath,
    ...optional('thinning-report', 'thinningReportPath'),
    configPath,
    // The default path is allowed to be absent -- zero-config is supported.
    configExplicit: configPath !== DEFAULT_CONFIG_PATH,
    ...(baseRef() === undefined ? {} : { baseRef: baseRef() }),
    ...(readList('lockfiles').length === 0 ? {} : { lockfiles: readList('lockfiles') }),
    ...optional('baseline-directory', 'baselineDirectory'),
    ...optional('baseline-branch', 'baselineBranch'),
    allowFetch: true,
    ...(headSha() === undefined ? {} : { commit: headSha() }),
    onNotice: (message) => core.info(message),
  })

  const { input } = result
  writeManifest(result)

  const plan = planAnnotations(result.diff.deltas, result.verdict.gated)
  if (shouldAnnotate) {
    for (const annotation of plan.annotations) {
      const properties = {
        title: annotation.title,
        file: annotation.file,
        ...(annotation.line === undefined ? {} : { startLine: annotation.line }),
      }
      if (annotation.level === 'warning') core.warning(annotation.message, properties)
      else core.notice(annotation.message, properties)
    }
    if (plan.totalDropped > 0) {
      core.info(`+ ${plan.totalDropped} more — see the job summary`)
    }
  }
  if (plan.totalDropped > 0) input.annotationsDropped = plan.totalDropped

  const body = renderComment(input)
  await writeSummary(renderSummary(input))
  if (shouldComment) await postComment(body)

  const { totals } = result.diff
  core.setOutput('passed', String(result.verdict.passed))
  core.setOutput('download-bytes', String(totals.afterDownload))
  core.setOutput('install-bytes', String(totals.afterInstall))
  core.setOutput('download-delta', String(totals.downloadDelta))
  core.setOutput('report', truncate(body, MAX_REPORT_OUTPUT))

  if (!result.verdict.gated) {
    // Reported, deliberately not gated. Saying so in the log matters: a green
    // check that skipped its gate should not look like a green check that
    // passed one.
    core.info(`heft: ${summaryLine(input)} — reporting only, not gating.`)
    return
  }
  if (exitCodeFor(result) === 0) {
    core.info(`heft: ${summaryLine(input)}, within budget.`)
    return
  }

  const message = failureSummary(result)
  if (shouldFail) core.setFailed(message)
  else core.warning(`${message} (fail: false, not blocking)`)
}

function failureSummary(result: RunResult): string {
  const { verdict, diff } = result
  if (verdict.overTotal !== undefined) {
    return (
      `Download size is ${verdict.overTotal.actual} bytes, over the configured ceiling of ` +
      `${verdict.overTotal.total} bytes.`
    )
  }
  const over = diff.totals.downloadDelta - verdict.allowance
  const cause = verdict.named[0]
  const because = cause === undefined ? '' : ` Largest contributor: ${cause.label} (${cause.cause.detail}).`
  return (
    `This change adds ${diff.totals.downloadDelta} bytes of download size, ` +
    `${over} bytes over the ${verdict.allowance} byte budget.${because}`
  )
}

/** Write the manifest so a later run can use it as a baseline. */
function writeManifest(result: RunResult): void {
  const path = core.getInput('manifest-out')
  if (!path) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, serialiseManifest(result.manifest))
    core.info(`wrote ${path}`)
  } catch (error) {
    // Never fatal: failing to save a baseline costs the *next* run some
    // precision, and failing this run over it would be a poor trade.
    core.warning(`could not write ${path}: ${(error as Error).message}`)
  }
}

/** A comma- or newline-separated input, e.g. a list of lockfile paths. */
function readList(name: string): string[] {
  return core
    .getInput(name)
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter((value) => value !== '')
}

function required(name: string): string {
  const value = core.getInput(name).trim()
  if (value === '') {
    throw new ConfigError(`\`${name}\` is required. Set it to the path of your build artifact.`)
  }
  return value
}

function optional<K extends string>(input: string, key: K): Record<K, string> | Record<string, never> {
  const value = core.getInput(input).trim()
  return value === '' ? {} : ({ [key]: value } as Record<K, string>)
}

/**
 * Read a boolean input, falling back rather than throwing when it is absent.
 *
 * `core.getBooleanInput` throws on an empty value. Action defaults mean that
 * normally cannot happen, but a hard crash on a missing input is a poor trade
 * for a check whose whole job is to produce a readable failure.
 */
function readBoolean(name: string, fallback: boolean): boolean {
  const raw = core.getInput(name).trim()
  if (raw === '') return fallback
  if (['true', 'True', 'TRUE'].includes(raw)) return true
  if (['false', 'False', 'FALSE'].includes(raw)) return false
  throw new ConfigError(`${name} must be true or false, got "${raw}"`)
}

/**
 * Work out what to compare against.
 *
 * Pull requests give a base branch. Pushes do not, but `payload.before` is the
 * commit the branch was at, which is the right comparison for a push -- so
 * `on: push` works without anyone having to configure it. Neither is fatal: a
 * run with no base still records a baseline and reports absolute sizes.
 */
function baseRef(): string | undefined {
  const explicit = core.getInput('base-ref').trim()
  if (explicit !== '') return explicit

  const context = github.context
  const fromPullRequest = context.payload.pull_request?.base?.ref
  if (typeof fromPullRequest === 'string' && fromPullRequest !== '') return fromPullRequest
  if (process.env.GITHUB_BASE_REF) return process.env.GITHUB_BASE_REF

  const before = context.payload.before
  // All-zeros means the branch did not exist before this push.
  if (typeof before === 'string' && before !== '' && !/^0+$/.test(before)) return before
  return undefined
}

function headSha(): string | undefined {
  const context = github.context
  const fromPullRequest = context.payload.pull_request?.head?.sha
  if (typeof fromPullRequest === 'string' && fromPullRequest !== '') return fromPullRequest
  return context.sha || undefined
}

async function writeSummary(markdown: string): Promise<void> {
  try {
    await core.summary.addRaw(markdown).write()
  } catch (error) {
    // No $GITHUB_STEP_SUMMARY (a local act run, say). The log still gets it.
    core.info(markdown)
    core.debug(`could not write the job summary: ${(error as Error).message}`)
  }
}

/**
 * Post or update the sticky comment.
 *
 * Never fatal. On a pull request from a fork the token is read-only and this
 * 403s; that is a permissions fact about forks, not a problem with the code
 * under review, so it degrades to a notice and the annotations and job summary
 * carry the result. Switching to `pull_request_target` to get a writable token
 * would run untrusted code with secrets, which is not a trade worth making.
 */
async function postComment(body: string): Promise<void> {
  const context = github.context
  const issueNumber = context.payload.pull_request?.number
  if (!issueNumber) {
    core.info(`no pull request associated with the "${context.eventName}" event; skipping comment`)
    return
  }

  const token = core.getInput('github-token')
  if (!token) {
    core.info('no github-token supplied; skipping comment')
    return
  }

  try {
    const octokit = github.getOctokit(token)
    const { owner, repo } = context.repo

    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    })

    const ours = comments.filter((comment) => isOurComment(comment.body))
    // Prefer one the bot wrote, so a human quoting the marker cannot hijack it.
    const existing = ours.find((comment) => comment.user?.type === 'Bot') ?? ours[0]

    if (existing) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body })
      core.debug(`updated comment ${existing.id}`)
    } else {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body })
      core.debug('created a new comment')
    }
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 403 || status === 404) {
      core.info(
        'Cannot comment on this pull request (the token is read-only, which is normal for ' +
          'forks). Results are in the annotations and the job summary.',
      )
      return
    }
    core.warning(`Could not post the comment: ${(error as Error).message}`)
  }
}

/** Exit 2: the tool is misconfigured, as distinct from a size regression. */
function misconfigured(message: string): void {
  core.setFailed(message)
  // setFailed sets exit 1; 2 is reserved for "this tool is misconfigured".
  process.exitCode = 2
}

/**
 * Every "you configured this wrong" path has to land on exit 2, including the
 * ones that fire while reading inputs, before the run even starts. Catching
 * them in one place is what keeps that promise honest.
 */
async function main(): Promise<void> {
  try {
    await runAction()
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof BaseRefError ||
      error instanceof BundleError ||
      error instanceof ManifestError ||
      error instanceof ThinningReportError ||
      error instanceof ZipError
    ) {
      await writeSummary(renderFailure(error.message)).catch(() => {})
      return misconfigured(error.message)
    }
    core.setFailed(error instanceof Error ? error.stack || error.message : String(error))
  }
}

void main()

export { COMMENT_MARKER }
