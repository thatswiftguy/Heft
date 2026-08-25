import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultConfig, parseConfig } from '../src/core/config.js'
import { serialiseManifest } from '../src/core/manifest.js'
import { artifactMissing, exitCodeFor, findLockfiles, run } from '../src/run.js'
import { buildSyntheticArchive, expectedTotal } from './helpers.js'

const THINNING = join(import.meta.dirname, 'fixtures/thinning/multi-variant.txt')

/** A real git repo with a base branch, a feature branch, and stored baselines. */
function makeRepo(): { cwd: string; baselineDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'heft-repo-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  writeFileSync(join(cwd, 'README.md'), 'base\n')
  git('add', '.')
  git('commit', '-m', 'base')

  // Two more commits on main, so walking back is exercised.
  for (const n of [1, 2]) {
    writeFileSync(join(cwd, `f${n}.txt`), `${n}\n`)
    git('add', '.')
    git('commit', '-m', `main ${n}`)
  }
  git('checkout', '-b', 'feature')
  writeFileSync(join(cwd, 'feature.txt'), 'x\n')
  git('add', '.')
  git('commit', '-m', 'feature')

  const baselineDir = join(cwd, '.heft-baselines')
  mkdirSync(baselineDir, { recursive: true })
  return { cwd, baselineDir }
}

function mergeBaseOf(cwd: string): string {
  return execFileSync('git', ['merge-base', 'HEAD', 'main'], { cwd, encoding: 'utf8' }).trim()
}

function nthBeforeMergeBase(cwd: string, n: number): string {
  return execFileSync('git', ['rev-parse', `${mergeBaseOf(cwd)}~${n}`], {
    cwd,
    encoding: 'utf8',
  }).trim()
}

describe('artifactMissing', () => {
  it('detects a path that is not there', () => {
    expect(artifactMissing('/no/such/archive.xcarchive')).toBe(true)
    expect(artifactMissing(buildSyntheticArchive().archivePath)).toBe(false)
  })
})

describe('findLockfiles', () => {
  it('finds a project lockfile and ignores vendored copies', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'heft-locks-'))
    mkdirSync(join(cwd, 'Pods'), { recursive: true })
    mkdirSync(join(cwd, 'App'), { recursive: true })
    writeFileSync(join(cwd, 'Podfile.lock'), 'PODS:\n')
    writeFileSync(join(cwd, 'Pods', 'Podfile.lock'), 'PODS:\n')
    writeFileSync(join(cwd, 'App', 'Package.resolved'), '{}')

    const found = findLockfiles(cwd)
    expect(found.some((path) => path.includes('/Pods/'))).toBe(false)
    // Shallowest first, so the project's own lockfile wins a name collision.
    expect(found[0]).toBe(join(cwd, 'Podfile.lock'))
    expect(found).toHaveLength(2)
  })
})

describe('run with no baseline', () => {
  it('reports absolute sizes and does not gate', () => {
    const { cwd } = makeRepo()
    const result = run({
      cwd,
      artifactPath: buildSyntheticArchive().archivePath,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      baseRef: 'main',
      config: defaultConfig(),
    })
    expect(result.baseline).toBeUndefined()
    expect(result.input.absoluteOnly).toBe(true)
    expect(result.diff.deltas).toEqual([])
    expect(result.verdict.passed).toBe(true)
    expect(exitCodeFor(result)).toBe(0)
  })

  it('still measures the build', () => {
    const { cwd } = makeRepo()
    const result = run({
      cwd,
      artifactPath: buildSyntheticArchive().archivePath,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      config: defaultConfig(),
    })
    expect(result.diff.totals.afterInstall).toBe(expectedTotal())
    expect(result.manifest.capabilities.thinningReport).toBe(true)
  })
})

