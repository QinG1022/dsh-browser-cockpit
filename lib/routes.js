/**
 * Local HTTP surface for the sidebar panel.
 *
 * The panel is a React page in the same origin as the Harness, so it reads the
 * browser state and the live frame over these routes instead of a generated
 * Remote namespace. Only the loopback Harness port serves them, and the routes
 * never leave the machine.
 * @module dsh-browser-cockpit/lib/routes
 */

import { captureThumbnail } from './activity.js'
import { openTarget } from './targets.js'

const BASE_PATH = '/plugin/browser-control'
const STATE_PATH = `${BASE_PATH}/state`
const FRAME_PATH = `${BASE_PATH}/frame.jpg`
const STREAM_PATH = `${BASE_PATH}/stream`
const ACTION_PATH = `${BASE_PATH}/action`
const ACTIVITY_PATH = `${BASE_PATH}/activity`
const OVERVIEW_PATH = `${BASE_PATH}/overview`
const OVERVIEW_STREAM_PATH = `${BASE_PATH}/overview/stream`
const OVERVIEW_FRAME_PATH = `${BASE_PATH}/overview/frame.jpg`
const OVERVIEW_ACTION_PATH = `${BASE_PATH}/overview/action`
const SESSION_FRAME_PATH = `${BASE_PATH}/session/frame.jpg`
const THUMB_PREFIX = `${BASE_PATH}/thumb/`
const MAX_BODY_BYTES = 64 * 1024
const FRAME_FRESH_MS = 700
// A live grid can otherwise write JPEG frames faster than a browser consumes
// them. Once a response has this much unread data, skip frames until drain.
const SSE_BUFFER_LIMIT = 256 * 1024
const OVERVIEW_FRAME_QUALITY = 52
const OVERVIEW_FRAME_WIDTH = 720
const OVERVIEW_INTERVAL_MS = 2000
const OVERVIEW_REFRESH_MS = 6000

/**
 * Whether a Host header points at the local machine. Rejecting other hosts
 * closes the DNS-rebinding hole opened by a loopback-only panel.
 * @param {string | undefined} header - the request Host header.
 * @returns {boolean}
 */
function isLoopbackHost(header) {
  if (typeof header !== 'string' || header.trim() === '') return false
  const value = header.trim()
  const name = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : value.split(':')[0]
  return name === 'localhost' || name === '::1' || /^127\./u.test(name)
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

function sendJpeg(res, buffer) {
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': buffer.length,
  })
  res.end(buffer)
}

/**
 * Read a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<object>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Register the panel routes on the Harness web server.
 * @param {object} ctx - host context with the `webServer` service.
 * @param {import('./browser.js').BrowserSession} session - the controlled page.
 * @param {(url: string) => { target: string, cleanAfterLoad: boolean }} resolveTarget - address resolver.
 * @param {import('./activity.js').ActivityLog} activity - the panel's action log.
 * @returns {() => void} the route disposer.
 */
