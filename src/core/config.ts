import { readFileSync } from 'node:fs'
import { parse as parseYaml, YAMLParseError } from 'yaml'
import picomatch from 'picomatch'
import { z } from 'zod'
import type { Bytes } from './types.js'

/** Anything the user got wrong. Always exit code 2, never a stack trace. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export const DEFAULT_CONFIG_PATH = '.heft.yml'

/**
 * Default gate: the larger of 100 KB or 0.5% of the current download size.
 *
 * Percent alone punishes small apps and waves through large ones; absolute
 * alone does the reverse. Taking the larger of the two means a 2 MB app is not
 * gated at 10 KB and a 200 MB app is not gated at 100 KB.
 */
const DEFAULT_BUDGET_INCREASE = 100_000
const DEFAULT_BUDGET_INCREASE_PERCENT = 0.5

/**
 * Deltas below this fold into one aggregated row and never gate.
 *
 * Not a nicety. Swift compilation is not byte-deterministic, so two builds of
 * the same commit differ by a few KB. A check that flags 4 KB as a regression
 * gets muted in a week, which is the failure mode this whole tool exists to
 * avoid.
 */
const DEFAULT_NOISE_FLOOR = 8_000

/** Paths that are in the archive but never ship, or are counted elsewhere. */
const ALWAYS_IGNORED_PATHS = [
  // dSYMs sit in the .xcarchive and are not part of the app. Counting them
  // makes every number wrong, so this is not user-overridable in practice.
  '**/*.dSYM/**',
  '**/*.dSYM',
  '**/_CodeSignature/**',
  '**/SC_Info/**',
  '**/*.bcsymbolmap',
  '**/BCSymbolMaps/**',
]

/** How many contributor rows show above the fold before the rest collapse. */
const DEFAULT_TOP_CONTRIBUTORS = 5

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1_000,
  mb: 1_000_000,
  gb: 1_000_000_000,
  kib: 1_024,
  mib: 1_024 * 1_024,
  gib: 1_024 * 1_024 * 1_024,
}

/**
 * Parse a human byte size: `8KB`, `1.5MB`, `204800`, `200 MB`, `4MiB`.
 *
 * Decimal by default, because that is the unit Apple reports App Store sizes
 * in and what the 200 MB cellular threshold means. Reading `KB` as 1024 would
 * make every budget comparison quietly disagree with the number a reviewer
 * sees on the App Store. `KiB`/`MiB`/`GiB` are accepted for binary units.
 */
export function parseBytes(input: string | number, field: string): Bytes {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new ConfigError(`${field}: expected a byte size, got ${input}`)
    }
    return Math.round(input)
  }

  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)\s*$/.exec(input)
  if (!match) {
    throw new ConfigError(
      `${field}: expected a byte size like "100KB", "1.5MB" or "204800", got "${input}"`,
    )
  }
  const [, amount, rawUnit] = match
  const unit = (rawUnit ?? '').toLowerCase()
  const multiplier = unit === '' ? 1 : UNITS[unit]
  if (multiplier === undefined) {
    throw new ConfigError(
      `${field}: unknown unit "${rawUnit}" -- use one of B, KB, MB, GB, KiB, MiB, GiB`,
    )
  }
  return Math.round(Number(amount) * multiplier)
}

/** A byte size that accepts both `8000` and `"8KB"` in YAML. */
const byteSize = z.union([z.number(), z.string().min(1)])

const budgetSchema = z
  .object({
    increase: byteSize.optional(),
    increasePercent: z.number().min(0).optional(),
    total: byteSize.optional(),
  })
  .strict()