describe('run against a stored baseline', () => {
  /** Store a baseline for a commit, built from a smaller archive. */
  function storeBaseline(cwd: string, dir: string, commit: string, lottieBytes: number): void {
    const smaller = buildSyntheticArchive({ lottieBytes })
    const result = run({
      cwd,
      artifactPath: smaller.archivePath,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      config: defaultConfig(),
      commit,
    })
    writeFileSync(join(dir, `${commit}.json`), serialiseManifest(result.manifest))
  }

  it('finds the baseline at the merge base and reports the growth', () => {
    const { cwd, baselineDir } = makeRepo()
    storeBaseline(cwd, baselineDir, mergeBaseOf(cwd), 100_000)

    const result = run({
      cwd,
      artifactPath: buildSyntheticArchive({ lottieBytes: 200_000 }).archivePath,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      baseRef: 'main',
      baselineDirectory: '.heft-baselines',
      config: defaultConfig(),
    })

    expect(result.baseline?.how).toBe('merge base')
    expect(result.input.absoluteOnly).toBeUndefined()
    expect(result.diff.totals.installDelta).toBe(100_000)
    const lottie = result.diff.deltas.find((delta) => delta.label === 'Lottie.framework')
    expect(lottie?.installDelta).toBe(100_000)
  })

  it('walks back when the merge base has no baseline, and says how far', () => {
    const { cwd, baselineDir } = makeRepo()
    // Only the grandparent of the merge base has one.
    storeBaseline(cwd, baselineDir, nthBeforeMergeBase(cwd, 2), 100_000)

    const result = run({
      cwd,
      artifactPath: buildSyntheticArchive({ lottieBytes: 200_000 }).archivePath,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      baseRef: 'main',
      baselineDirectory: '.heft-baselines',
      config: defaultConfig(),
    })
    expect(result.baseline?.how).toBe('2 commits before the merge base')
    expect(result.diff.totals.installDelta).toBe(100_000)
  })

  it('fails the gate when growth exceeds the budget', () => {
    const { cwd, baselineDir } = makeRepo()
    storeBaseline(cwd, baselineDir, mergeBaseOf(cwd), 100_000)
    const result = run({
      cwd,
      artifactPath: buildSyntheticArchive({ lottieBytes: 1_000_000 }).archivePath,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      baseRef: 'main',
      baselineDirectory: '.heft-baselines',
      config: defaultConfig(),
    })
    expect(result.verdict.passed).toBe(false)
    expect(exitCodeFor(result)).toBe(1)
  })

  it('passes when the budget is raised above the growth', () => {
    const { cwd, baselineDir } = makeRepo()
    storeBaseline(cwd, baselineDir, mergeBaseOf(cwd), 100_000)
    const result = run({
      cwd,
      artifactPath: buildSyntheticArchive({ lottieBytes: 1_000_000 }).archivePath,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      baseRef: 'main',
      baselineDirectory: '.heft-baselines',
      config: parseConfig('budget:\n  increase: 5MB\n'),
    })
    expect(result.verdict.passed).toBe(true)
  })

  it('skips a corrupt baseline and keeps walking rather than failing', () => {
    const { cwd, baselineDir } = makeRepo()
    writeFileSync(join(baselineDir, `${mergeBaseOf(cwd)}.json`), 'not a manifest')
    storeBaseline(cwd, baselineDir, nthBeforeMergeBase(cwd, 1), 100_000)

    const notices: string[] = []
    const result = run({
      cwd,
      artifactPath: buildSyntheticArchive({ lottieBytes: 200_000 }).archivePath,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      baseRef: 'main',
      baselineDirectory: '.heft-baselines',
      config: defaultConfig(),
      onNotice: (message) => notices.push(message),
    })
    expect(result.baseline?.how).toBe('1 commit before the merge base')
    expect(notices.some((message) => /skipping baseline/.test(message))).toBe(true)
  })

  it('reads a baseline from an orphan branch when the cache has none', () => {
    const { cwd } = makeRepo()
    const commit = mergeBaseOf(cwd)
    const staging = mkdtempSync(join(tmpdir(), 'heft-orphan-'))
    const smaller = buildSyntheticArchive({ lottieBytes: 100_000 })
    const stored = run({
      cwd,
      artifactPath: smaller.archivePath,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      config: defaultConfig(),
    })
    writeFileSync(join(staging, `${commit}.json`), serialiseManifest(stored.manifest))

    // Build the orphan commit with plumbing, never touching the working tree --
    // which is exactly how the publish workflow does it, so a baseline push
    // cannot disturb a build running in the same checkout.
    const plumb = (args: string[], input?: string): string =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        ...(input === undefined ? {} : { input }),
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim()

    const blob = plumb(['hash-object', '-w', join(staging, `${commit}.json`)])
    const tree = plumb(['mktree'], `100644 blob ${blob}\t${commit}.json\n`)
    const orphan = plumb(['commit-tree', tree, '-m', 'baseline'])
    plumb(['update-ref', 'refs/heads/heft-baselines', orphan])

    const result = run({
      cwd,
      artifactPath: buildSyntheticArchive({ lottieBytes: 200_000 }).archivePath,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      baseRef: 'main',
      baselineBranch: 'heft-baselines',
      config: defaultConfig(),
    })
    expect(result.baseline?.commit).toBe(commit)
    expect(result.diff.totals.installDelta).toBe(100_000)
  })
})