export function registerPanelRoutes(ctx, session, resolveTarget, activity) {
  const frame = { buffer: null, at: 0 }
  const overviewFrames = new Map()
  let inFlight = null
  let origin
  try {
    origin = new URL(ctx.webServer.getOrigin()).origin
  } catch {
    origin = undefined
  }
  const fromPanel = (req) => {
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
    if (origin === undefined) return true
    const header = req.headers.origin
    // A same-origin GET has no Origin header; a cross-site form POST always sends one.
    return typeof header !== 'string' || header === origin
  }

  const currentFrame = async () => {
    const screencast = session.screencastFrame
    if (screencast !== null && Date.now() - screencast.at < FRAME_FRESH_MS) return screencast.buffer
    if (frame.buffer !== null && Date.now() - frame.at < FRAME_FRESH_MS) return frame.buffer
    if (inFlight !== null) return inFlight
    const job = (async () => {
      const buffer = await session.capture({ format: 'jpeg', quality: 62, maxDimension: 1400 })
      frame.buffer = buffer
      frame.at = Date.now()
      return buffer
    })()
    inFlight = job
    const done = () => { if (inFlight === job) inFlight = null }
    job.then(done, done)
    return job
  }

  /**
   * Run one human panel action and publish it to the activity timeline.
   * @param {string} kind - action name used by the client's label table.
   * @param {object} detail - action parameters.
   * @param {() => Promise<void>} run - the action.
   */
  const logHuman = async (kind, detail, run) => {
    const before = session.getState()
    const handle = activity.begin({
      tool: `panel:${kind}`,
      source: 'human',
      kind,
      detail,
      errorCount: before.errorCount,
      sessionId: before.activeSessionId ?? null,
    })
    try {
      await run()
      const after = session.getState()
      const thumbnail = kind === 'close' ? null : await captureThumbnail(session)
      activity.finish(handle, { status: 'ok', page: after, errorCount: after.errorCount, thumbnail })
    } catch (error) {
      const after = session.getState()
      activity.finish(handle, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        page: after,
        errorCount: after.errorCount,
      })
      throw error
    }
  }

  const handler = async (req, res) => {
    let pathname
    let query
    try {
      const parsed = new URL(req.url ?? BASE_PATH, 'http://127.0.0.1')
      pathname = parsed.pathname
      query = parsed.searchParams
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid request URL' })
      return
    }
    const sessionId = query.get('sessionId')
    const sessionActive = session.getStateForSession(sessionId).sessionActive === true
    if (!isLoopbackHost(req.headers.host)) {
      sendJson(res, 403, { ok: false, error: 'only loopback hosts may use the browser panel' })
      return
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      sendJson(res, 403, { ok: false, error: 'cross-site requests are refused' })
      return
    }
    try {
      if (req.method === 'GET' && pathname === STATE_PATH) {
        sendJson(res, 200, session.getStateForSession(sessionId))
        return
      }
      if (req.method === 'GET' && pathname === STREAM_PATH) {
        if (sessionId !== null && !sessionActive) {
          sendJson(res, 409, { ok: false, error: 'another conversation is using the browser page' })
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write(': connected\n\n')
        let closed = false
        let unsubscribe
        let heartbeat
        const cleanup = () => {
          if (closed) return
          closed = true
          if (heartbeat !== undefined) clearInterval(heartbeat)
          if (unsubscribe !== undefined) void unsubscribe()
        }
        let lastSentAt = 0
        const sendFrame = (buffer, metadata) => {
          if (closed || res.writableLength > SSE_BUFFER_LIMIT) return
          const now = Date.now()
          // A static page can produce hundreds of frames per second. The panel
          // only needs a smooth preview; coalesce to at most ~8 fps.
          if (now - lastSentAt < 120) return
          lastSentAt = now
          res.write(`event: frame\ndata: ${buffer.toString('base64')}\n\n`)
          if (metadata !== undefined) res.write(': meta\n\n')
        }
        req.on('close', cleanup)
        res.on('close', cleanup)
        res.on('error', cleanup)
        try {
          const initial = session.screencastFrame
          if (initial !== null) sendFrame(initial.buffer, initial.metadata)
          const unsubscribeStream = await session.subscribeScreencast(sendFrame, { quality: 58 })
          if (closed) {
            await unsubscribeStream()
            return
          }
          unsubscribe = unsubscribeStream
          heartbeat = setInterval(() => {
            if (!closed) res.write(': ping\n\n')
          }, 15000)
        } catch (error) {
          cleanup()
          if (!res.writableEnded) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n\n`)
            res.end()
          }
        }
        return
      }
      if (req.method === 'GET' && pathname === OVERVIEW_PATH) {
        sendJson(res, 200, session.getOverview())
        return
      }
      if (req.method === 'GET' && pathname === SESSION_FRAME_PATH) {
        const targetSession = query.get('sessionId')
        if (targetSession === null || targetSession === '') {
          sendJson(res, 400, { ok: false, error: 'a sessionId is required' })
          return
        }
        const known = session.getOverview().sessions.some((entry) => entry.sessionId === targetSession)
        if (!known) {
          sendJson(res, 404, { ok: false, error: 'this conversation has no open browser' })
          return
        }
        const requested = Number(query.get('w') ?? '1280')
        const width = Number.isFinite(requested) ? Math.min(1600, Math.max(80, Math.round(requested))) : 1280
        try {
          sendJpeg(res, await session.captureSessionFrame(targetSession, { quality: 60, maxWidth: width }))
          return
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const status = /Harness UI|recursive capture/iu.test(message) ? 403 : 503
          sendJson(res, status, { ok: false, error: message })
          return
        }
      }
      if (req.method === 'GET' && pathname === OVERVIEW_FRAME_PATH) {
        const targetSession = query.get('sessionId')
        if (targetSession === null || targetSession === '') {
          sendJson(res, 400, { ok: false, error: 'a sessionId is required' })
          return
        }
        try {
          const cached = session.getSessionFrame(targetSession)
          if (cached !== null) {
            sendJpeg(res, cached.buffer)
            return
          }
          sendJpeg(res, await session.captureSessionFrame(targetSession, {
            quality: OVERVIEW_FRAME_QUALITY,
            maxWidth: OVERVIEW_FRAME_WIDTH,
          }))
          return
        } catch (error) {
          sendJson(res, 503, { ok: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
      }
      if (req.method === 'GET' && pathname === OVERVIEW_STREAM_PATH) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write(': connected\n\n')
        let closed = false
        let backpressured = false
        let heartbeat
        let refresh
        let capturing = false
        const cleanup = () => {
          if (closed) return
          closed = true
          if (heartbeat !== undefined) clearInterval(heartbeat)
          if (refresh !== undefined) clearInterval(refresh)
        }
        const send = (event, data) => {
          if (closed || backpressured || (Number(res.writableLength) || 0) > SSE_BUFFER_LIMIT) {
            backpressured = true
            return false
          }
          const ok = res.write(`event: ${event}\ndata: ${data}\n\n`)
          if (!ok) backpressured = true
          return ok
        }
        const sync = () => {
          send('sessions', JSON.stringify(session.getOverview()))
        }
        const capture = async () => {
          if (closed || capturing || backpressured) return
          capturing = true
          try {
            const now = Date.now()
            const liveSessions = new Set()
            for (const entry of session.getOverview().sessions) {
              if (closed || backpressured) return
              liveSessions.add(entry.sessionId)
              const cached = overviewFrames.get(entry.sessionId)
              const changed = entry.lastActivityAt > (cached?.at ?? 0)
              const stale = cached === undefined || now - cached.at > OVERVIEW_REFRESH_MS
              if (!changed && !stale) continue
              try {
                const buffer = await session.captureSessionFrame(entry.sessionId, {
                  quality: OVERVIEW_FRAME_QUALITY,
                  maxWidth: OVERVIEW_FRAME_WIDTH,
                })
                if (buffer.length > SSE_BUFFER_LIMIT) continue
                overviewFrames.set(entry.sessionId, { at: now, buffer })
                send('frame', JSON.stringify({ sessionId: entry.sessionId, jpeg: buffer.toString('base64') }))
              } catch {
                // A closing context can disappear while the stream is being written.
              }
            }
            for (const id of overviewFrames.keys()) {
              if (!liveSessions.has(id)) overviewFrames.delete(id)
            }
          } finally {
            capturing = false
          }
        }
        req.on('close', cleanup)
        res.on('close', cleanup)
        res.on('error', cleanup)
        res.on('drain', () => { backpressured = false })
        try {
          sync()
          void capture()
          refresh = setInterval(() => {
            sync()
            void capture()
          }, OVERVIEW_INTERVAL_MS)
          heartbeat = setInterval(() => {
            if (!closed && !backpressured) res.write(': ping\n\n')
          }, 15000)
        } catch (error) {
          cleanup()
          if (!res.writableEnded) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n\n`)
            res.end()
          }
        }
        return
      }
      if (req.method === 'POST' && pathname === OVERVIEW_ACTION_PATH) {
        if (!fromPanel(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin requests are refused' })
          return
        }
        if (typeof req.headers['content-type'] !== 'string' || !req.headers['content-type'].toLowerCase().startsWith('application/json')) {
          sendJson(res, 415, { ok: false, error: 'overview actions require a JSON request body' })
          return
        }
        const body = await readJsonBody(req)
        const action = typeof body.action === 'string' ? body.action : ''
        const targetSession = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (targetSession === '') {
          sendJson(res, 400, { ok: false, error: 'a sessionId is required' })
          return
        }
        try {
          if (action === 'focus') await session.focusSession(targetSession)
          else if (action === 'close') await session.closeSession(targetSession)
          else if (action === 'open') {
            await session.enterSession(targetSession)
            await session.focusSession(targetSession)
          } else {
            sendJson(res, 400, { ok: false, error: `unknown overview action "${action}"` })
            return
          }
          sendJson(res, 200, { ok: true, overview: session.getOverview() })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (req.method === 'GET' && pathname === ACTIVITY_PATH) {
        const since = Number(query.get('since') ?? '0')
        sendJson(res, 200, activity.snapshot({ since: Number.isFinite(since) ? since : 0 }))
        return
      }
      if (req.method === 'GET' && pathname.startsWith(THUMB_PREFIX)) {
        const id = Number(pathname.slice(THUMB_PREFIX.length))
        const buffer = Number.isInteger(id) ? activity.thumbnail(id) : null
        if (buffer === null) {
          sendJson(res, 404, { ok: false, error: 'thumbnail not found' })
          return
        }
        sendJpeg(res, buffer)
        return
      }
      if (req.method === 'GET' && pathname === FRAME_PATH) {
        if (sessionId !== null && !sessionActive) {
          sendJson(res, 409, { ok: false, error: 'another conversation is using the browser page' })
          return
        }
        const state = session.getState()
        if (!state.running) {
          sendJson(res, 503, { ok: false, error: 'the browser is not running' })
          return
        }
        try {
          sendJpeg(res, await currentFrame())
          return
        } catch (error) {
          if (frame.buffer !== null) {
            sendJpeg(res, frame.buffer)
            return
          }
          sendJson(res, 503, { ok: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
      }
      if (req.method === 'POST' && pathname === ACTION_PATH) {
        if (!fromPanel(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin requests are refused' })
          return
        }
        if (typeof req.headers['content-type'] !== 'string' || !req.headers['content-type'].toLowerCase().startsWith('application/json')) {
          sendJson(res, 415, { ok: false, error: 'actions require a JSON request body' })
          return
        }
        const body = await readJsonBody(req)
        const action = typeof body.action === 'string' ? body.action : ''
        switch (action) {
          case 'open': {
            const url = typeof body.url === 'string' ? body.url : ''
            if (url.trim() === '') {
              sendJson(res, 400, { ok: false, error: 'a URL is required' })
              return
            }
            await logHuman('open', { url }, () => openTarget(session, resolveTarget, url))
            break
          }
          case 'reload':
            await logHuman('reload', {}, () => session.reload())
            break
          case 'launch':
            await logHuman('launch', {}, () => session.ensureStarted())
            break
          case 'close':
            await logHuman('close', {}, () => session.close())
            break
          case 'resize':
            await logHuman('resize', {
              width: typeof body.width === 'number' ? body.width : undefined,
              height: typeof body.height === 'number' ? body.height : undefined,
            }, () => session.resize({
              width: typeof body.width === 'number' ? body.width : undefined,
              height: typeof body.height === 'number' ? body.height : undefined,
            }))
            break
          default:
            sendJson(res, 400, { ok: false, error: `unknown action "${action}"` })
            return
        }
        sendJson(res, 200, { ok: true, state: session.getState() })
        return
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return ctx.webServer.register({ kind: 'prefix', path: BASE_PATH, handler })
}
