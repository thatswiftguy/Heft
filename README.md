# heft

**Catch iOS app size regressions before they merge.**

Your app grows a few hundred KB at a time and nobody notices until it crosses the 200 MB cellular
threshold and someone asks why. The tools that exist report a number without a cause — App Store
Connect's size report returns four fields, so the best it can tell you is *"the app grew 312 KB"*,
forty minutes after an upload. That is not something a developer can act on.

heft measures the build artifact you already produce, works out **which dependency, image or file
caused the change**, and puts the cause in the first sentence of one sticky comment.

No App Store Connect key. No upload. No waiting.

---

## Quick start

```yaml
name: App size
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  size:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }

      - name: Archive
        run: |
          xcodebuild archive \
            -scheme MyApp -configuration Release \
            -archivePath "$RUNNER_TEMP/MyApp.xcarchive" \
            -destination 'generic/platform=iOS' \
            CODE_SIGNING_ALLOWED=NO

      - uses: thatswiftguy/heft@v1
        with:
          archive: ${{ runner.temp }}/MyApp.xcarchive
```

`fetch-depth: 0` lets heft find the merge base; without it you get a warning and a less precise
comparison, not a failure.

That reports on every pull request. To get a **gate**, it needs a baseline to compare against —
see [Baselines](#baselines).

---

## What your reviewers see

> ### ⚖️ heft — **failed**
>
> Download size **+263 KB** (+6.4%) vs `main` — mostly **lottie-ios 4.3.0 → 4.4.1**.
>
> |  | Before | After | Δ |
> |---|---|---|---|
> | **Download** | 4.1 MB | 4.3 MB | 🔺 +263 KB (+6.4%) |
> | **Install** | 7.9 MB | 8.3 MB | 🔺 +455 KB (+5.8%) |
>
> Budget: **+263 KB** against **+100 KB** allowed for one change — over by **163 KB**.
>
> | What | Why | Δ download |
> |---|---|---|
> | `Lottie.framework` | dependency `4.3.0 → 4.4.1` | 🔺 +184 KB |
> | `onboarding-hero @3x` | new asset | 🔺 +96 KB |
> | `Onboarding.json` | new resource | 🔺 +21 KB |
> | `Alamofire.framework` | rebuilt, same version | 🔻 −41 KB |
> | 1 change | below the 8 KB noise floor | 🔺 +3 KB |
>
> <sub>variant `MyApp-iPhone16,2` · baseline `a1b2c3d` (merge base) · download bytes apportioned
> from Xcode's reported total</sub>

One comment, updated in place on every push, plus an inline annotation on the lockfile line that
moved and a job summary that works even on fork pull requests.

---

## Two things it does that the others don't

### The ledger balances

Every byte of movement is either in a named row or in the aggregated remainder, and the Δ column
sums to the headline **exactly**. Nothing is quietly dropped, and nothing is double-counted. A size
report whose column does not add up to its own total gets checked once and disbelieved from then on.

That includes the awkward bytes. An asset catalog spends a few percent of itself on indexes; that
appears as `asset catalog indexes`, not as a rounding difference.

### Download bytes are apportioned, never guessed

The App Store recompresses and encrypts what it serves, so no number computed on a build machine is
Apple's download size. heft does not publish a guess dressed as a measurement:

1. **Install size is exact** — every file, from the filesystem or the ipa's central directory.
2. **The compressed total comes from Xcode** — from `App Thinning Size Report.txt`, for the
   reference variant.
3. **Each file gets a share of that total.** For an `.ipa` the per-file weights are *measured* from
   the zip; for an `.xcarchive` a format-class table stands in (a PNG will not deflate again; a
   plist halves).

So the column adds up to a number Xcode vouches for, and the footer says exactly that. Without a
size report heft still works, and says **uncalibrated estimate** instead of pretending otherwise.

> Xcode's report is rounded to one decimal place — `5.4 MB` means ±50 KB, wider than the default
> gate. So its totals are never used to measure a change. Only its *ratio* is, applied to an exact
> install delta.

---

## What it blames, and what it refuses to blame

| Cause | Reads as |
|---|---|
| A dependency version moved | ``Lottie.framework`` — dependency `4.3.0 → 4.4.1` |
| A framework changed, pin didn't | ``Analytics.framework`` — rebuilt, same version |
| An image was added or re-encoded | ``onboarding-hero @3x`` — new asset |
| A loose file appeared | ``FeatureFlags.json`` — new resource |

**Causes collapse.** A version bump moves a framework's binary, its `Info.plist`, its nib and its
own catalog — and Firebase ships a dozen frameworks from one pin. That is one row, not twenty.
Without collapsing, a routine `pod update` produces a wall of rows and the comment gets skimmed.

**Xcode packs small images into sheets.** Individual renditions report a few hundred bytes while the
real pixels sit in `ZZZZPackedAsset-3.1.0-gamut0`. heft pushes those bytes back onto the images that
went into the sheet, weighted by pixel area, so the report names *your* image and never an internal
Xcode artifact.

Three things it deliberately will not call a regression:

- **A different toolchain.** Swift builds are not byte-reproducible, and an Xcode bump moves real
  megabytes on its own. When the two sides disagree on Xcode, SDK, compiler, deployment target or
  architectures, heft reports and **does not gate**.
- **A different device variant.** Comparing an iPad build to an iPhone build is not a regression.
- **Apportionment drift.** Download bytes are a share of a total, so when the total moves every
  share moves with it. A file whose install size did not change is never itemised as having changed.

---

## Baselines

heft compares against a stored manifest from the base branch. Publish one from `main`:

```yaml
name: App size baseline
on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  baseline:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v5
      - name: Archive
        run: |
          xcodebuild archive -scheme MyApp -configuration Release \
            -archivePath "$RUNNER_TEMP/MyApp.xcarchive" \
            -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO
      - uses: thatswiftguy/heft@v1
        with:
          archive: ${{ runner.temp }}/MyApp.xcarchive
          manifest-out: baselines/${{ github.sha }}.json
          comment: false
      - uses: actions/cache/save@v4
        with:
          path: baselines
          key: heft-${{ github.sha }}
```

and restore it on pull requests:

```yaml
      - uses: actions/cache/restore@v4
        with:
          path: baselines
          key: heft-${{ github.sha }}
          restore-keys: heft-
      - uses: thatswiftguy/heft@v1
        with:
          archive: ${{ runner.temp }}/MyApp.xcarchive
          baseline-directory: baselines
```

**The exact merge base often has no baseline** — the cache expired, the main run was skipped, the
branch predates heft. So heft walks first-parent history back from the merge base until it finds
one, and **tells you which commit it actually used**: `baseline a1b2c3d (3 commits before the merge
base)`. A tool that silently compares against something other than what it claims is worse than one
that admits the gap.

With no baseline at all, heft reports absolute sizes and does not gate. That is the correct first
run, not an error.

### Surviving cache eviction

The Actions cache evicts after 7 days and under a 10 GB cap, so long-lived branches lose their
baseline. For a durable store, commit manifests to an orphan branch and point `baseline-branch` at
it. heft reads them with `git show`, so nothing is ever checked out:

```yaml
        with:
          baseline-directory: baselines   # fast path
          baseline-branch: heft-baselines # eviction-proof fallback
```

---

## Configuration

`.heft.yml` at the repo root. Every field is optional, and so is the file.

```yaml
variant: largest        # or "iPhone16,2", or a full variant name
budget:
  increase: 100KB       # the gate: most one change may add
  increasePercent: 0.5  # whichever is larger wins
  total: 200MB          # optional absolute ceiling
noiseFloor: 8KB
topContributors: 5
ignore:
  paths: ['**/DebugOnly/**']
  dependencies: ['VendoredBlob', 'Firebase*']
```

| Option | Default | Notes |
|---|---|---|
| `variant` | `largest` | Largest download — the worst case, and the one the limits bite on |
| `budget.increase` | `100KB` | Absolute per-change allowance |
| `budget.increasePercent` | `0.5` | Proportional allowance; the larger of the two applies |
| `budget.total` | — | Absolute ceiling. Off unless you set it |
| `noiseFloor` | `8KB` | Smaller movement aggregates into one row and never gates |
| `topContributors` | `5` | Rows above the fold; the rest become one subtotal row |
| `ignore.paths` | — | Globs, added to the always-ignored set |
| `ignore.dependencies` | — | Package globs, case-insensitive |

Three behaviours worth knowing:

- **Sizes are decimal.** `1KB` is 1000 bytes, because that is what the App Store shows and what the
  200 MB threshold means. Write `KiB`/`MiB` if you want 1024.
- **`ignore.paths` adds to the defaults, it does not replace them.** `dSYMs`, `_CodeSignature`,
  `SC_Info` and `.bcsymbolmap` are always excluded — a dSYM is in the archive and never ships, and
  counting one makes every number wrong.
- **The budget is a ratchet, not a ceiling.** It gates what *this change* adds. An absolute gate
  fails on the first pull request of a mature app and gets deleted within a week; `budget.total` is
  there if you want the cliff guarded too.

---

## Better numbers, in order of value

heft reports what it could and could not see, in the comment footer. Each of these upgrades it:

1. **Pass a size report.** Add `-exportArchive` with `thinning: <thin-for-all-variants>` in the
   export options plist, then point `thinning-report` at
   `App Thinning Size Report.txt`. Turns download sizes from an uncalibrated estimate into shares of
   Xcode's own total.
2. **Run on macOS.** `assetutil` is what names individual images. Without it a catalog is one opaque
   entry.
3. **Have a lockfile.** `Package.resolved`, `Podfile.lock` or `Cartfile.resolved` is what turns
   "a framework grew" into "Lottie 4.3.0 → 4.4.1".
4. **Point at the `.ipa` rather than the `.xcarchive`.** Its central directory carries real per-file
   compressed sizes, so the split between files is measured instead of modelled.

---

## Rolling it out

1. Add the workflow with `fail: false` — reports appear, nothing blocks.
2. Publish baselines from `main` for a week, until the reports are boring.
3. Delete `fail: false`.
4. **Settings → Branches** → your `main` rule → **Require status checks to pass** → tick
   **`App size / size`**.

That check name is `<workflow name> / <job name>` from your YAML, and it only appears in the list
after it has run on a pull request once.

---

## Inputs and outputs

| Input | Default | | Output |
|---|---|---|---|
| `archive` | **required** | | `passed` |
| `thinning-report` | — | | `download-bytes` |
| `config` | `.heft.yml` | | `install-bytes` |
| `lockfiles` | auto-discovered | | `download-delta` |
| `base-ref` | the PR base | | `report` |
| `baseline-directory` | — | | |
| `baseline-branch` | — | | |
| `manifest-out` | — | | |
| `comment` | `true` | | |
| `annotations` | `true` | | |
| `fail` | `true` | | |
| `github-token` | `${{ github.token }}` | | |

Exit codes: **0** within budget, **1** over budget, **2** misconfigured.

---

## Recipes

| Want | Add to `with:` |
|---|---|
| Report without ever blocking | `fail: false` |
| No comment, just a job summary | `comment: false` |
| Compare against a fixed branch | `base-ref: main` |
| A monorepo's lockfiles | `lockfiles: 'apps/*/Package.resolved'` |
| Guard the 200 MB cellular cliff | `budget.total: 200MB` in `.heft.yml` |

---

## How it works

```
extract → manifest → diff → attribute → report
```

The **manifest** (`heft.json`) is the contract between the two halves. Extraction reads an
`.xcarchive`, `.ipa` or `.app` and needs macOS tooling; everything downstream is pure data. That
boundary is why baselines are just stored manifests, and why the diff, attribution and reporting
layers are tested as JSON in, JSON out with no Xcode in the test runner.

---

## Contributing

```bash
npm ci
```

```bash
npm test
```

```bash
npm run all
```

A few things worth knowing before you open a PR:

- **`dist/` is committed and CI checks it.** GitHub doesn't build JS actions, so if `dist/` drifts
  from `src/` the action silently runs old code. Run `npm run build` and commit the result.
- **Most tests need no Xcode.** Fixtures under `__tests__/fixtures/` are hand-written manifests,
  recorded `assetutil` output and real size reports. The handful that need `actool`, `assetutil` or
  `lipo` skip themselves elsewhere.
- **`self-check.yml` runs the real bundled action** against generated fixtures on both
  `ubuntu-latest` and `macos-latest`, so the shipped `dist/` and its graceful degradation are both
  exercised in a real runner.
- **Add a fixture alongside any new attribution rule.** The reconciliation invariant is asserted
  across every pair of manifest fixtures, so a new one strengthens the whole suite.
- **Test against a real app when you can.** Captures are too large to commit, so point the
  real-scale test at your own:

  ```bash
  HEFT_REAL_HEAD=head.json HEFT_REAL_BASE=base.json npm test
  ```

  It skips silently without them. Run against a real 843 MB archive it caught two presentation bugs
  that no hand-written fixture had.

One known gap, stated plainly: the `App Thinning Size Report.txt` parser is built from Apple's
documented format and tested against fixtures covering locale decimal separators, `Zero KB`, wrapped
descriptors, CRLF, byte-scale variants and unknown future sections — but not yet against a file a
real `xcodebuild -exportArchive` produced, which needs signing this repository has no access to. The
parser is deliberately tolerant and degrades to an uncalibrated estimate with a notice rather than
failing, so a format surprise costs precision, not the run. If you have a real report, a fixture PR
would be welcome.

## License

MIT
