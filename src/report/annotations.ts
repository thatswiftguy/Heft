import { bytes } from './model.js'
import type { Delta } from '../core/types.js'

/**
 * Inline annotations, for the changes that have a location worth pointing at.
 *
 * Only dependency bumps qualify. The lockfile line carrying the pin is
 * somewhere a reviewer can actually go and act; an asset has a path but no
 * line, and annotating line 1 of a binary `.car` is noise dressed as help.
 */
export interface Annotation {
  level: 'warning' | 'notice'
  file: string
  line?: number
  title: string
  message: string
}

/** GitHub renders at most ten annotations per level per step. */
const MAX_PER_LEVEL = 10

export interface AnnotationPlan {
  annotations: Annotation[]
  totalDropped: number
}

export function planAnnotations(deltas: Delta[], gated: boolean): AnnotationPlan {
  const candidates = deltas.filter(
    (delta) => delta.location !== undefined && delta.downloadDelta > 0,
  )

  const annotations: Annotation[] = candidates.map((delta) => ({
    // A notice rather than a warning when the run is not gating, so an
    // ungated informational run does not decorate the diff with warnings.
    level: gated ? 'warning' : 'notice',
    file: delta.location!.file,
    ...(delta.location!.line === undefined ? {} : { line: delta.location!.line }),
    title: `+${bytes(delta.downloadDelta)} download`,
    message: `${delta.label}: ${delta.cause.detail} adds ${bytes(delta.downloadDelta)} to the download size.`,
  }))

  const kept = annotations.slice(0, MAX_PER_LEVEL)
  return { annotations: kept, totalDropped: annotations.length - kept.length }
}
