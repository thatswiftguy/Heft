import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compressionRatio,
  parseDescriptors,
  parseSize,
  parseThinningReport,
  selectVariant,
  ThinningReportError,
} from '../src/core/thinning.js'

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures/thinning', name), 'utf8')

describe('parseSize', () => {
  it('reads decimal MB/KB the way Xcode writes them', () => {
    expect(parseSize('5.4 MB')).toBe(5_400_000)
    expect(parseSize('912 bytes')).toBe(912)
    expect(parseSize('48.2 MB')).toBe(48_200_000)
  })

  it('reads "Zero KB", which Xcode writes instead of 0', () => {
    expect(parseSize('Zero KB')).toBe(0)
    expect(parseSize('zero MB')).toBe(0)
  })

  it('reads a comma decimal separator from a European build machine', () => {
    expect(parseSize('21,4 MB')).toBe(21_400_000)
  })

  it('returns undefined rather than throwing on junk', () => {
    expect(parseSize('a lot')).toBeUndefined()
    expect(parseSize('5.4 parsecs')).toBeUndefined()
  })
})

describe('parseDescriptors', () => {
  it('pulls every device model out, despite commas inside the model name', () => {
    expect(
      parseDescriptors('[device: iPhone12,1, os-version: 13.0] and [device: iPhone11,8, os-version: 13.0]'),
    ).toEqual(['iPhone12,1', 'iPhone11,8'])
  })

  it('is empty for a report with no descriptors', () => {
    expect(parseDescriptors('')).toEqual([])
  })
})

describe('parseThinningReport', () => {
  it('reads every variant, stripping the .ipa suffix', () => {
    const variants = parseThinningReport(fixture('multi-variant.txt'))
    expect(variants).toHaveLength(3)
    expect(variants[0]?.name).toBe('MyApp-7433FC8E-1DF4-4299-A7E8-E00768671BEB')
    expect(variants[0]?.downloadBytes).toBe(21_400_000)
    expect(variants[0]?.installBytes).toBe(48_200_000)
    expect(variants[0]?.devices).toEqual(['iPhone12,1', 'iPhone11,8'])
  })

  it('handles a single unthinned variant', () => {
    const variants = parseThinningReport(fixture('single-variant.txt'))
    expect(variants).toHaveLength(1)
    expect(variants[0]?.name).toBe('MyApp')
    expect(variants[0]?.downloadBytes).toBe(5_400_000)
  })

  it('reads a European-locale report at the right magnitude, not 10x', () => {
    const variants = parseThinningReport(fixture('european-locale.txt'))
    expect(variants[0]?.downloadBytes).toBe(21_400_000)
    expect(variants[0]?.installBytes).toBe(48_200_000)
  })

  it('separates On Demand Resources from the app itself', () => {
    const variants = parseThinningReport(fixture('odr-and-wrapped.txt'))
    expect(variants[0]?.downloadBytes).toBe(21_400_000)
    expect(variants[0]?.odrDownloadBytes).toBe(8_800_000)
    expect(variants[0]?.odrInstallBytes).toBe(12_200_000)
  })

  it('follows descriptors that Xcode wrapped onto later lines', () => {
    const variants = parseThinningReport(fixture('odr-and-wrapped.txt'))
    expect(variants[0]?.devices).toEqual(['iPhone12,1', 'iPhone11,8', 'iPhone14,5'])
  })

  it('falls back to the app+ODR figure when the App size line is absent', () => {
    const variants = parseThinningReport(fixture('no-app-size-line.txt'))
    expect(variants[0]?.downloadBytes).toBe(12_500_000)
    expect(variants[0]?.installBytes).toBe(30_000_000)
  })

  it('explains itself when handed a file that is not a size report', () => {
    expect(() => parseThinningReport(fixture('malformed.txt'))).toThrow(ThinningReportError)
    expect(() => parseThinningReport(fixture('malformed.txt'))).toThrow(/thin-for-all-variants/)
  })

  it('keeps the raw strings so the report can quote Xcode verbatim', () => {
    const variants = parseThinningReport(fixture('multi-variant.txt'))
    expect(variants[0]?.raw).toEqual({ download: '21.4 MB', install: '48.2 MB' })
  })
})

describe('selectVariant', () => {
  const variants = parseThinningReport(fixture('multi-variant.txt'))

  it('defaults to the largest download, the worst case the limits bite on', () => {
    expect(selectVariant(variants, 'largest')?.downloadBytes).toBe(22_900_000)
  })

  it('matches an explicit variant name', () => {
    expect(selectVariant(variants, 'MyApp-A1B2C3D4-1111-2222-3333-444455556666')?.downloadBytes).toBe(
      22_900_000,
    )
  })

  it('matches a device model, so nobody has to copy a UUID', () => {
    expect(selectVariant(variants, 'iPad13,1')?.downloadBytes).toBe(20_100_000)
  })

  it('returns undefined for a variant that is not there', () => {
    expect(selectVariant(variants, 'iPhone1,1')).toBeUndefined()
  })
})

describe('compressionRatio', () => {
  it('is the compressed-over-uncompressed fraction', () => {
    const variants = parseThinningReport(fixture('single-variant.txt'))
    expect(compressionRatio(variants[0]!)).toBeCloseTo(5.4 / 13.7, 6)
  })

  it('never divides by zero', () => {
    expect(
      compressionRatio({
        name: 'x',
        downloadBytes: 0,
        installBytes: 0,
        odrDownloadBytes: 0,
        odrInstallBytes: 0,
        raw: { download: '', install: '' },
      }),
    ).toBe(1)
  })
})

describe('robustness against format drift', () => {
  it('reads a report with CRLF line endings', () => {
    const variants = parseThinningReport(fixture('crlf.txt'))
    expect(variants).toHaveLength(1)
    expect(variants[0]?.downloadBytes).toBe(21_400_000)
    expect(variants[0]?.devices).toEqual(['iPhone16,2'])
  })

  it('ignores sections it does not recognise rather than failing', () => {
    // The format is Apple's and may grow. An unknown line should cost that
    // line, never the report.
    const variants = parseThinningReport(fixture('unknown-sections.txt'))
    expect(variants).toHaveLength(2)
    expect(variants[0]?.downloadBytes).toBe(21_400_000)
  })

  it('does not mistake an App Clip section for the app', () => {
    const variants = parseThinningReport(fixture('unknown-sections.txt'))
    expect(variants[0]?.installBytes).toBe(48_200_000)
  })

  it('reads a byte-scale variant, not just megabytes', () => {
    const variants = parseThinningReport(fixture('unknown-sections.txt'))
    expect(variants[1]?.downloadBytes).toBe(912)
    expect(variants[1]?.installBytes).toBe(4_000)
  })

  it('is not confused by a leading header line', () => {
    expect(parseThinningReport(fixture('unknown-sections.txt'))[0]?.name).toBe('MyApp-ABC')
  })
})
