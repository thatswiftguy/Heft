import { describe, expect, it } from 'vitest'
import { apportionDownloadBytes, ratioFor, type Apportionable } from '../src/core/compress.js'

describe('ratioFor', () => {
  it('treats already-compressed media as incompressible', () => {
    expect(ratioFor('hero@3x.png')).toBeGreaterThan(0.9)
    expect(ratioFor('intro.mp4')).toBeGreaterThan(0.9)
  })

  it('expects text to compress hard', () => {
    expect(ratioFor('FeatureFlags.json')).toBeLessThan(0.4)
    expect(ratioFor('Localizable.strings')).toBeLessThan(0.4)
  })

  it('treats an extensionless Mach-O binary as roughly halving', () => {
    expect(ratioFor('MyApp')).toBe(0.5)
    expect(ratioFor('Frameworks/Lottie.framework/Lottie')).toBe(0.5)
  })

  it('has a middling default for anything unrecognised', () => {
    expect(ratioFor('weird.qqq')).toBe(0.6)
  })
})

describe('apportionDownloadBytes', () => {
  const entries: Apportionable[] = [
    { path: 'MyApp', installBytes: 1_000_000 },
    { path: 'Assets.car', installBytes: 2_000_000 },
    { path: 'FeatureFlags.json', installBytes: 500_000 },
  ]

  it('sums to exactly the total Xcode reported', () => {
    const target = 1_234_567
    const result = apportionDownloadBytes(entries, target)
    expect(result.reduce((total, value) => total + value, 0)).toBe(target)
  })

  it('sums exactly across many awkward totals, not just lucky ones', () => {
    for (const target of [1, 7, 999, 1_000_003, 21_400_000, 48_200_001]) {
      const result = apportionDownloadBytes(entries, target)
      expect(result.reduce((total, value) => total + value, 0)).toBe(target)
    }
  })

  it('weights an incompressible asset above compressible text of the same size', () => {
    const [binary, asset] = apportionDownloadBytes(
      [
        { path: 'MyApp', installBytes: 1_000_000 },
        { path: 'hero.png', installBytes: 1_000_000 },
      ],
      1_000_000,
    )
    expect(asset).toBeGreaterThan(binary!)
  })

  it('prefers a measured compressed size over the ratio table', () => {
    // A png the table calls incompressible, but the zip says compressed well.
    const result = apportionDownloadBytes(
      [
        { path: 'a.png', installBytes: 1_000_000, compressedBytes: 10_000 },
        { path: 'b.png', installBytes: 1_000_000 },
      ],
      1_010_000,
    )
    expect(result[0]).toBeLessThan(result[1]!)
  })

  it('returns unscaled estimates when there is no report to calibrate against', () => {
    const result = apportionDownloadBytes([{ path: 'a.json', installBytes: 1_000 }], undefined)
    expect(result).toEqual([300])
  })

  it('never returns a negative or fractional byte count', () => {
    const result = apportionDownloadBytes(entries, 3)
    expect(result.every((value) => Number.isInteger(value) && value >= 0)).toBe(true)
  })

  it('handles an empty bundle without dividing by zero', () => {
    expect(apportionDownloadBytes([], 1_000)).toEqual([])
    expect(apportionDownloadBytes([{ path: 'a', installBytes: 0 }], 1_000)).toEqual([0])
  })

  it('is deterministic, so two runs on one commit agree', () => {
    const a = apportionDownloadBytes(entries, 21_400_000)
    const b = apportionDownloadBytes(entries, 21_400_000)
    expect(a).toEqual(b)
  })
})
