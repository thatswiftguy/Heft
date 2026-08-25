import { closeSync, openSync, readSync, statSync } from 'node:fs'
import type { Bytes } from './types.js'

/**
 * A central-directory-only zip reader.
 *
 * An `.ipa` is a zip, and its central directory already records the compressed
 * and uncompressed size of every member. That is worth reaching for: it turns
 * per-file download apportionment from a modelled guess into a measurement.
 *
 * Written by hand rather than taken as a dependency because the requirement is
 * narrow -- names and two sizes, never the contents -- and because owning the
 * parse means owning the failure mode: anything unexpected degrades to "treat
 * this archive as opaque" instead of throwing out of a third-party stream.
 */

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

export interface ZipEntry {
  /** Path as stored, with forward slashes. */
  name: string
  compressedBytes: Bytes
  uncompressedBytes: Bytes
  /** True when the Unix mode in the external attributes says symlink. */
  symlink: boolean
  /** True for a directory member, which occupies no space. */
  directory: boolean
}

const EOCD_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50

const EOCD_SIZE = 22
const ZIP64_LOCATOR_SIZE = 20
/** A zip comment can be 64 KB, so the EOCD can sit that far from the end. */
const MAX_COMMENT = 0xffff

/** S_IFLNK in the high 16 bits of the external file attributes. */
const S_IFMT = 0xf000
const S_IFLNK = 0xa000

/** Reads the whole central directory of a zip and returns its members. */
export function readZipEntries(path: string): ZipEntry[] {
  const size = statSync(path).size
  if (size < EOCD_SIZE) throw new ZipError(`${path}: too small to be a zip`)

  const fd = openSync(path, 'r')
  try {
    const { centralOffset, centralSize, entryCount } = readEndRecord(fd, size, path)
    if (centralOffset + centralSize > size) {
      throw new ZipError(`${path}: central directory runs past the end of the file`)
    }
    const central = read(fd, centralOffset, centralSize)
    return parseCentralDirectory(central, entryCount, path)
  } finally {
    closeSync(fd)
  }
}

function read(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length)
  let read = 0
  while (read < length) {
    const got = readSync(fd, buffer, read, length - read, position + read)
    if (got === 0) break
    read += got
  }
  return read === length ? buffer : buffer.subarray(0, read)
}

interface EndRecord {
  centralOffset: number
  centralSize: number
  entryCount: number
}

function readEndRecord(fd: number, size: number, path: string): EndRecord {
  // Scan backwards for the EOCD signature: the record is last, but a trailing
  // archive comment of up to 64 KB can sit after it.
  const tailLength = Math.min(size, EOCD_SIZE + MAX_COMMENT)
  const tail = read(fd, size - tailLength, tailLength)

  let eocd = -1
  for (let offset = tail.length - EOCD_SIZE; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset
      break
    }
  }
  if (eocd === -1) throw new ZipError(`${path}: no end-of-central-directory record found`)

  let entryCount = tail.readUInt16LE(eocd + 10)
  let centralSize = tail.readUInt32LE(eocd + 12)
  let centralOffset = tail.readUInt32LE(eocd + 16)

  // Any of the three saturated means the real values live in a zip64 record.
  // An .ipa can legitimately exceed 4 GB -- the App Store cap is 4 GB
  // uncompressed -- so this is a real case, not a theoretical one.
  const saturated =
    entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
  if (saturated) {
    const locator = eocd - ZIP64_LOCATOR_SIZE
    if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new ZipError(`${path}: zip64 sizes indicated but no zip64 locator found`)
    }
    const zip64Offset = Number(tail.readBigUInt64LE(locator + 8))
    const zip64 = read(fd, zip64Offset, 56)
    if (zip64.length < 56 || zip64.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
      throw new ZipError(`${path}: zip64 end-of-central-directory record is unreadable`)
    }
    entryCount = Number(zip64.readBigUInt64LE(32))
    centralSize = Number(zip64.readBigUInt64LE(40))
    centralOffset = Number(zip64.readBigUInt64LE(48))
  }

  return { centralOffset, centralSize, entryCount }
}

function parseCentralDirectory(buffer: Buffer, entryCount: number, path: string): ZipEntry[] {
  const entries: ZipEntry[] = []
  let offset = 0

  while (offset + 46 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) break

    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const externalAttributes = buffer.readUInt32LE(offset + 38)

    let compressedBytes = buffer.readUInt32LE(offset + 20)
    let uncompressedBytes = buffer.readUInt32LE(offset + 24)

    const nameStart = offset + 46
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8')
    const extraStart = nameStart + nameLength

    if (uncompressedBytes === 0xffffffff || compressedBytes === 0xffffffff) {
      const zip64 = readZip64Extra(buffer.subarray(extraStart, extraStart + extraLength))
      if (zip64.uncompressed !== undefined) uncompressedBytes = zip64.uncompressed
      if (zip64.compressed !== undefined) compressedBytes = zip64.compressed
    }

    const mode = (externalAttributes >>> 16) & 0xffff
    entries.push({
      name,
      compressedBytes,
      uncompressedBytes,
      symlink: (mode & S_IFMT) === S_IFLNK,
      directory: name.endsWith('/'),
    })

    offset = extraStart + extraLength + commentLength
  }

  // A short read is worth saying out loud: silently reporting a partial file
  // list would understate the app, which is the one direction a size tool must
  // never round.
  if (entryCount > 0 && entries.length < entryCount) {
    throw new ZipError(
      `${path}: central directory lists ${entryCount} entries but only ${entries.length} could be read`,
    )
  }
  return entries
}

/** Zip64 extended information extra field (header id 0x0001). */
function readZip64Extra(extra: Buffer): { uncompressed?: number; compressed?: number } {
  let offset = 0
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset)
    const size = extra.readUInt16LE(offset + 2)
    const body = offset + 4
    if (id === 0x0001) {
      const result: { uncompressed?: number; compressed?: number } = {}
      if (size >= 8 && body + 8 <= extra.length) {
        result.uncompressed = Number(extra.readBigUInt64LE(body))
      }
      if (size >= 16 && body + 16 <= extra.length) {
        result.compressed = Number(extra.readBigUInt64LE(body + 8))
      }
      return result
    }
    offset = body + size
  }
  return {}
}
