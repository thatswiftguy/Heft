#!/usr/bin/env node
/**
 * Build a synthetic `.xcarchive` for the self-check workflow.
 *
 * Generated rather than committed: the point of the self-check is to run the
 * real bundled action against a real directory tree, and a few hundred KB of
 * binary fixtures in git would be a poor trade for that. Deterministic, so the
 * two archives it produces differ only in the ways the check asserts.
 *
 * Usage: node scripts/make-fixture-archive.mjs <out-dir> base|head
 */
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [, , outDir, which = 'base'] = process.argv
if (!outDir) {
  console.error('usage: make-fixture-archive.mjs <out-dir> base|head')
  process.exit(2)
}
if (which !== 'base' && which !== 'head') {
  console.error(`expected "base" or "head", got "${which}"`)
  process.exit(2)
}

/** Deterministic filler: same bytes for the same seed on every runner. */
function filler(bytes, seed) {
  const out = Buffer.alloc(bytes)
  let state = 1
  for (const character of seed) state = (state * 31 + character.charCodeAt(0)) % 2147483647
  for (let index = 0; index < bytes; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648
    out[index] = state % 256
  }
  return out
}

function write(path, bytes, seed) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, filler(bytes, seed))
}

const app = join(outDir, 'MyApp.xcarchive/Products/Applications/MyApp.app')
const head = which === 'head'

write(join(app, 'MyApp'), 400_000, 'binary')
write(join(app, 'Info.plist'), 2_000, 'info')
write(join(app, 'Assets.car'), 120_000, 'assets')
write(join(app, 'en.lproj/Localizable.strings'), 3_000, 'strings')

// The dependency under test. Bigger at head, matching the lockfile bump.
write(join(app, 'Frameworks/Lottie.framework/Lottie'), head ? 2_184_000 : 2_000_000, 'lottie')
write(join(app, 'Frameworks/Lottie.framework/Info.plist'), 1_000, 'lottieinfo')
symlinkSync('Lottie', join(app, 'Frameworks/Lottie.framework/Lottie.alias'))

// A framework whose pin does not move.
write(join(app, 'Frameworks/Alamofire.framework/Alamofire'), 1_500_000, 'alamofire')

// A new loose resource, only at head.
if (head) write(join(app, 'Onboarding.json'), 70_000, 'onboarding')

// Must never be counted: in the archive, never shipped.
write(join(outDir, 'MyApp.xcarchive/dSYMs/MyApp.app.dSYM/Contents/Resources/DWARF/MyApp'), 900_000, 'dsym')
write(join(app, '_CodeSignature/CodeResources'), 8_000, 'sig')

// A size report with two variants, so `variant: largest` has a choice to make.
writeFileSync(
  join(outDir, 'App Thinning Size Report.txt'),
  [
    'App Thinning Size Report for All Variants of MyApp',
    '',
    'Variant: MyApp-11111111-2222-3333-4444-555555555555.ipa',
    'Supported variant descriptors: [device: iPhone16,2, os-version: 18.0]',
    'App + On Demand Resources size: 2.1 MB compressed, 4.4 MB uncompressed',
    'App size: 2.1 MB compressed, 4.4 MB uncompressed',
    'On Demand Resources size: Zero KB compressed, Zero KB uncompressed',
    '',
    'Variant: MyApp-66666666-7777-8888-9999-000000000000.ipa',
    'Supported variant descriptors: [device: iPhone12,1, os-version: 13.0]',
    'App + On Demand Resources size: 2.0 MB compressed, 4.2 MB uncompressed',
    'App size: 2.0 MB compressed, 4.2 MB uncompressed',
    'On Demand Resources size: Zero KB compressed, Zero KB uncompressed',
    '',
  ].join('\n'),
)

// The lockfile that explains the framework's growth.
writeFileSync(
  join(outDir, 'Package.resolved'),
  `${JSON.stringify(
    {
      originHash: 'selfcheck',
      pins: [
        {
          identity: 'lottie-ios',
          kind: 'remoteSourceControl',
          location: 'https://github.com/airbnb/lottie-ios.git',
          state: { revision: head ? 'bbb' : 'aaa', version: head ? '4.4.1' : '4.3.0' },
        },
        {
          identity: 'alamofire',
          kind: 'remoteSourceControl',
          location: 'https://github.com/Alamofire/Alamofire.git',
          state: { revision: 'ccc', version: '5.8.0' },
        },
      ],
      version: 3,
    },
    null,
    2,
  )}\n`,
)

console.log(`wrote ${which} fixture to ${outDir}`)
