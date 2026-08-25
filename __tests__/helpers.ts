import { execFileSync } from 'node:child_process'
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Deterministic filler, so a fixture's sizes are exactly what a test asserts. */
export function filler(bytes: number, seed = 'x'): string {
  return seed.repeat(bytes / seed.length + 1).slice(0, bytes)
}

export function writeFile(path: string, bytes: number, seed?: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, filler(bytes, seed))
}

/** A realistic XML Info.plist, so the toolchain fingerprint has something to read. */
export function infoPlist(overrides: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    CFBundleExecutable: 'MyApp',
    CFBundleShortVersionString: '2.4.1',
    CFBundleVersion: '1187',
    DTXcodeBuild: '16C5032a',
    DTSDKName: 'iphoneos18.2',
    DTCompiler: 'com.apple.compilers.llvm.clang.1_0',
    MinimumOSVersion: '17.0',
    ...overrides,
  }
  const body = Object.entries(values)
    .map(([key, value]) => `\t<key>${key}</key>\n\t<string>${value}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`
}

export interface SyntheticArchive {
  archivePath: string
  appPath: string
}

/**
 * Build an `.xcarchive` on disk with the awkward cases in it: a symlinked
 * framework alias, a hardlinked pair, a nested `.appex`, and a `dSYMs`
 * directory that must not be counted.
 *
 * Built at test time rather than committed because git cannot carry hardlinks,
 * and the double-counting those cause is exactly what needs asserting.
 */
export function buildSyntheticArchive(
  options: {
    assetsCarBytes?: number
    lottieBytes?: number
    extraFiles?: Record<string, number>
    /** Overrides for the app's Info.plist, e.g. a different DTXcodeBuild. */
    plist?: Record<string, string>
  } = {},
): SyntheticArchive {
  const root = mkdtempSync(join(tmpdir(), 'heft-archive-'))
  const archivePath = join(root, 'MyApp.xcarchive')
  const appPath = join(archivePath, 'Products', 'Applications', 'MyApp.app')

  writeFile(join(appPath, 'MyApp'), 40_000)
  mkdirSync(appPath, { recursive: true })
  writeFileSync(join(appPath, 'Info.plist'), infoPlist(options.plist ?? {}))
  writeFile(join(appPath, 'Assets.car'), options.assetsCarBytes ?? 120_000)
  writeFile(join(appPath, 'FeatureFlags.json'), 5_000)
  writeFile(join(appPath, 'en.lproj', 'Localizable.strings'), 3_000)

  // A framework with a symlinked top-level alias, the layout Xcode produces.
  const lottie = join(appPath, 'Frameworks', 'Lottie.framework')
  writeFile(join(lottie, 'Lottie'), options.lottieBytes ?? 200_000)
  writeFile(join(lottie, 'Info.plist'), 1_000)
  symlinkSync('Lottie', join(lottie, 'Lottie.alias'))

  writeFile(join(appPath, 'Frameworks', 'Alamofire.framework', 'Alamofire'), 150_000)
  writeFile(join(appPath, 'Frameworks', 'libswiftCore.dylib'), 300_000)

  // A hardlinked pair: one file's worth of disk, two directory entries.
  const original = join(appPath, 'Shared.bin')
  writeFile(original, 10_000)
  linkSync(original, join(appPath, 'SharedAlias.bin'))

  // A nested extension, which rolls up to its own owner.
  const widget = join(appPath, 'PlugIns', 'Widget.appex')
  writeFile(join(widget, 'Widget'), 25_000)
  writeFile(join(widget, 'Assets.car'), 15_000)

  // Never ships, must never be counted.
  writeFile(join(archivePath, 'dSYMs', 'MyApp.app.dSYM', 'Contents', 'Resources', 'DWARF', 'MyApp'), 900_000)
  writeFile(join(appPath, '_CodeSignature', 'CodeResources'), 8_000)

  for (const [relative, bytes] of Object.entries(options.extraFiles ?? {})) {
    writeFile(join(appPath, relative), bytes)
  }

  return { archivePath, appPath }
}

/**
 * Compile a real asset catalog with `actool` and drop the `.car` into an app.
 *
 * Returns undefined when Xcode's tools are absent, so callers can skip rather
 * than fail on a runner without them.
 */
export function compileRealCatalog(
  destination: string,
  images: Record<string, number> = { 'onboarding-hero': 60, 'settings-icon': 16 },
): boolean {
  const staging = mkdtempSync(join(tmpdir(), 'heft-cat-'))
  const catalog = join(staging, 'Assets.xcassets')
  mkdirSync(catalog, { recursive: true })
  writeFileSync(join(catalog, 'Contents.json'), JSON.stringify({ info: { author: 'xcode', version: 1 } }))

  for (const [name, base] of Object.entries(images)) {
    const set = join(catalog, `${name}.imageset`)
    mkdirSync(set, { recursive: true })
    const entries = [1, 2, 3].map((scale) => {
      const filename = `${name}@${scale}x.png`
      writeFileSync(join(set, filename), randomPng(base * scale, base * scale, `${name}${scale}`))
      return { idiom: 'universal', filename, scale: `${scale}x` }
    })
    writeFileSync(
      join(set, 'Contents.json'),
      JSON.stringify({ images: entries, info: { author: 'xcode', version: 1 } }),
    )
  }

  const out = join(staging, 'out')
  mkdirSync(out, { recursive: true })
  try {
    execFileSync(
      'xcrun',
      [
        'actool', catalog,
        '--compile', out,
        '--platform', 'iphoneos',
        '--minimum-deployment-target', '17.0',
        '--output-partial-info-plist', join(out, 'partial.plist'),
        '--output-format', 'human-readable-text',
      ],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    )
  } catch {
    return false
  }
  try {
    copyFileSync(join(out, 'Assets.car'), destination)
  } catch {
    return false
  }
  return true
}

/** A PNG of random pixels, so it is genuinely incompressible. */
function randomPng(width: number, height: number, seed: string): Buffer {
  let state = 0
  for (const character of seed) state = (state * 31 + character.charCodeAt(0)) % 2147483647
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state % 256
  }

  const raw = Buffer.alloc((width * 3 + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0
    offset += 1
    for (let x = 0; x < width * 3; x += 1) {
      raw[offset] = next()
      offset += 1
    }
  }

  const chunk = (tag: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(tag, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Exact install bytes of the default synthetic archive.
 *
 * Computed rather than hard-coded because the Info.plist is real XML whose
 * length depends on its contents -- and a test that asserts a stale constant
 * would fail for a reason unrelated to what it is checking.
 */
export function expectedTotal(): number {
  return (
    40_000 + // MyApp
    Buffer.byteLength(infoPlist()) + // Info.plist
    120_000 + // Assets.car
    5_000 + // FeatureFlags.json
    3_000 + // en.lproj/Localizable.strings
    200_000 + // Lottie
    1_000 + // Lottie Info.plist
    150_000 + // Alamofire
    300_000 + // libswiftCore.dylib
    10_000 + // hardlinked pair, counted once
    25_000 + // Widget
    15_000 // Widget Assets.car
  )
}
