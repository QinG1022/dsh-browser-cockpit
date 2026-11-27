/**
 * Local UI lab for the browser cockpit panel.
 *
 * This is intentionally NOT the DSH app: it serves the real `client.js`
 * against a small mock of its panel API, so the overview and the per-session
 * page can be inspected in a normal Chrome tab without putting the Harness UI
 * inside the controlled browser (which caused a recursive screenshot loop).
 *
 * Run: node dev-check/lab/server.mjs
 * Then open the printed http://127.0.0.1:<port>/ URL in Chrome.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LAB = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(LAB, '..', '..')
const FRAME_A = fs.readFileSync(path.join(LAB, 'frame-a.jpg'))
const FRAME_B = fs.readFileSync(path.join(LAB, 'frame-b.jpg'))
const FRAME_A_B64 = FRAME_A.toString('base64')
const FRAME_B_B64 = FRAME_B.toString('base64')

const sessions = [
  {
    sessionId: 'lab-session-a',
    title: '本地演示 · 会话 A',
    url: 'https://example.test/app',
    pageTitle: 'Demo app',
    running: true,
    phase: 'running',
    active: true,
  },
  {
    sessionId: 'lab-session-b',
    title: '本地演示 · 会话 B',
    url: 'https://example.test/settings',
    pageTitle: 'Settings',
    running: true,
    phase: 'running',
    active: false,
  },
  {
    sessionId: 'lab-session-c',
    title: '本地演示 · 会话 C',
    url: 'https://example.test/docs',
    pageTitle: 'Docs',
    running: false,
    phase: 'stopped',
    active: false,
    errorCount: 1,
    recentErrors: [{ text: 'TypeError: demo failure', at: Date.now() - 5_000, url: 'https://example.test/docs' }],
  },
]
let activeSessionId = 'lab-session-a'

function conversations() {
  const open = new Set(sessions.map((entry) => entry.sessionId))
  return {
    activeSessionId,
    sessions: [
      ...sessions.map((entry, index) => ({
        sessionId: entry.sessionId,
        title: entry.title,
        hasBrowser: open.has(entry.sessionId),
        createdAt: Date.now() - index * 60_000,
      })),
      ...(open.has('lab-session-new') ? [] : [{
        sessionId: 'lab-session-new',
        title: '尚未打开浏览器的会话',
        hasBrowser: false,
        createdAt: Date.now() + 1,
      }]),
    ],
    updatedAt: Date.now(),
  }
}

function overview() {
  return {
    activeSessionId,
    sessions: sessions.map((entry) => ({
      ...entry,
      active: entry.sessionId === activeSessionId,
      createdAt: Date.now() - 60_000,
      lastActivityAt: Date.now() - 2_000,
      hasFrame: true,
      frameAt: Date.now(),
      width: 480,
      height: 300,
    })),
    updatedAt: new Date().toISOString(),
  }
}

function state() {
  const active = sessions.find((entry) => entry.sessionId === activeSessionId) ?? sessions[0]
  return {
    running: sessions.length > 0,
    phase: sessions.length > 0 ? 'running' : 'stopped',
    url: active?.url ?? '',
    title: active?.pageTitle ?? '',
    width: 1200,
    height: 800,
    sessionCount: sessions.length,
    activeSessionId: sessions.length > 0 ? activeSessionId : null,
    sessions: overview().sessions,
    errorCount: 0,
    startedAt: Date.now() - 60_000,
    screencast: true,
  }
}

function frameFor(sessionId) {
  return sessionId === 'lab-session-b' ? FRAME_B : FRAME_A
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')
  return (event, data) => {
    if (res.writableEnded || res.writableLength > 256 * 1024) return
    res.write(`event: ${event}\ndata: ${data}\n\n`)
  }
}

function serveFile(res, file, type) {
  try {
    const body = fs.readFileSync(file)
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}

async function readBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 64 * 1024) break
  }
  try { return JSON.parse(body || '{}') } catch { return {} }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const pathname = url.pathname

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    serveFile(res, path.join(LAB, 'index.html'), 'text/html; charset=utf-8')
    return
  }
  if (req.method === 'GET' && pathname === '/client.js') {
    serveFile(res, path.join(ROOT, 'client.js'), 'text/javascript; charset=utf-8')
    return
  }
  if (req.method === 'GET' && pathname === '/vendor/react.js') {
    serveFile(res, path.join(LAB, 'vendor', 'react.js'), 'text/javascript; charset=utf-8')
    return
  }
  if (req.method === 'GET' && pathname === '/vendor/react-dom.js') {
    serveFile(res, path.join(LAB, 'vendor', 'react-dom.js'), 'text/javascript; charset=utf-8')
    return
  }
  if (req.method === 'GET' && pathname === '/plugin/browser-control/sessions') {
    json(res, 200, conversations())
    return
  }
  if (req.method === 'GET' && pathname === '/plugin/browser-control/overview') {
    json(res, 200, overview())
    return
  }
  if (req.method === 'GET' && pathname === '/plugin/browser-control/session/frame.jpg') {
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const buffer = frameFor(sessionId)
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' })
    res.end(buffer)
    return
  }
  if (req.method === 'GET' && pathname === '/plugin/browser-control/overview/frame.jpg') {
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const buffer = frameFor(sessionId)
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' })
    res.end(buffer)
    return
  }
  if (req.method === 'GET' && pathname === '/plugin/browser-control/overview/stream') {
    const send = sse(res)
    send('sessions', JSON.stringify(overview()))
    let flip = 0
    const timer = setInterval(() => {
      send('sessions', JSON.stringify(overview()))
      for (const entry of sessions) {
        const jpeg = entry.sessionId === 'lab-session-b' ? FRAME_B_B64 : FRAME_A_B64
        send('frame', JSON.stringify({ sessionId: entry.sessionId, jpeg: flip % 2 === 0 ? jpeg : (entry.sessionId === 'lab-session-b' ? FRAME_A_B64 : FRAME_B_B64) }))
      }
      flip += 1
    }, 1500)
    req.on('close', () => clearInterval(timer))
    res.on('close', () => clearInterval(timer))
    return
  }
  if (req.method === 'GET' && pathname === '/plugin/browser-control/state') {
    json(res, 200, state())
    return
  }
  if (req.method === 'GET' && pathname === '/plugin/browser-control/activity') {
    json(res, 200, {
      entries: [
        { id: 6, at: Date.now() - 300, source: 'agent', sessionId: 'lab-session-a', tool: 'browser_network', kind: 'network', detail: { action: 'list' }, status: 'ok', hasThumb: false },
        { id: 5, at: Date.now() - 600, source: 'agent', sessionId: 'lab-session-a', tool: 'browser_network', kind: 'network', detail: { action: 'detail' }, status: 'ok', hasThumb: false },
        { id: 4, at: Date.now() - 900, source: 'agent', sessionId: 'lab-session-a', tool: 'browser_network', kind: 'network', detail: { action: 'list' }, status: 'ok', hasThumb: false },
        { id: 3, at: Date.now() - 1_200, source: 'agent', sessionId: 'lab-session-a', tool: 'browser_network', kind: 'network', detail: { action: 'list' }, status: 'ok', hasThumb: false },
        { id: 2, at: Date.now() - 1_500, finishedAt: Date.now() - 1_200, source: 'agent', sessionId: 'lab-session-a', tool: 'browser_click', kind: 'click', detail: { target: 'Save' }, status: 'ok', hasThumb: false },
        { id: 1, at: Date.now() - 4_000, finishedAt: Date.now() - 3_900, source: 'agent', sessionId: 'lab-session-a', tool: 'browser_open', kind: 'open', detail: { url: 'https://example.test/app' }, status: 'ok', hasThumb: false },
      ],
      lastId: 6,
      current: null,
    })
    return
  }
  if (req.method === 'GET' && pathname === '/plugin/browser-control/frame.jpg') {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' })
    res.end(FRAME_A)
    return
  }
  if (req.method === 'GET' && pathname === '/plugin/browser-control/stream') {
    const send = sse(res)
    const timer = setInterval(() => send('frame', FRAME_A_B64), 1200)
    req.on('close', () => clearInterval(timer))
    res.on('close', () => clearInterval(timer))
    return
  }
  if (req.method === 'POST' && pathname === '/plugin/browser-control/action') {
    await readBody(req)
    json(res, 200, { ok: true, state: state() })
    return
  }
  if (req.method === 'POST' && pathname === '/plugin/browser-control/overview/action') {
    const body = await readBody(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (body.action === 'close') {
      const index = sessions.findIndex((entry) => entry.sessionId === sessionId)
      if (index >= 0) sessions.splice(index, 1)
      if (activeSessionId === sessionId) activeSessionId = sessions[0]?.sessionId ?? null
    } else if (body.action === 'focus' && sessions.some((entry) => entry.sessionId === sessionId)) {
      activeSessionId = sessionId
    } else if (body.action === 'open' && !sessions.some((entry) => entry.sessionId === sessionId)) {
      sessions.push({
        sessionId,
        title: sessionId === 'lab-session-new' ? '尚未打开浏览器的会话' : `Local session ${sessionId}`,
        url: 'about:blank',
        pageTitle: '',
        running: true,
        phase: 'running',
        active: true,
      })
      activeSessionId = sessionId
    } else if (body.action === 'open' && sessions.some((entry) => entry.sessionId === sessionId)) {
      activeSessionId = sessionId
    }
    json(res, 200, { ok: true, overview: overview() })
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

const port = Number(process.env.PORT ?? 0)
server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  console.log(`browser cockpit lab: http://127.0.0.1:${address.port}/`)
})