describe('run without a thinning report', () => {
  it('says the download figure is uncalibrated', () => {
    const { cwd } = makeRepo()
    const result = run({
      cwd,
      artifactPath: buildSyntheticArchive().archivePath,
      configPath: '.heft.yml',
      config: defaultConfig(),
    })
    expect(result.manifest.capabilities.thinningReport).toBe(false)
    expect(result.manifest.referenceVariant).toBe('unreported')
  })

  it('notices a thinning report that is not one', () => {
    const { cwd } = makeRepo()
    const notices: string[] = []
    run({
      cwd,
      artifactPath: buildSyntheticArchive().archivePath,
      thinningReportPath: join(import.meta.dirname, 'fixtures/thinning/malformed.txt'),
      configPath: '.heft.yml',
      config: defaultConfig(),
      onNotice: (message) => notices.push(message),
    })
    expect(notices.some((message) => /thin-for-all-variants/.test(message))).toBe(true)
  })
})

describe('config loading', () => {
  it('resolves a relative config path against cwd, not the process', () => {
    const { cwd } = makeRepo()
    writeFileSync(join(cwd, '.heft.yml'), 'noiseFloor: 64KB\n')
    const result = run({
      cwd,
      artifactPath: buildSyntheticArchive().archivePath,
      configPath: '.heft.yml',
    })
    expect(result.config.noiseFloor).toBe(64_000)
    expect(result.config.source).toBe(join(cwd, '.heft.yml'))
  })

  it('runs with no config file at all', () => {
    const { cwd } = makeRepo()
    expect(
      run({
        cwd,
        artifactPath: buildSyntheticArchive().archivePath,
        configPath: '.heft.yml',
      }).config.noiseFloor,
    ).toBe(8_000)
  })

  it('is fatal when an explicitly named config is missing', () => {
    const { cwd } = makeRepo()
    expect(() =>
      run({
        cwd,
        artifactPath: buildSyntheticArchive().archivePath,
        configPath: 'nope.yml',
        configExplicit: true,
      }),
    ).toThrow(/config file not found/)
  })
})

describe('manifest round trip through the baseline store', () => {
  it('a stored manifest read back gives an identical comparison', () => {
    const { cwd, baselineDir } = makeRepo()
    const archive = buildSyntheticArchive().archivePath
    const first = run({
      cwd,
      artifactPath: archive,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      config: defaultConfig(),
      commit: mergeBaseOf(cwd),
    })
    writeFileSync(join(baselineDir, `${mergeBaseOf(cwd)}.json`), serialiseManifest(first.manifest))

    const second = run({
      cwd,
      artifactPath: archive,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      baseRef: 'main',
      baselineDirectory: '.heft-baselines',
      config: defaultConfig(),
    })
    // The same archive against its own stored manifest must be a clean no-op.
    expect(second.diff.deltas).toEqual([])
    expect(second.diff.totals.downloadDelta).toBe(0)
    expect(second.diff.caveats).toEqual([])
  })
})

describe('path handling', () => {
  it('accepts an absolute baseline directory', () => {
    // join(cwd, '/abs/path') silently yields cwd + '/abs/path', which finds no
    // baseline and reports a first run -- a bug that looks like a valid state.
    const { cwd, baselineDir } = makeRepo()
    const archive = buildSyntheticArchive().archivePath
    const first = run({
      cwd,
      artifactPath: archive,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      config: defaultConfig(),
    })
    writeFileSync(join(baselineDir, `${mergeBaseOf(cwd)}.json`), serialiseManifest(first.manifest))

    const result = run({
      cwd,
      artifactPath: archive,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      baseRef: 'main',
      // Absolute, not relative to cwd.
      baselineDirectory: baselineDir,
      config: defaultConfig(),
    })
    expect(result.baseline?.how).toBe('merge base')
  })

  it('still accepts a relative baseline directory', () => {
    const { cwd, baselineDir } = makeRepo()
    const archive = buildSyntheticArchive().archivePath
    const first = run({
      cwd,
      artifactPath: archive,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      config: defaultConfig(),
    })
    writeFileSync(join(baselineDir, `${mergeBaseOf(cwd)}.json`), serialiseManifest(first.manifest))
    expect(
      run({
        cwd,
        artifactPath: archive,
        thinningReportPath: THINNING,
        configPath: '.heft.yml',
        baseRef: 'main',
        baselineDirectory: '.heft-baselines',
        config: defaultConfig(),
      }).baseline?.how,
    ).toBe('merge base')
  })
})

