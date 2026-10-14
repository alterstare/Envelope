// Inside Halftone Env runs in a frame of Halftone's window (the reader's right
// panel). The host app then owns the look and the bottom bar: Env follows the
// host's theme and hands its job progress to the host's activity bar.
import type { ProgressEvent } from '../../shared/types'

export const embedded = window.parent !== window

// The host page (same origin), or null when standalone / not reachable.
function hostDocument(): Document | null {
  try {
    return embedded ? window.parent.document : null
  } catch {
    return null
  }
}

// Mirror the host's <html data-theme> now and whenever it changes.
export function followHostTheme(apply: (theme: string) => void): () => void {
  const doc = hostDocument()
  if (!doc) return () => {}
  const read = (): void => apply(doc.documentElement.dataset.theme || 'light')
  read()
  const mo = new MutationObserver(read)
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => mo.disconnect()
}

// Message the host's activity bar listens for.
export interface EnvJobMessage {
  type: 'env-job'
  event: ProgressEvent
}
export function postJob(event: ProgressEvent): void {
  if (embedded) window.parent.postMessage({ type: 'env-job', event } satisfies EnvJobMessage, '*')
}
