/**
 * In-memory activity log for the panel.
 *
 * Every agent tool call and every human panel action becomes one finished entry:
 * what happened, how long it took, the page it left behind, and whether it added
 * page errors. Entry ids are assigned when the action finishes, so a client that
 * asks for entries after `since` always receives their final state. A separate
 * `current` record names the action still running, which the panel shows as
 * "now" without waiting for it to finish.
 * @module dsh-browser-cockpit/lib/activity
 */

const MAX_ENTRIES = 60
const MAX_THUMBS = 30
const THUMB_WIDTH = 480
const THUMB_QUALITY = 58

/**
 * Capture one small JPEG of the current page for an entry.
 * @param {import('./browser.js').BrowserSession} session - the controlled page.
 * @returns {Promise<Buffer | null>}
 */
export async function captureThumbnail(session) {
  const state = session.getState()
  if (!state.running) return null
  try {
    return await session.capture({ format: 'jpeg', quality: THUMB_QUALITY, maxDimension: THUMB_WIDTH })
  } catch {
    return null
  }
}

/** Bounded log of the last browser actions. */
export class ActivityLog {
  #entries = []
  #thumbs = new Map()
  #pending = new Map()
  #nextId = 0
  #pendingSeq = 0

  /**
   * Start one action record.
   * @param {{ tool: string, source?: 'agent' | 'human', kind: string, detail?: object, errorCount?: number, sessionId?: string | null }} request - action facts.
   * @returns {{ id: string, at: number, tool: string, source: string, kind: string, detail: object, annotate: (patch: object) => void, errorCountBefore: number }}
   */
  begin(request) {
    const handle = {
      id: `p${++this.#pendingSeq}`,
      at: Date.now(),
      tool: request.tool,
      source: request.source ?? 'agent',
      kind: request.kind,
      detail: { ...(request.detail ?? {}) },
      sessionId: typeof request.sessionId === 'string' ? request.sessionId : null,
      errorCountBefore: request.errorCount ?? 0,
      /** Add facts discovered while the action ran, such as the clicked element label. */
      annotate(patch) {
        if (patch !== null && typeof patch === 'object') Object.assign(handle.detail, patch)
      },
    }
    this.#pending.set(handle.id, handle)
    return handle
  }

  /**
   * Finish one action and publish it to readers.
   * @param {object} handle - handle returned by `begin`.
   * @param {{ status: 'ok' | 'error', error?: string | null, page?: object | null, errorCount?: number, thumbnail?: Buffer | null }} outcome
   * @returns {object | null} the published entry.
   */
  finish(handle, outcome) {
    if (handle === undefined || handle === null) return null
    this.#pending.delete(handle.id)
    const finishedAt = Date.now()
    const page = outcome.page ?? null
    const entry = {
      id: ++this.#nextId,
      at: handle.at,
      finishedAt,
      durationMs: Math.max(0, finishedAt - handle.at),
      source: handle.source,
      tool: handle.tool,
      kind: handle.kind,
      sessionId: handle.sessionId,
      detail: { ...handle.detail },
      status: outcome.status,
      error: outcome.error ?? null,
      page: page === null ? null : { url: String(page.url ?? ''), title: String(page.title ?? '') },
      errorDelta: Math.max(0, (outcome.errorCount ?? 0) - handle.errorCountBefore),
      hasThumb: false,
    }
    const thumbnail = outcome.thumbnail ?? null
    if (thumbnail !== null && Buffer.isBuffer(thumbnail) && thumbnail.length > 0) {
      this.#thumbs.set(entry.id, thumbnail)
      entry.hasThumb = true
    }
    this.#entries.push(entry)
    this.#trim()
    return entry
  }

  /** @returns {object | null} the action still running, if any. */
  current() {
    const pending = [...this.#pending.values()].sort((left, right) => left.at - right.at)
    const last = pending[pending.length - 1]
    if (last === undefined) return null
    return { at: last.at, source: last.source, kind: last.kind, sessionId: last.sessionId, detail: { ...last.detail }, tool: last.tool }
  }

  /**
   * Read entries newer than one id.
   * @param {{ since?: number, limit?: number }} [options] - cursor and page size.
   * @returns {{ entries: object[], current: object | null, lastId: number }}
   */
  snapshot(options = {}) {
    const since = Number.isFinite(options.since) ? Number(options.since) : 0
    const limit = Number.isFinite(options.limit) ? Math.min(MAX_ENTRIES, Math.max(1, Math.round(options.limit))) : MAX_ENTRIES
    const entries = this.#entries
      .filter((entry) => entry.id > since)
      .slice(-limit)
      .map((entry) => ({ ...entry, detail: { ...entry.detail } }))
    return { entries, current: this.current(), lastId: this.#nextId }
  }

  /**
   * Read one stored thumbnail.
   * @param {number} id - entry id.
   * @returns {Buffer | null}
   */
  thumbnail(id) {
    return this.#thumbs.get(id) ?? null
  }

  #trim() {
    if (this.#entries.length > MAX_ENTRIES) {
      const removed = this.#entries.splice(0, this.#entries.length - MAX_ENTRIES)
      for (const entry of removed) {
        this.#thumbs.delete(entry.id)
        entry.hasThumb = false
      }
    }
    while (this.#thumbs.size > MAX_THUMBS) {
      const oldest = this.#thumbs.keys().next().value
      if (oldest === undefined) break
      this.#thumbs.delete(oldest)
      const entry = this.#entries.find((item) => item.id === oldest)
      if (entry !== undefined) entry.hasThumb = false
    }
  }
}