describe('explicit lockfiles', () => {
  it('reads lockfiles outside the working directory', () => {
    // A monorepo, or a build workspace separated from the checkout.
    const { cwd } = makeRepo()
    const elsewhere = mkdtempSync(join(tmpdir(), 'heft-locks-out-'))
    writeFileSync(
      join(elsewhere, 'Package.resolved'),
      JSON.stringify({
        version: 3,
        pins: [
          {
            identity: 'lottie-ios',
            location: 'https://github.com/airbnb/lottie-ios.git',
            state: { version: '4.4.1', revision: 'aaa' },
          },
        ],
      }),
    )
    const result = run({
      cwd,
      artifactPath: buildSyntheticArchive().archivePath,
      configPath: '.heft.yml',
      lockfiles: [join(elsewhere, 'Package.resolved')],
      config: defaultConfig(),
    })
    expect(result.manifest.pins['lottie-ios']).toBe('4.4.1')
    expect(result.manifest.capabilities.lockfiles).toBe(true)
  })

  it('expands a glob', () => {
    const { cwd } = makeRepo()
    mkdirSync(join(cwd, 'packages/app'), { recursive: true })
    writeFileSync(join(cwd, 'packages/app/Package.resolved'), '{"version":3,"pins":[]}')
    expect(
      run({
        cwd,
        artifactPath: buildSyntheticArchive().archivePath,
        configPath: '.heft.yml',
        lockfiles: ['packages/*/Package.resolved'],
        config: defaultConfig(),
      }).manifest.capabilities.lockfiles,
    ).toBe(true)
  })
})

describe('the toolchain guard, end to end', () => {
  it('reports but refuses to gate when the baseline used a different Xcode', () => {
    const { cwd, baselineDir } = makeRepo()
    // Baseline built with one Xcode...
    const base = run({
      cwd,
      artifactPath: buildSyntheticArchive({ lottieBytes: 100_000, plist: { DTXcodeBuild: '16C5032a' } })
        .archivePath,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      config: defaultConfig(),
    })
    writeFileSync(join(baselineDir, `${mergeBaseOf(cwd)}.json`), serialiseManifest(base.manifest))

    // ...head with another, and well over budget.
    const result = run({
      cwd,
      artifactPath: buildSyntheticArchive({ lottieBytes: 2_000_000, plist: { DTXcodeBuild: '17F113' } })
        .archivePath,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      baseRef: 'main',
      baselineDirectory: '.heft-baselines',
      config: defaultConfig(),
    })

    expect(result.diff.totals.installDelta).toBeGreaterThan(1_000_000)
    expect(result.verdict.gated).toBe(false)
    // A toolchain bump moves size on its own; failing the PR for it is how a
    // size check loses its reviewers.
    expect(result.verdict.passed).toBe(true)
    expect(exitCodeFor(result)).toBe(0)
    expect(result.diff.caveats.map((caveat) => caveat.kind)).toContain('fingerprint')
  })

  it('gates normally when the toolchains match', () => {
    const { cwd, baselineDir } = makeRepo()
    const base = run({
      cwd,
      artifactPath: buildSyntheticArchive({ lottieBytes: 100_000 }).archivePath,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      config: defaultConfig(),
    })
    writeFileSync(join(baselineDir, `${mergeBaseOf(cwd)}.json`), serialiseManifest(base.manifest))

    const result = run({
      cwd,
      artifactPath: buildSyntheticArchive({ lottieBytes: 2_000_000 }).archivePath,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      baseRef: 'main',
      baselineDirectory: '.heft-baselines',
      config: defaultConfig(),
    })
    expect(result.verdict.gated).toBe(true)
    expect(result.verdict.passed).toBe(false)
    expect(exitCodeFor(result)).toBe(1)
  })
})

describe('an absolute ceiling applies even on a first run', () => {
  it('fails when the app is already over the configured limit', () => {
    const { cwd } = makeRepo()
    const result = run({
      cwd,
      artifactPath: buildSyntheticArchive().archivePath,
      thinningReportPath: THINNING,
      configPath: '.heft.yml',
      config: parseConfig('budget:\n  total: 100KB\n'),
    })
    expect(result.input.absoluteOnly).toBe(true)
    expect(result.verdict.overTotal).toBeDefined()
    expect(result.verdict.passed).toBe(false)
  })
})
