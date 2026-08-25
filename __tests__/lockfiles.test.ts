import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildDependencyIndex,
  diffPins,
  normaliseName,
  parseCartfileResolved,
  parsePackageResolved,
  parsePodfileLock,
  readPins,
} from '../src/core/lockfiles.js'

const dir = join(import.meta.dirname, 'fixtures/locks')
const read = (name: string): string => readFileSync(join(dir, name), 'utf8')

describe('parsePackageResolved', () => {
  it('reads the v1 shape, where pins nest under object and are named package', () => {
    const pins = parsePackageResolved(read('spm-v1/Package.resolved'), 'Package.resolved')
    expect(pins.map((pin) => [pin.name, pin.version])).toEqual([
      ['Alamofire', '5.8.0'],
      ['Lottie', '4.3.0'],
    ])
  })

  it('reads the v3 shape, where pins are hoisted and named identity', () => {
    const pins = parsePackageResolved(read('spm-v3/Package.resolved'), 'Package.resolved')
    expect(pins.find((pin) => pin.name === 'lottie-ios')?.version).toBe('4.4.1')
    expect(pins.find((pin) => pin.name === 'swift-collections')?.version).toBe('1.1.0')
  })

  it('falls back to a short revision for a branch pin, so a moving branch still shows', () => {
    const pins = parsePackageResolved(read('spm-v3/Package.resolved'), 'Package.resolved')
    expect(pins.find((pin) => pin.name === 'some-branch-dep')?.version).toBe('main')
  })

  it('records a line number for the annotation', () => {
    const pins = parsePackageResolved(read('spm-v3/Package.resolved'), 'Package.resolved')
    expect(pins.find((pin) => pin.name === 'lottie-ios')?.line).toBeGreaterThan(1)
  })

  it('returns nothing for malformed JSON rather than throwing', () => {
    expect(parsePackageResolved('{ not json', 'Package.resolved')).toEqual([])
    expect(parsePackageResolved('{}', 'Package.resolved')).toEqual([])
  })
})

describe('parsePodfileLock', () => {
  const pins = parsePodfileLock(read('Podfile.lock'), 'Podfile.lock')

  it('reads top-level pods with their versions', () => {
    expect(pins.find((pin) => pin.name === 'Alamofire')?.version).toBe('5.8.0')
    expect(pins.find((pin) => pin.name === 'SnapKit')?.version).toBe('5.6.0')
  })

  it('collapses subspecs onto the parent pod, which bumps as one', () => {
    const firebase = pins.filter((pin) => pin.name === 'Firebase')
    expect(firebase).toHaveLength(1)
    expect(firebase[0]?.version).toBe('10.18.0')
  })

  it('does not read the DEPENDENCIES or SPEC CHECKSUMS sections as pods', () => {
    // `- Alamofire (~> 5.8)` under DEPENDENCIES is a constraint, not a version.
    expect(pins.filter((pin) => pin.name === 'Alamofire')).toHaveLength(1)
    expect(pins.some((pin) => pin.version.includes('~>'))).toBe(false)
  })

  it('records line numbers inside the PODS section', () => {
    expect(pins.find((pin) => pin.name === 'Alamofire')?.line).toBe(2)
  })
})

describe('parseCartfileResolved', () => {
  const pins = parseCartfileResolved(read('Cartfile.resolved'), 'Cartfile.resolved')

  it('reads github and binary entries, keeping the repo name', () => {
    expect(pins.map((pin) => [pin.name, pin.version])).toEqual([
      ['Alamofire', '5.8.0'],
      ['SDWebImage', '5.18.7'],
      ['Vendor.json', '2.1.0'],
    ])
  })
})

describe('readPins', () => {
  it('unions across dependency managers', () => {
    const { pins, files } = readPins([join(dir, 'Podfile.lock'), join(dir, 'Cartfile.resolved')])
    expect(files).toHaveLength(2)
    expect(pins.some((pin) => pin.source === 'cocoapods')).toBe(true)
    expect(pins.some((pin) => pin.source === 'carthage')).toBe(true)
  })

  it('keeps the first spelling on a cross-manager name collision', () => {
    // Alamofire is in both fixtures at the same version; it must appear once.
    const { pins } = readPins([join(dir, 'Podfile.lock'), join(dir, 'Cartfile.resolved')])
    expect(pins.filter((pin) => pin.name.toLowerCase() === 'alamofire')).toHaveLength(1)
  })

  it('skips a lockfile that is not there without failing', () => {
    expect(readPins([join(dir, 'Nope.lock')]).files).toEqual([])
  })
})

describe('normaliseName', () => {
  it('bridges the gap between a package identity and its framework', () => {
    expect(normaliseName('lottie-ios')).toBe(normaliseName('Lottie.framework'))
    expect(normaliseName('swift-collections')).toBe(normaliseName('Collections'))
  })

  it('is case and punctuation insensitive', () => {
    expect(normaliseName('SD_Web.Image')).toBe(normaliseName('SDWebImage'))
  })
})

describe('buildDependencyIndex', () => {
  const { pins } = readPins([join(dir, 'spm-v3/Package.resolved'), join(dir, 'Podfile.lock')])
  const index = buildDependencyIndex(pins)

  it('matches a framework to the package that built it, across naming styles', () => {
    expect(index.match('Lottie.framework')?.version).toBe('4.4.1')
    expect(index.match('Collections.framework')?.version).toBe('1.1.0')
  })

  it('matches an exact pod name', () => {
    expect(index.match('SnapKit.framework')?.version).toBe('5.6.0')
  })

  it('does not invent a package for a Swift runtime dylib', () => {
    expect(index.match('libswiftCore.dylib')).toBeUndefined()
  })

  it('returns undefined for a framework no lockfile mentions', () => {
    expect(index.match('MyInternalKit.framework')).toBeUndefined()
  })
})

describe('diffPins', () => {
  it('reports a version bump with both sides', () => {
    const changes = diffPins({ Lottie: '4.3.0' }, { Lottie: '4.4.1' })
    expect(changes.get('lottie')).toEqual({ name: 'Lottie', from: '4.3.0', to: '4.4.1' })
  })

  it('reports an addition with no from', () => {
    expect(diffPins({}, { SnapKit: '5.6.0' }).get('snapkit')).toEqual({
      name: 'SnapKit',
      to: '5.6.0',
    })
  })

  it('reports a removal with no to', () => {
    expect(diffPins({ SnapKit: '5.6.0' }, {}).get('snapkit')).toEqual({
      name: 'SnapKit',
      from: '5.6.0',
    })
  })

  it('says nothing about an unchanged pin', () => {
    expect(diffPins({ Lottie: '4.3.0' }, { Lottie: '4.3.0' }).size).toBe(0)
  })
})
