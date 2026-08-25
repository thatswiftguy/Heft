import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  createIgnoreMatchers,
  defaultConfig,
  parseBytes,
  parseConfig,
} from '../src/core/config.js'

describe('parseBytes', () => {
  it('reads decimal units, because that is what Apple reports', () => {
    expect(parseBytes('1KB', 'f')).toBe(1_000)
    expect(parseBytes('200MB', 'f')).toBe(200_000_000)
    expect(parseBytes('1.5MB', 'f')).toBe(1_500_000)
    expect(parseBytes('1GB', 'f')).toBe(1_000_000_000)
  })

  it('reads binary units only when spelled that way', () => {
    expect(parseBytes('1KiB', 'f')).toBe(1_024)
    expect(parseBytes('1MiB', 'f')).toBe(1_048_576)
  })

  it('treats a bare number as bytes', () => {
    expect(parseBytes('204800', 'f')).toBe(204_800)
    expect(parseBytes(8_000, 'f')).toBe(8_000)
  })

  it('is relaxed about case and whitespace', () => {
    expect(parseBytes(' 200 mb ', 'f')).toBe(200_000_000)
    expect(parseBytes('8Kb', 'f')).toBe(8_000)
  })

  it('names the field and the accepted forms when it cannot parse', () => {
    expect(() => parseBytes('a lot', 'budget.increase')).toThrow(ConfigError)
    expect(() => parseBytes('a lot', 'budget.increase')).toThrow(/budget\.increase/)
    expect(() => parseBytes('a lot', 'budget.increase')).toThrow(/100KB/)
  })

  it('rejects an unknown unit by listing the known ones', () => {
    expect(() => parseBytes('5TB', 'noiseFloor')).toThrow(/unknown unit "TB"/)
    expect(() => parseBytes('5TB', 'noiseFloor')).toThrow(/KiB/)
  })

  it('rejects negatives', () => {
    expect(() => parseBytes(-1, 'f')).toThrow(ConfigError)
  })
})

describe('defaults', () => {
  it('gates on the larger of 100KB or 0.5%', () => {
    const config = defaultConfig()
    expect(config.budget.increase).toBe(100_000)
    expect(config.budget.increasePercent).toBe(0.5)
  })

  it('has no absolute ceiling unless asked', () => {
    expect(defaultConfig().budget.total).toBeUndefined()
  })

  it('sets a noise floor above Swift rebuild jitter', () => {
    expect(defaultConfig().noiseFloor).toBe(8_000)
  })

  it('picks the worst-case variant', () => {
    expect(defaultConfig().variant).toBe('largest')
  })
})

describe('parseConfig', () => {
  it('accepts an empty file as "use the defaults"', () => {
    expect(parseConfig('').budget.increase).toBe(100_000)
    expect(parseConfig('# just a comment\n').noiseFloor).toBe(8_000)
  })

  it('reads a full config', () => {
    const config = parseConfig(`
variant: "MyApp-iPhone16,2"
budget:
  increase: 250KB
  increasePercent: 1
  total: 200MB
noiseFloor: 16KB
topContributors: 8
ignore:
  paths: ['**/Debug/**']
  dependencies: ['VendoredBlob']
`)
    expect(config.variant).toBe('MyApp-iPhone16,2')
    expect(config.budget.increase).toBe(250_000)
    expect(config.budget.total).toBe(200_000_000)
    expect(config.noiseFloor).toBe(16_000)
    expect(config.topContributors).toBe(8)
    expect(config.ignoreDependencies).toEqual(['VendoredBlob'])
  })

  it('reports invalid YAML with the line, not a stack trace', () => {
    expect(() => parseConfig('budget:\n  increase: [\n')).toThrow(ConfigError)
  })

  it('rejects a list at the root with a readable message', () => {
    expect(() => parseConfig('- a\n- b\n')).toThrow(/found a list/)
  })

  it('rejects unknown keys', () => {
    expect(() => parseConfig('nonsense: 1\n')).toThrow(ConfigError)
  })

  it('points a misplaced budget key at the right place', () => {
    expect(() => parseConfig('increase: 100KB\n')).toThrow(/goes under "budget:"/)
  })

  it('surfaces a bad byte size with the field path', () => {
    expect(() => parseConfig('noiseFloor: nonsense\n')).toThrow(/noiseFloor/)
  })
})

describe('ignore matchers', () => {
  it('always excludes dSYMs, which are in the archive but never ship', () => {
    const { ignoresPath } = createIgnoreMatchers(defaultConfig())
    expect(ignoresPath('dSYMs/MyApp.app.dSYM/Contents/Resources/DWARF/MyApp')).toBe(true)
    expect(ignoresPath('Payload/MyApp.app/MyApp')).toBe(false)
  })

  it('always excludes code signatures and bcsymbolmaps', () => {
    const { ignoresPath } = createIgnoreMatchers(defaultConfig())
    expect(ignoresPath('Payload/MyApp.app/_CodeSignature/CodeResources')).toBe(true)
    expect(ignoresPath('BCSymbolMaps/ABC.bcsymbolmap')).toBe(true)
    expect(ignoresPath('Payload/MyApp.app/SC_Info/MyApp.sinf')).toBe(true)
  })

  it('adds user paths without letting them opt back into dSYMs', () => {
    const { ignoresPath } = createIgnoreMatchers(parseConfig("ignore:\n  paths: ['**/Debug/**']\n"))
    expect(ignoresPath('Payload/MyApp.app/Debug/thing')).toBe(true)
    expect(ignoresPath('dSYMs/MyApp.app.dSYM/x')).toBe(true)
  })

  it('matches dependency names as globs, case-insensitively', () => {
    const { ignoresDependency } = createIgnoreMatchers(
      parseConfig("ignore:\n  dependencies: ['Firebase*']\n"),
    )
    expect(ignoresDependency('FirebaseCore')).toBe(true)
    expect(ignoresDependency('firebaseauth')).toBe(true)
    expect(ignoresDependency('Lottie')).toBe(false)
  })
})