const fileSchema = z
  .object({
    /** `largest` or an explicit variant name from the thinning report. */
    variant: z.string().min(1).optional(),
    budget: budgetSchema.optional(),
    noiseFloor: byteSize.optional(),
    topContributors: z.number().int().min(1).max(50).optional(),
    ignore: z
      .object({
        paths: z.array(z.string().min(1)).optional(),
        dependencies: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type ConfigFile = z.infer<typeof fileSchema>

export interface ResolvedConfig {
  /** `largest` picks the worst-case variant, which is what the limits bite on. */
  variant: string
  budget: {
    increase: Bytes
    increasePercent: number
    /** Absolute ceiling on download size. Off unless the user sets it. */
    total?: Bytes
  }
  noiseFloor: Bytes
  topContributors: number
  ignorePaths: string[]
  ignoreDependencies: string[]
  /** Where this came from, for error messages. Undefined when defaulted. */
  source?: string
}

export function defaultConfig(): ResolvedConfig {
  return resolve({})
}

/**
 * Load and validate a config file.
 *
 * A missing file is not an error -- zero-config is a supported way to run, and
 * the defaults are meant to be the right answer for most apps. Only an
 * unreadable or invalid file is fatal.
 *
 * @param path     path to the YAML file
 * @param explicit true when the user named this path, so "not found" is fatal
 */
export function loadConfig(path: string, explicit = false): ResolvedConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' && !explicit) return defaultConfig()
    if (code === 'ENOENT') throw new ConfigError(`config file not found: ${path}`)
    throw new ConfigError(`could not read config file ${path}: ${(error as Error).message}`)
  }
  return parseConfig(text, path)
}

export function parseConfig(text: string, path = DEFAULT_CONFIG_PATH): ResolvedConfig {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const line = error.linePos?.[0]?.line
      const where = line === undefined ? '' : ` (line ${line})`
      // yaml repeats "at line N, column M" in the message; we already say it.
      const detail = (error.message.split('\n')[0] ?? error.message).replace(
        / at line \d+, column \d+:?$/,
        '',
      )
      throw new ConfigError(`${path}: invalid YAML${where}: ${detail}`)
    }
    throw new ConfigError(`${path}: invalid YAML: ${(error as Error).message}`)
  }

  // An empty file parses to null. That is a legitimate "use the defaults".
  if (raw === null || raw === undefined) return { ...resolve({}), source: path }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(
      `${path}: expected the file to contain a mapping of options, found ${
        Array.isArray(raw) ? 'a list' : typeof raw
      }`,
    )
  }

  const result = fileSchema.safeParse(raw)
  if (!result.success) throw new ConfigError(formatIssues(path, result.error))

  return { ...resolve(result.data, path), source: path }
}

function formatIssues(path: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    let message = issue.message

    // Point people at the right knob instead of just rejecting the value.
    if (issue.code === 'unrecognized_keys') {
      const keys = (issue as unknown as { keys?: string[] }).keys ?? []
      const hint = keys.find((key) => key === 'increase' || key === 'total')
      if (hint) message = `${message} -- "${hint}" goes under "budget:"`
    }
    return `  - ${where}: ${message}`
  })
  return `${path}: invalid configuration\n${lines.join('\n')}`
}

function resolve(config: ConfigFile, path = DEFAULT_CONFIG_PATH): ResolvedConfig {
  const budget = config.budget ?? {}
  const resolved: ResolvedConfig = {
    variant: config.variant ?? 'largest',
    budget: {
      increase:
        budget.increase === undefined
          ? DEFAULT_BUDGET_INCREASE
          : parseBytes(budget.increase, `${path}: budget.increase`),
      increasePercent: budget.increasePercent ?? DEFAULT_BUDGET_INCREASE_PERCENT,
      ...(budget.total === undefined
        ? {}
        : { total: parseBytes(budget.total, `${path}: budget.total`) }),
    },
    noiseFloor:
      config.noiseFloor === undefined
        ? DEFAULT_NOISE_FLOOR
        : parseBytes(config.noiseFloor, `${path}: noiseFloor`),
    topContributors: config.topContributors ?? DEFAULT_TOP_CONTRIBUTORS,
    // An explicit list adds to the always-ignored set rather than replacing it:
    // there is no legitimate reason to start counting dSYMs, and a user who
    // sets `ignore.paths` is narrowing further, not opting back in.
    ignorePaths: [...ALWAYS_IGNORED_PATHS, ...(config.ignore?.paths ?? [])],
    ignoreDependencies: config.ignore?.dependencies ?? [],
  }
  return resolved
}

export interface IgnoreMatchers {
  ignoresPath: (path: string) => boolean
  ignoresDependency: (name: string) => boolean
}

/**
 * Compile the ignore lists once.
 *
 * Dependency names are matched as globs too, not just exact strings, so that
 * `ignore.dependencies: ['Firebase*']` does what it looks like it does.
 */
export function createIgnoreMatchers(config: ResolvedConfig): IgnoreMatchers {
  const pathMatcher = picomatch(config.ignorePaths, { dot: true })
  const dependencyMatcher =
    config.ignoreDependencies.length > 0
      ? picomatch(config.ignoreDependencies, { dot: true, nocase: true })
      : undefined

  return {
    ignoresPath: (value) => pathMatcher(value),
    ignoresDependency: (name) => dependencyMatcher?.(name) ?? false,
  }
}
