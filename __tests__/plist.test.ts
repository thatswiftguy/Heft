import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseXmlPlist, readPlist } from '../src/core/plist.js'

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>MyApp</string>
	<key>CFBundleShortVersionString</key>
	<string>2.4.1</string>
	<key>CFBundleVersion</key>
	<string>1187</string>
	<key>DTXcodeBuild</key>
	<string>16C5032a</string>
	<key>DTSDKName</key>
	<string>iphoneos18.2</string>
	<key>MinimumOSVersion</key>
	<string>17.0</string>
	<key>UIRequiresFullScreen</key>
	<true/>
	<key>LSRequiresIPhoneOS</key>
	<false/>
	<key>NumericThing</key>
	<integer>42</integer>
	<key>Escaped</key>
	<string>A &amp; B &lt;C&gt;</string>
	<key>NestedDict</key>
	<dict>
		<key>CFBundleExecutable</key>
		<string>ShouldNotWin</string>
		<key>InnerOnly</key>
		<string>hidden</string>
	</dict>
	<key>SomeArray</key>
	<array>
		<string>one</string>
		<string>two</string>
	</array>
	<key>AfterTheNesting</key>
	<string>still read</string>
</dict>
</plist>
`

describe('parseXmlPlist', () => {
  const values = parseXmlPlist(XML)

  it('reads the top-level string keys the fingerprint needs', () => {
    expect(values['DTXcodeBuild']).toBe('16C5032a')
    expect(values['DTSDKName']).toBe('iphoneos18.2')
    expect(values['MinimumOSVersion']).toBe('17.0')
    expect(values['CFBundleShortVersionString']).toBe('2.4.1')
  })

  it('reads booleans and integers', () => {
    expect(values['UIRequiresFullScreen']).toBe(true)
    expect(values['LSRequiresIPhoneOS']).toBe(false)
    expect(values['NumericThing']).toBe(42)
  })

  it('decodes XML entities', () => {
    expect(values['Escaped']).toBe('A & B <C>')
  })

  it('ignores keys nested inside a child dict', () => {
    // A nested CFBundleExecutable must not overwrite the real one, and a key
    // that exists only inside the nesting must not surface as top-level.
    expect(values['CFBundleExecutable']).toBe('MyApp')
    expect(values['InnerOnly']).toBeUndefined()
  })

  it('resumes reading top-level keys after a nested dict and array', () => {
    // The depth counter has to come back to zero, or everything after the first
    // nesting is silently lost.
    expect(values['AfterTheNesting']).toBe('still read')
  })

  it('returns nothing for a plist with no dict', () => {
    expect(parseXmlPlist('<plist version="1.0"><array/></plist>')).toEqual({})
  })

  it('does not throw on truncated XML', () => {
    expect(() => parseXmlPlist('<plist><dict><key>A</key><string>b')).not.toThrow()
  })
})

describe('readPlist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heft-plist-'))

  it('reads an XML plist from disk without needing plutil', () => {
    const path = join(dir, 'Info.plist')
    writeFileSync(path, XML)
    expect(readPlist(path)['DTXcodeBuild']).toBe('16C5032a')
  })

  it('returns an empty object for a missing file, degrading the fingerprint', () => {
    // An unreadable Info.plist costs the toolchain guard, which downgrades the
    // run from gating to reporting. Far better than failing the check.
    expect(readPlist(join(dir, 'nope.plist'))).toEqual({})
  })

  it('returns an empty object for a file that is not a plist', () => {
    const path = join(dir, 'junk.plist')
    writeFileSync(path, 'this is not a plist')
    expect(readPlist(path)).toEqual({})
  })

  it('reads a binary plist via plutil where it is available', () => {
    let available = true
    const binary = join(dir, 'Binary.plist')
    writeFileSync(binary, XML)
    try {
      execFileSync('plutil', ['-convert', 'binary1', binary], { stdio: 'ignore' })
    } catch {
      available = false
    }
    if (!available) return
    // Confirm it really is binary now, then that we can still read it.
    expect(readPlist(binary)['DTXcodeBuild']).toBe('16C5032a')
    expect(readPlist(binary)['NumericThing']).toBe(42)
  })
})
