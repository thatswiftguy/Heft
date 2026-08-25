import { frameworkNameOf } from './manifest.js'
import type { PinChange } from './lockfiles.js'
import type { Cause, Category, Entry } from './types.js'

/**
 * Decide *why* something changed size, and which changes are really one change.
 *
 * The difference between a tolerable size check and an ignored one is mostly
 * here. "Frameworks/Lottie.framework/Lottie +184 KB" is a fact a reviewer has
 * to go and investigate; "Lottie 4.3.0 -> 4.4.1" is the answer they were going
 * to arrive at.
 */

/**
 * Grouping key: entries sharing one are reported as a single row.
 *
 * Three collapses happen here, and each removes a class of noise that would
 * otherwise get the whole comment skimmed past:
 *
 * - **A framework's files collapse onto the framework.** A version bump moves
 *   the binary, its `Info.plist`, its nib and its own asset catalog. That is one
 *   event, not five rows.
 * - **A dependency's frameworks collapse onto the dependency.** Firebase ships
 *   a dozen frameworks from one pin; bumping it should read as one line.
 * - **Everything else stays itself.** Renditions and loose resources are already
 *   the right granularity -- an image is the thing the developer changed.
 */
export function groupKeyOf(entry: Entry): string {
  if (entry.dependency !== undefined) return `dependency:${entry.dependency}`
  if (entry.category === 'framework') {
    const framework = frameworkNameOf(entry.path)
    if (framework !== undefined) return `framework:${framework}`
  }
  // An asset's renditions collapse onto the asset. Adding one image to a
  // catalog produces a vector plus @1x, @2x and @3x -- four rows for one thing
  // the developer did. The multiplicity still shows, in the reason column.
  if (entry.rendition !== undefined) {
    return `asset:${entry.path}#${entry.rendition.name}`
  }
  return `entry:${entry.id}`
}

/**
 * Human label for a group, chosen from whichever side has an entry.
 *
 * @param renditions how many renditions collapsed into this row; when more than
 *                   one, the scale is dropped because the row covers all of them
 */
export function labelFor(entry: Entry, renditions = 1): string {
  if (entry.rendition !== undefined) {
    const { name, scale, idiom, kind } = entry.rendition
    if (renditions > 1) return name
    const parts = [name]
    if (scale !== undefined) parts.push(`@${scale}x`)
    // Vector and data assets carry no scale, and a catalog full of them yields
    // rows labelled `2` or `6` that tell a reviewer nothing. Naming the kind is
    // what makes such a row identifiable.
    else if (kind !== undefined && kind !== 'Image') parts.push(`(${kind})`)
    // Only mention the idiom when it is not the default, to keep rows short.
    if (idiom !== undefined && idiom !== 'universal') parts.push(`(${idiom})`)
    return parts.join(' ')
  }
  if (entry.dependency !== undefined) {
    return frameworkNameOf(entry.path) ?? entry.dependency
  }
  if (entry.category === 'framework') {
    return frameworkNameOf(entry.path) ?? entry.path
  }
  return entry.path
}

export interface AttributeInput {
  /** A representative entry for the group, preferring the head side. */
  entry: Entry
  category: Category
  /** True when the group exists only at head. */
  added: boolean
  /** True when the group existed only at base. */
  removed: boolean
  /** Pin changes, keyed by lowercased package name. */
  pinChanges: Map<string, PinChange>
  /** How many asset renditions collapsed into this row. */
  renditions?: number
}

/**
 * Work out the cause of one group's change.
 *
 * The dependency case is checked first and deliberately: when a framework grew
 * *and* its pin moved, the pin is the cause and the framework delta is its
 * consequence. Reporting both would be reporting the same event twice.
 */
export function attribute(input: AttributeInput): Cause {
  const { entry, added, removed, pinChanges } = input

  if (entry.dependency !== undefined) {
    const change = pinChanges.get(entry.dependency.toLowerCase())
    if (change !== undefined) {
      if (change.from !== undefined && change.to !== undefined) {
        return {
          kind: 'dependency',
          detail: `dependency \`${change.from} → ${change.to}\``,
          dependency: change.name,
          from: change.from,
          to: change.to,
        }
      }
      if (change.to !== undefined) {
        return {
          kind: 'dependency',
          detail: `new dependency \`${change.to}\``,
          dependency: change.name,
          to: change.to,
        }
      }
      return {
        kind: 'dependency',
        detail: `dependency removed (was \`${change.from ?? '?'}\`)`,
        dependency: change.name,
        ...(change.from === undefined ? {} : { from: change.from }),
      }
    }
    // Same pin, different bytes. Worth saying explicitly: it usually means a
    // rebuild, a toolchain change, or a vendored binary swapped underneath.
    return {
      kind: 'framework',
      detail: 'rebuilt, same version',
      dependency: entry.dependency,
    }
  }

  if (entry.rendition !== undefined) {
    if (entry.rendition.name === '(catalog overhead)') {
      return { kind: 'asset', detail: 'asset catalog indexes' }
    }
    // Say how many renditions moved, so a row covering four scales does not
    // read as a single image and understate what was added.
    const count = input.renditions ?? 1
    const suffix = count > 1 ? `, ${count} renditions` : ''
    if (added) return { kind: 'asset', detail: `new asset${suffix}` }
    if (removed) return { kind: 'asset', detail: `asset removed${suffix}` }
    return { kind: 'asset', detail: `asset re-encoded${suffix}` }
  }

  switch (entry.category) {
    case 'framework':
      if (added) return { kind: 'framework', detail: 'new framework' }
      if (removed) return { kind: 'framework', detail: 'framework removed' }
      return { kind: 'framework', detail: 'framework changed' }
    case 'executable':
      return { kind: 'executable', detail: 'app binary' }
    case 'asset':
      // An unexpanded catalog: assetutil could not read it.
      return { kind: 'asset', detail: 'asset catalog (not broken down)' }
    case 'resource':
      if (added) return { kind: 'resource', detail: 'new resource' }
      if (removed) return { kind: 'resource', detail: 'resource removed' }
      return { kind: 'resource', detail: 'resource changed' }
    default:
      if (added) return { kind: 'other', detail: 'added' }
      if (removed) return { kind: 'other', detail: 'removed' }
      return { kind: 'other', detail: 'changed' }
  }
}

/**
 * Where to hang an inline annotation for a cause.
 *
 * Only dependency bumps get one, because only they have a location a reviewer
 * can act on: the lockfile line carrying the pin. An asset has a path but no
 * line, and annotating line 1 of a binary `.car` helps nobody.
 */
export function locationFor(
  cause: Cause,
  pinLocations: Record<string, { file: string; line: number }> | undefined,
): { file: string; line?: number } | undefined {
  if (cause.kind !== 'dependency' || cause.dependency === undefined) return undefined
  const location = pinLocations?.[cause.dependency]
  if (location === undefined) return undefined
  return { file: location.file, line: location.line }
}
