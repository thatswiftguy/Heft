import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * Read the handful of `Info.plist` keys the toolchain fingerprint needs.
 *
 * A built app's `Info.plist` is a binary plist, so `plutil` does the work when
 * it is available. A pure-JS reader handles the XML form as well, which keeps
 * the fingerprint working -- and its tests runnable -- off macOS.
 *
 * Only flat string and number values are extracted. Nothing downstream needs
 * nested structure, and a full plist parser would be a lot of code in service
 * of keys nobody reads.
 */
export type PlistValues = Record<string, string | number | boolean>

/** Parse the XML plist form. Flat keys only. */
export function parseXmlPlist(text: string): PlistValues {
  const values: PlistValues = {}
  // Restrict to the top-level dict so nested dictionaries and arrays cannot
  // contribute keys that look top-level.
  const body = /<dict>([\s\S]*)<\/dict>/.exec(text)?.[1] ?? ''

  let depth = 0
  const pattern =
    // The backreference is to the tag group (4), not the value group (5).
    /<key>([\s\S]*?)<\/key>|<(dict|array)>|<\/(dict|array)>|<(string|integer|real)>([\s\S]*?)<\/\4>|<(true|false)\s*\/>/g
  let pendingKey: string | undefined

  for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
    const [, key, open, close, scalarTag, scalarValue, boolTag] = match
    if (open !== undefined) {
      depth += 1
      pendingKey = undefined
      continue
    }
    if (close !== undefined) {
      depth -= 1
      pendingKey = undefined
      continue
    }
    if (depth > 0) continue

    if (key !== undefined) {
      pendingKey = decode(key.trim())
      continue
    }
    if (pendingKey === undefined) continue

    if (scalarTag === 'string') values[pendingKey] = decode((scalarValue ?? '').trim())
    else if (scalarTag !== undefined) values[pendingKey] = Number((scalarValue ?? '').trim())
    else if (boolTag !== undefined) values[pendingKey] = boolTag === 'true'
    pendingKey = undefined
  }
  return values
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Flatten `plutil`'s JSON to the scalar keys we care about. */
function flatten(parsed: unknown): PlistValues {
  if (typeof parsed !== 'object' || parsed === null) return {}
  const values: PlistValues = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      values[key] = value
    }
  }
  return values
}

/** Convert a plist of either form via `plutil`. Undefined when unavailable. */
export function readPlistViaPlutil(path: string): PlistValues | undefined {
  try {
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', path], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return flatten(JSON.parse(json))
  } catch {
    return undefined
  }
}

/**
 * Read a plist from disk, binary or XML.
 *
 * Returns an empty object rather than throwing: an unreadable `Info.plist`
 * costs the toolchain fingerprint, which downgrades the run from "gate" to
 * "report", and that is a far better outcome than failing the check.
 */
export function readPlist(path: string): PlistValues {
  let raw: Buffer
  try {
    raw = readFileSync(path)
  } catch {
    return {}
  }

  if (raw.subarray(0, 6).toString('latin1') === 'bplist') {
    return readPlistViaPlutil(path) ?? {}
  }
  const text = raw.toString('utf8')
  if (text.includes('<plist')) return parseXmlPlist(text)
  return readPlistViaPlutil(path) ?? {}
}

/** Read one member of a zip as text, for an `.ipa`'s `Info.plist`. */
export function readPlistFromZip(archivePath: string, member: string): PlistValues {
  try {
    const raw = execFileSync('unzip', ['-p', archivePath, member], {
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (raw.subarray(0, 6).toString('latin1') === 'bplist') {
      // plutil cannot read a stream, so this needs a real file. Skipped rather
      // than staged to a temp path: an ipa is the one input where the app was
      // never unpacked, and unpacking it here would be a surprising cost.
      return {}
    }
    const text = raw.toString('utf8')
    return text.includes('<plist') ? parseXmlPlist(text) : {}
  } catch {
    return {}
  }
}
