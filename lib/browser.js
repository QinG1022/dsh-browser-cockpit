/**
 * One controllable Chrome page behind the browser tools and the sidebar panel.
 *
 * The browser is launched with a dedicated profile and a debugging port of the
 * OS's choosing; the DevTools socket is the only channel, so no extra npm
 * dependency is needed. Every action is a real user-level input event or
 * protocol command, which keeps React state, focus, and form validation in play.
 * @module dsh-browser-cockpit/lib/browser
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CdpConnection, CdpError } from './cdp.js'
import { deepQueryExpression, describeTarget, locatorExpression, parseTarget } from './locators.js'

const DEFAULT_WIDTH = 1440
const DEFAULT_HEIGHT = 900
const MAX_SHOT_FILES = 40
const AX_LINE_LIMIT = 700
const MAX_TOOL_DIMENSION = 1600
const WAIT_POLL_MS = 120
const NETWORK_IDLE_MS = 500

const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)))

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function cleanText(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

function truncate(value, max) {
  const text = String(value)
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function serializeRemote(remote) {
  if (remote === undefined || remote === null) return ''
  if (remote.type === 'string') return String(remote.value ?? '')
  if (remote.value !== undefined) return typeof remote.value === 'string' ? remote.value : JSON.stringify(remote.value)
  if (remote.unserializableValue !== undefined) return String(remote.unserializableValue)
  if (remote.description !== undefined) return String(remote.description)
  return String(remote.type ?? '')
}

/**
 * Find a Chrome-family executable to drive.
 * @param {string} [explicit] - configured executable.
 * @returns {string | undefined}
 */
export function resolveBrowserPath(explicit) {
  const candidates = []
  if (typeof explicit === 'string' && explicit.trim() !== '') candidates.push(explicit.trim())
  if (process.env.DSH_BROWSER_PATH !== undefined) candidates.push(process.env.DSH_BROWSER_PATH)
  const localAppData = process.env.LOCALAPPDATA
  const programFiles = process.env.ProgramFiles
  const programFilesX86 = process.env['ProgramFiles(x86)']
  if (process.platform === 'win32') {
    candidates.push(
      programFiles === undefined ? undefined : path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      programFilesX86 === undefined ? undefined : path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      localAppData === undefined ? undefined : path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      programFiles === undefined ? undefined : path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      programFilesX86 === undefined ? undefined : path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      programFiles === undefined ? undefined : path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    )
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge')
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Normalize a user-supplied address into an absolute URL.
 * @param {string} input - typed address.
 * @returns {string}
 */
export function normalizeUrl(input) {
  const raw = String(input ?? '').trim()
  if (raw === '') throw new CdpError('the URL is empty')
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw)) {
    try {
      return new URL(raw).toString()
    } catch (cause) {
      throw new CdpError(`"${raw}" is not a valid URL`, { cause })
    }
  }
  if (/^[\w.-]+(:\d+)?([/?#]|$)/u.test(raw)) {
    try {
      return new URL(`http://${raw}`).toString()
    } catch (cause) {
      throw new CdpError(`"${raw}" is not a valid URL`, { cause })
    }
  }
  throw new CdpError(`"${raw}" is not a URL; pass an absolute address such as http://localhost:3000/`)
}

function ensureDirectory(directory) {
  mkdirSync(directory, { recursive: true })
  return directory
}

// Performance entry types such as largest-contentful-paint and longtask are
// not exposed by getEntriesByType(). Install observers as early as possible;
// the same source is used for current pages and future navigations.
const PERF_OBSERVER_SOURCE = String.raw`(() => {
  if (window.__dshPerfState) return;
  const state = {
    supported: typeof PerformanceObserver === 'function',
    lcp: null,
    cls: null,
    inp: null,
    longTaskCount: 0,
    longTaskMs: 0,
    lcpSupported: false,
    clsSupported: false,
    eventSupported: false,
    longTaskSupported: false,
    startedAt: performance.now(),
  };
  window.__dshPerfState = state;
  if (!state.supported) return;
  const observe = (type, callback, flag) => {
    try {
      const observer = new PerformanceObserver((list) => callback(list.getEntries()));
      observer.observe({ type, buffered: true });
      state[flag] = true;
    } catch {
      state[flag] = false;
    }
  };
  observe('largest-contentful-paint', (entries) => {
    const entry = entries[entries.length - 1];
    if (entry !== undefined) state.lcp = entry.startTime;
  }, 'lcpSupported');
  observe('layout-shift', (entries) => {
    for (const entry of entries) {
      if (!entry.hadRecentInput) state.cls = (state.cls || 0) + (entry.value || 0);
    }
  }, 'clsSupported');
  observe('longtask', (entries) => {
    for (const entry of entries) {
      state.longTaskCount += 1;
      state.longTaskMs += entry.duration || 0;
    }
  }, 'longTaskSupported');
  observe('event', (entries) => {
    for (const entry of entries) {
      if (typeof entry.duration === 'number') state.inp = Math.max(state.inp || 0, entry.duration);
    }
  }, 'eventSupported');
})()`

/** One page under agent and human control. */
export class BrowserSession {
  #options
  #state
  #child
  #conn
  #sessionId
  #targetId
  #activePortFile
  #refs = new Map()
  #console = []
  #consoleKeys = new Map()
  #initializedPages = new Map()
  #enabledPages = new Set()
  #requests = new Map()
  #network = new Map()
  #networkActivityAt = 0
  #dialog = null
  #dialogWaiters = new Set()
  #switchChain = Promise.resolve()
  #discoveryConnection
  #crashed = false
  #seq = 0
  #launchPromise
  #closing = false
  #disposed = false
  #routes = new Map()
  #routeSeq = 0
  #fetchEnabled = false
  #downloads = new Map()
  #downloadSeq = 0
  #downloadPath
  #idleTimer
  #idleTimeoutMs
  #secrets = []
  #allowedHosts = []
  #allowFileUrls = false
  #storageStateDir
  #screencastFrame = null
  #screencastAt = 0
  #screencastRefs = 0
  #screencastActive = false
  #screencastListeners = new Set()
  #screencastMetadata = {}
  #screencastAckTimers = new Map()
  #screencastQuality = 58
  #perfInjectedSessions = new Set()
  #sessionTabs = new Map()
  #sessionCache = new Map()
  #activeSessionId = null
  #actionChain = Promise.resolve()
  #contexts = new Map()
  #sessionTitleResolver = null
  #selfOrigins = new Set()

  /**
   * @param {{ browserPath?: string, headless?: boolean, width?: number, height?: number, profileDir?: string, timeoutMs?: number, dialogBehavior?: 'dismiss' | 'accept' | 'manual', followNewTabs?: boolean, idleTimeoutMs?: number, downloadDir?: string, storageStateDir?: string, secrets?: object | Array<object>, allowedHosts?: string | string[], allowFileUrls?: boolean }} [options]
   */
  constructor(options = {}) {
    this.#options = {
      browserPath: options.browserPath,
      headless: options.headless !== false,
      width: clamp(options.width ?? DEFAULT_WIDTH, 320, 3840),
      height: clamp(options.height ?? DEFAULT_HEIGHT, 240, 2160),
      profileDir: options.profileDir,
      timeoutMs: options.timeoutMs ?? 20000,
      dialogBehavior: options.dialogBehavior === 'accept' || options.dialogBehavior === 'manual' ? options.dialogBehavior : 'dismiss',
      followNewTabs: options.followNewTabs !== false,
      idleTimeoutMs: options.idleTimeoutMs === undefined ? 300000 : clamp(options.idleTimeoutMs, 0, 86400000),
      downloadDir: typeof options.downloadDir === 'string' ? options.downloadDir : undefined,
    }
    this.#idleTimeoutMs = this.#options.idleTimeoutMs
    this.#secrets = parseSecrets(options.secrets)
    this.#allowedHosts = parseAllowedHosts(options.allowedHosts)
    this.#allowFileUrls = options.allowFileUrls === true
    this.#storageStateDir = typeof options.storageStateDir === 'string' && options.storageStateDir !== ''
      ? path.resolve(options.storageStateDir)
      : path.join(os.homedir(), '.dsh', 'browser-control', 'state')
    this.#state = {
      phase: 'stopped',
      url: '',
      title: '',
      width: this.#options.width,
      height: this.#options.height,
      error: null,
      startedAt: null,
    }
  }

  /** @returns {object} the panel-facing state. */
  getState() {
    return {
      running: this.#state.phase === 'running' && this.#conn !== undefined && !this.#conn.closed,
      phase: this.#state.phase,
      url: this.#state.url,
      title: this.#state.title,
      width: this.#state.width,
      height: this.#state.height,
      viewport: { width: this.#state.width, height: this.#state.height },
      error: this.#state.error,
      headless: this.#options.headless,
      startedAt: this.#state.startedAt,
      dialog: this.#dialog === null ? null : { ...this.#dialog },
      targetId: this.#targetId ?? null,
      crashed: this.#crashed,
      consoleCount: this.#console.length,
      errorCount: this.#console.filter((entry) => entry.level === 'error').length,
      recentErrors: this.#console.filter((entry) => entry.level === 'error').slice(-3).map((entry) => entry.text),
      idleTimeoutMs: this.#idleTimeoutMs,
      routes: this.#routes.size,
      downloads: this.#downloads.size,
      screencast: this.#screencastActive,
      activeSessionId: this.#activeSessionId,
      sessionCount: this.#contexts.size,
      sessions: this.#publicSessions(),
    }
  }

  /**
   * Give the overview human-readable conversation titles without taking a hard
   * dependency on the sessions/title services; the Host wires this callback.
   * @param {((sessionId: string) => string | null) | null} resolver - title lookup.
   */
  setSessionTitleResolver(resolver) {
    this.#sessionTitleResolver = typeof resolver === 'function' ? resolver : null
  }

  /**
   * Mark origins whose live preview must not be captured. The Harness UI is
   * one such page: its overview contains the live preview itself, so capturing
   * it creates a recursive screenshot loop that can exhaust the Host heap.
   * @param {string | string[]} origins - absolute origins or URLs.
   */
  setSelfOrigins(origins) {
    const list = Array.isArray(origins) ? origins : [origins]
    this.#selfOrigins = new Set(list.flatMap((value) => {
      if (typeof value !== 'string' || value.trim() === '') return []
      try { return [new URL(value).origin] } catch { return [] }
    }))
  }

  /** @returns {Array<object>} safe per-session records for the overview grid. */
  #publicSessions() {
    // Never advertise the Harness UI itself: the overview would otherwise
    // screenshot the page that renders the overview (a recursive capture).
    return [...this.#contexts.values()]
      .filter((record) => !this.#isSelfPage(record.url))
      .map((record) => this.#publicSession(record))
  }

  #publicSession(record) {
    let title = null
    if (this.#sessionTitleResolver !== null) {
      try { title = this.#sessionTitleResolver(record.sessionId) } catch { title = null }
    }
    const consoleEntries = Array.isArray(record.console) ? record.console : []
    const recentErrors = consoleEntries.filter((entry) => entry.level === 'error').slice(-3)
    return {
      sessionId: record.sessionId,
      title: typeof title === 'string' && title.trim() !== '' ? title.trim() : `Session ${record.sessionId.slice(-6)}`,
      url: record.url,
      pageTitle: record.title,
      running: this.#state.phase === 'running' && record.phase === 'running',
      phase: record.phase,
      active: record.sessionId === this.#activeSessionId,
      createdAt: record.createdAt,
      lastActivityAt: record.lastActivityAt,
      hasFrame: record.frame !== null,
      frameAt: record.frameAt,
      width: record.width,
      height: record.height,
      error: record.error,
      errorCount: recentErrors.length === 0 ? 0 : consoleEntries.filter((entry) => entry.level === 'error').length,
      recentErrors: recentErrors.map((entry) => ({ text: entry.text, at: entry.at, url: entry.url ?? '' })),
    }
  }

  /** @returns {{ activeSessionId: string | null, sessions: Array<object>, updatedAt: number }} overview data. */
  getOverview() {
    return {
      activeSessionId: this.#activeSessionId,
      sessions: this.#publicSessions(),
      updatedAt: Date.now(),
    }
  }

  /**
   * State for one conversation. Each session now owns an isolated browser
   * context, so an inactive session still sees its own page instead of another
   * conversation's page.
   * @param {string | null} [sessionId] - agent session id; null = global panel.
   * @returns {object} panel-facing state.
   */
  getStateForSession(sessionId) {
    const base = this.getState()
    if (typeof sessionId !== 'string' || sessionId === '') return { ...base, sessionActive: true }
    const record = this.#contexts.get(sessionId)
    if (record === undefined) {
      return {
        ...base,
        running: false,
        phase: 'stopped',
        url: '',
        title: '',
        targetId: null,
        sessionActive: false,
        screencast: false,
        sessions: this.#publicSessions(),
      }
    }
    const sessionActive = record.sessionId === this.#activeSessionId
    const consoleEntries = Array.isArray(record.console) ? record.console : []
    return {
      ...base,
      running: base.running && record.phase === 'running' && sessionActive,
      phase: record.phase,
      url: record.url,
      title: record.title,
      targetId: record.targetId,
      sessionActive,
      error: record.error,
      consoleCount: consoleEntries.length,
      errorCount: consoleEntries.filter((entry) => entry.level === 'error').length,
      recentErrors: consoleEntries.filter((entry) => entry.level === 'error').slice(-3).map((entry) => entry.text),
      screencast: record.screencast.active,
      sessions: this.#publicSessions(),
    }
  }

  /** @param {string} sessionId - remember the current page for an inactive session. */
  #rememberSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    this.#sessionCache.set(sessionId, {
      url: this.#state.url,
      title: this.#state.title,
      targetId: this.#targetId ?? null,
      at: Date.now(),
    })
  }

  /** Keep the active context record in sync with the legacy active-page state. */
  #syncActiveRecord() {
    const record = this.#contextRecord(this.#activeSessionId)
    if (record === null) return
    record.url = this.#state.url || record.url
    record.title = this.#state.title || record.title
    record.phase = this.#state.phase === 'stopped' ? 'stopped' : record.phase
    record.lastActivityAt = Date.now()
  }

  /** @param {string} targetId - owner session of a page target. */
  #ownerOf(targetId) {
    if (typeof targetId !== 'string') return null
    for (const [sessionId, tab] of this.#sessionTabs) {
      if (tab === targetId) return sessionId
    }
    return null
  }

  /**
   * Serialize multi-session tool calls. The browser has one active CDP page, so
   * two conversations must not interleave a switch with another action.
   * @param {() => Promise<any>} task - action to run exclusively.
   * @returns {Promise<any>}
   */
  runExclusive(task) {
    const run = this.#actionChain.then(task, task)
    this.#actionChain = run.then(() => {}, () => {})
    return run
  }

  /**
   * Make the isolated browser context owned by a session current, creating one
   * on first use. Contexts keep cookies, storage, and cache separate.
   * @param {string | null} sessionId - agent session id.
   * @returns {Promise<object>} state after switching.
   */
  async enterSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      await this.ensureStarted()
      return this.getState()
    }
    await this.ensureStarted()
    let record = this.#contexts.get(sessionId)
    if (record !== undefined) {
      const pages = await this.#pageTargets()
      const alive = pages.some((page) => page.targetId === record.targetId)
      if (!alive) {
        await this.#disposeContext(record).catch(() => {})
        this.#contexts.delete(sessionId)
        this.#sessionTabs.delete(sessionId)
        this.#sessionCache.delete(sessionId)
        record = undefined
      }
    }
    if (record === undefined) {
      record = await this.#createSessionContext(sessionId)
    } else if (this.#activeSessionId !== sessionId) {
      this.#activateRecord(record)
      await this.#refreshIdentity()
      record.url = this.#state.url
      record.title = this.#state.title
      record.lastActivityAt = Date.now()
    } else {
      this.#touch()
    }
    this.#sessionTabs.set(sessionId, record.targetId)
    this.#rememberSession(sessionId)
    return this.getState()
  }

  /**
   * Create one isolated browser context and its first page for a conversation.
   * @param {string} sessionId - agent session id.
   * @returns {Promise<object>} the context record.
   */
  async #createSessionContext(sessionId) {
    const connection = this.#conn
    if (connection === undefined || connection.closed) throw new CdpError('the browser is not connected')
    if (this.#contexts.size >= 6) throw new CdpError('at most six conversations can keep a browser open')
    let contextId
    let targetId
    let cdpSessionId
    try {
      const created = await connection.send('Target.createBrowserContext')
      contextId = created.browserContextId
      const target = await connection.send('Target.createTarget', {
        url: 'about:blank',
        browserContextId: contextId,
      })
      targetId = target.targetId
      const attached = await connection.send('Target.attachToTarget', { targetId, flatten: true })
      cdpSessionId = attached.sessionId
      const record = {
        sessionId,
        contextId,
        targetId,
        cdpSessionId,
        phase: 'running',
        url: 'about:blank',
        title: '',
        width: this.#options.width,
        height: this.#options.height,
        error: null,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        frame: null,
        frameAt: 0,
        capturing: false,
        console: [],
        screencast: { active: false, refs: 0, listeners: new Set() },
      }
      this.#contexts.set(sessionId, record)
      this.#sessionTabs.set(sessionId, targetId)
      this.#activateRecord(record)
      await this.#configureDownloads(connection, contextId)
      await this.#initializePage(connection, cdpSessionId)
      this.#state.phase = 'running'
      this.#state.error = null
      await this.#refreshIdentity()
      record.url = this.#state.url
      record.title = this.#state.title
      this.#touch()
      return record
    } catch (error) {
      if (cdpSessionId !== undefined) {
        connection.send('Target.detachFromTarget', { sessionId: cdpSessionId }).catch(() => {})
      }
      if (targetId !== undefined) connection.send('Target.closeTarget', { targetId }).catch(() => {})
      if (contextId !== undefined) connection.send('Target.disposeBrowserContext', { browserContextId: contextId }).catch(() => {})
      if (error instanceof CdpError) throw error
      throw new CdpError(`cannot create an isolated browser context: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  /** @param {object} record - make this record's page the active CDP page. */
  #activateRecord(record) {
    const previousSessionId = this.#sessionId
    const switched = this.#activeSessionId !== record.sessionId
    this.#targetId = record.targetId
    this.#sessionId = record.cdpSessionId
    this.#activeSessionId = record.sessionId
    this.#state.phase = record.phase === 'stopped' ? 'running' : record.phase
    this.#state.error = record.error
    this.#state.url = record.url
    this.#state.title = record.title
    this.#state.width = record.width
    this.#state.height = record.height
    if (switched) {
      this.#refs.clear()
      // Console history belongs to the conversation, not to the active page.
      // Rebind the shared view instead of clearing it on every switch.
      if (!Array.isArray(record.console)) record.console = []
      this.#console = record.console
      this.#requests.clear()
      this.#network.clear()
      this.#networkActivityAt = 0
      this.#fetchEnabled = false
      this.#dialog = null
      void this.#rebindScreencast(previousSessionId)
    }
    this.#touch()
  }

  /** @param {object} record - dispose one context and its page. */
  async #disposeContext(record) {
    const connection = this.#conn
    if (connection === undefined || connection.closed) return
    await this.#stopRecordScreencast(record).catch(() => {})
    if (record.cdpSessionId !== undefined) {
      this.#forgetPage(record.cdpSessionId)
      connection.send('Target.detachFromTarget', { sessionId: record.cdpSessionId }).catch(() => {})
    }
    connection.send('Target.closeTarget', { targetId: record.targetId }).catch(() => {})
    connection.send('Target.disposeBrowserContext', { browserContextId: record.contextId }).catch(() => {})
  }

  /**
   * Close one conversation's browser context from the overview.
   * @param {string} sessionId - agent session id.
   * @returns {Promise<object>} overview after closing.
   */
  async closeSession(sessionId) {
    const record = this.#contexts.get(sessionId)
    if (record === undefined) return this.getOverview()
    this.#contexts.delete(sessionId)
    this.#sessionTabs.delete(sessionId)
    this.#sessionCache.delete(sessionId)
    await this.#disposeContext(record).catch(() => {})
    if (this.#activeSessionId === sessionId) {
      const next = this.#contexts.values().next().value
      if (next !== undefined) {
        this.#activateRecord(next)
        await this.#refreshIdentity().catch(() => {})
      } else {
        this.#activeSessionId = null
        this.#targetId = undefined
        this.#sessionId = undefined
        this.#console = []
        this.#screencastActive = false
        this.#state.url = ''
        this.#state.title = ''
        this.#state.phase = this.#conn === undefined || this.#conn.closed ? 'stopped' : 'running'
      }
    }
    return this.getOverview()
  }

  /** @param {string} sessionId - focus one session from the overview. */
  async focusSession(sessionId) {
    const record = this.#contexts.get(sessionId)
    if (record === undefined) {
      await this.enterSession(sessionId)
    } else {
      this.#activateRecord(record)
      await this.#refreshIdentity().catch(() => {})
    }
    return this.getOverview()
  }

  /** @param {string} sessionId - newest cached live frame for one session. */
  getSessionFrame(sessionId) {
    const record = this.#contexts.get(sessionId)
    if (record?.frame == null) return null
    return { buffer: record.frame, at: record.frameAt }
  }

  /**
   * Capture one session page without making it the active conversation page.
   * @param {string} sessionId - agent session id.
   * @param {{ quality?: number }} [options] - JPEG quality.
   * @returns {Promise<Buffer>} a JPEG frame.
   */
  async captureSessionFrame(sessionId, options = {}) {
    await this.ensureStarted()
    const record = this.#contexts.get(sessionId)
    if (record === undefined) throw new CdpError('this conversation has no open browser')
    if (this.#isSelfPage(record.url)) throw new CdpError('live preview of the Harness UI is disabled to avoid recursive capture')
    // Overview cards are a few hundred pixels wide. Capturing the full 1440x900
    // viewport for every card is both slow and expensive; a clipped, scaled
    // screenshot keeps the per-frame payload small enough for a live grid.
    const width = Number.isFinite(record.width) && record.width > 0 ? record.width : 1440
    const height = Number.isFinite(record.height) && record.height > 0 ? record.height : 900
    const maxWidth = clamp(options.maxWidth ?? 480, 80, 1600)
    const scale = Math.min(1, maxWidth / width)
    const { data } = await this.#conn.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: clamp(options.quality ?? 45, 1, 100),
      clip: { x: 0, y: 0, width, height, scale },
      captureBeyondViewport: false,
    }, record.cdpSessionId)
    return Buffer.from(data, 'base64')
  }

  #isSelfPage(url) {
    if (this.#selfOrigins.size === 0 || typeof url !== 'string' || url === '') return false
    try { return this.#selfOrigins.has(new URL(url).origin) } catch { return false }
  }

  #contextRecord(sessionId) {
    return typeof sessionId === 'string' ? this.#contexts.get(sessionId) ?? null : null
  }

  #recordForCdpSession(cdpSessionId) {
    if (typeof cdpSessionId !== 'string') return null
    for (const record of this.#contexts.values()) {
      if (record.cdpSessionId === cdpSessionId) return record
    }
    return null
  }

  async #beginRecordScreencast(record) {
    const connection = this.#conn
    if (connection === undefined || connection.closed || record.screencast.active) return
    await connection.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 45,
      maxWidth: 640,
      maxHeight: 400,
      everyNthFrame: 15,
    }, record.cdpSessionId)
    record.screencast.active = true
  }

  async #stopRecordScreencast(record) {
    if (!record.screencast.active) return
    record.screencast.active = false
    const connection = this.#conn
    if (connection === undefined || connection.closed) return
    await connection.send('Page.stopScreencast', {}, record.cdpSessionId).catch(() => {})
  }

  /**
   * Subscribe to one session's live frames; the first subscriber starts that
   * page's screencast and the last one stops it.
   * @param {string} sessionId - agent session id.
   * @param {(frame: Buffer, metadata: object) => void} listener - frame callback.
   * @param {{ quality?: number, maxWidth?: number, maxHeight?: number }} [options]
   * @returns {Promise<() => Promise<void>>} unsubscribe.
   */
  async subscribeSessionScreencast(sessionId, listener, options = {}) {
    await this.ensureStarted()
    const record = this.#contexts.get(sessionId)
    if (record === undefined) throw new CdpError('this conversation has no open browser')
    record.screencast.listeners.add(listener)
    record.screencast.refs += 1
    if (!record.screencast.active) await this.#beginRecordScreencast(record)
    let closed = false
    return async () => {
      if (closed) return
      closed = true
      record.screencast.listeners.delete(listener)
      record.screencast.refs = Math.max(0, record.screencast.refs - 1)
      if (record.screencast.refs === 0) await this.#stopRecordScreencast(record)
    }
  }

  /** @param {string | null} sessionId - claim the current tab for a session. */
  claimCurrentTab(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '' || typeof this.#targetId !== 'string') return
    const record = this.#contexts.get(sessionId)
    if (record === undefined || record.targetId !== this.#targetId) return
    record.lastActivityAt = Date.now()
    record.url = this.#state.url
    record.title = this.#state.title
    this.#rememberSession(sessionId)
  }

  /** @returns {Promise<Array<{ targetId: string, url: string, title: string }>>} page targets. */
  async #pageTargets() {
    const { targetInfos = [] } = await this.#conn.send('Target.getTargets')
    return targetInfos.filter((target) => target.type === 'page').map((target) => ({
      targetId: target.targetId,
      url: typeof target.url === 'string' ? target.url : '',
      title: typeof target.title === 'string' ? target.title : '',
    }))
  }

  /** @returns {{ width: number, height: number }} the emulated viewport. */
  get viewport() {
    return { width: this.#state.width, height: this.#state.height }
  }

  #assertNavigationAllowed(url) {
    let parsed
    try {
      parsed = new URL(url)
    } catch (cause) {
      throw new CdpError(`"${url}" is not a valid URL`, { cause })
    }
    if (parsed.protocol === 'file:') {
      if (this.#allowFileUrls) return
      throw new CdpError(`opening ${url} is blocked: file:// pages are disabled; set allowFileUrls: true to permit them`)
    }
    if (parsed.protocol === 'about:') {
      if (parsed.href === 'about:blank') return
      throw new CdpError(`opening ${url} is blocked: only about:blank is allowed`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new CdpError(`opening ${url} is blocked: only http://, https://, about:blank, and explicitly allowed file:// pages are supported`)
    }
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
    const loopback = host === 'localhost'
      || host.endsWith('.localhost')
      || host === '::1'
      || host === '127.0.0.1'
      || host.startsWith('127.')
    if (loopback) return
    const allowed = this.#allowedHosts.some((entry) => {
      if (entry === '*') return true
      if (entry.startsWith('*.')) {
        const suffix = entry.slice(1)
        return host === entry.slice(2) || host.endsWith(suffix)
      }
      if (entry.startsWith('.')) return host === entry.slice(1) || host.endsWith(entry)
      return host === entry
    })
    if (allowed) return
    throw new CdpError(`opening ${url} is blocked: ${host} is not in allowedHosts; `
      + 'localhost, 127.0.0.1, and ::1 are always allowed, and set allowFileUrls: true for local files')
  }

  /** Re-read the page URL and title into the panel state. */
  async refreshIdentity() {
    await this.#refreshIdentity()
  }

  /** Launch the browser if needed and resolve once it can navigate. */
  async ensureStarted() {
    if (this.#disposed) throw new CdpError('the browser plugin is shutting down')
    if (this.#crashed) {
      this.#crashed = false
      if (this.#launchPromise !== undefined) return this.#launchPromise
      this.#launchPromise = this.#recoverPage().finally(() => { this.#launchPromise = undefined })
      return this.#launchPromise
    }
    if (this.#state.phase === 'running' && this.#conn !== undefined && !this.#conn.closed) {
      this.#touch()
      return
    }
    if (this.#launchPromise !== undefined) return this.#launchPromise
    // A page can outlive its debugging socket: in that case reattach instead of
    // spawning another Chrome against the still-locked profile.
    if (this.#state.phase === 'running' && this.#conn?.closed === true) {
      this.#launchPromise = this.#reconnectPage().finally(() => { this.#launchPromise = undefined })
      const reconnected = await this.#launchPromise
      if (reconnected) return
    }
    if (this.#launchPromise !== undefined) return this.#launchPromise
    this.#launchPromise = this.#launch().finally(() => { this.#launchPromise = undefined })
    return this.#launchPromise
  }

  /**
   * Navigate the page and wait for the load event (or network idle).
   * @param {string} url - address to open.
   * @param {{ waitUntil?: 'load' | 'networkIdle' | 'none', timeoutMs?: number }} [options] - navigation wait and timeout.
   * @returns {Promise<object>} the new state.
   */
  async open(url, { waitUntil = 'load', timeoutMs } = {}) {
    const target = normalizeUrl(url)
    this.#assertNavigationAllowed(target)
    const wait = parseWaitUntil(waitUntil)
    const timeout = clampNavTimeout(timeoutMs)
    await this.ensureStarted()
    this.#assertNoDialog()
    this.#crashed = false
    this.#console = []
    this.#network.clear()
    this.#refs.clear()
    const sessionId = this.#sessionId
    const startedAt = Date.now()
    let loaded = false
    const off = this.#conn.on('Page.loadEventFired', (_params, sid) => {
      if (sid === sessionId) loaded = true
    })
    try {
      const result = await this.#conn.send('Page.navigate', { url: target }, sessionId)
      if (result.errorText !== undefined && result.errorText !== '') {
        throw new CdpError(`cannot open ${target}: ${result.errorText}`)
      }
      if (wait === 'load' || wait === 'networkIdle') {
        const deadline = startedAt + timeout
        while (!loaded && Date.now() < deadline) await delay(80)
        if (!loaded) {
          throw new CdpError(`timed out after ${Date.now() - startedAt}ms waiting for ${target} to load; `
            + 'use waitUntil "none" to navigate without waiting or raise timeoutMs')
        }
        await delay(300)
      } else {
        await delay(150)
      }
    } finally {
      off()
    }
    this.#state.url = target
    await this.#refreshIdentity()
    if (this.#activeSessionId !== null) this.#rememberSession(this.#activeSessionId)
    this.#syncActiveRecord()
    if (wait === 'networkIdle') {
      await this.waitFor({ networkIdle: true, timeoutMs: Math.max(100, timeout - (Date.now() - startedAt)) })
    }
    return this.getState()
  }

  /** Reload the current page, bypassing the cache. */
  async reload() {
    await this.ensureStarted()
    this.#assertNoDialog()
    this.#console = []
    this.#network.clear()
    this.#refs.clear()
    const sessionId = this.#sessionId
    let loaded = false
    const off = this.#conn.on('Page.loadEventFired', (_params, sid) => {
      if (sid === sessionId) loaded = true
    })
    try {
      await this.#conn.send('Page.reload', { ignoreCache: true }, sessionId)
      const deadline = Date.now() + 15000
      while (!loaded && Date.now() < deadline) await delay(80)
      await delay(300)
    } finally {
      off()
    }
    await this.#refreshIdentity()
    if (this.#activeSessionId !== null) this.#rememberSession(this.#activeSessionId)
    this.#syncActiveRecord()
    return this.getState()
  }

  /**
   * Start one shared CDP screencast for the panel and every sidebar tab.
   * Frames are acknowledged immediately and the newest frame is cached; callers
   * can read it with `screencastFrame` instead of capturing a screenshot.
   * @param {{ quality?: number, maxWidth?: number, maxHeight?: number, everyNthFrame?: number }} [options]
   * @returns {Promise<void>}
   */
  async startScreencast(options = {}) {
    this.#screencastRefs += 1
    if (this.#screencastRefs > 1) return
    await this.ensureStarted()
    await this.#beginScreencast(options).catch((error) => {
      this.#screencastRefs = Math.max(0, this.#screencastRefs - 1)
      throw error
    })
  }

  /** @returns {Promise<void>} stop the screencast and release its CDP stream. */
  async stopScreencast() {
    this.#screencastRefs = Math.max(0, this.#screencastRefs - 1)
    if (this.#screencastRefs > 0) return
    const connection = this.#conn
    const sessionId = this.#sessionId
    this.#screencastActive = false
    if (connection === undefined || connection.closed || sessionId === undefined) return
    await connection.send('Page.stopScreencast', {}, sessionId).catch(() => {})
  }

  /**
   * Subscribe to the latest JPEG frame; the first subscriber starts the stream.
   * @param {(frame: Buffer, metadata: object) => void} listener - receives each frame.
   * @param {{ quality?: number, maxWidth?: number, maxHeight?: number }} [options]
   * @returns {Promise<() => Promise<void>>} unsubscribe.
   */
  async subscribeScreencast(listener, options = {}) {
    this.#screencastListeners.add(listener)
    try {
      await this.startScreencast(options)
    } catch (error) {
      this.#screencastListeners.delete(listener)
      throw error
    }
    let closed = false
    return async () => {
      if (closed) return
      closed = true
      this.#screencastListeners.delete(listener)
      await this.stopScreencast()
    }
  }

  /**
   * Move the shared live stream to the new active page. Without this, a panel
   * that switches conversations keeps acknowledging frames from the old page
   * while the big preview appears frozen.
   * @param {string | undefined} previousSessionId - CDP session that was active.
   */
  async #rebindScreencast(previousSessionId) {
    if (this.#screencastRefs === 0) return
    const connection = this.#conn
    if (connection === undefined || connection.closed) return
    if (typeof previousSessionId === 'string' && previousSessionId !== this.#sessionId) {
      await connection.send('Page.stopScreencast', {}, previousSessionId).catch(() => {})
    }
    this.#screencastActive = false
    this.#screencastFrame = null
    this.#screencastAt = 0
    await this.#beginScreencast({ quality: this.#screencastQuality }).catch(() => {})
  }

  /** @returns {{ buffer: Buffer, at: number, metadata: object } | null} newest frame. */
  get screencastFrame() {
    if (this.#screencastFrame === null) return null
    return { buffer: this.#screencastFrame, at: this.#screencastAt, metadata: this.#screencastMetadata ?? {} }
  }

  async #beginScreencast(options = {}) {
    const connection = this.#conn
    const sessionId = this.#sessionId
    if (connection === undefined || connection.closed || sessionId === undefined) {
      throw new CdpError('cannot start a screencast without a page')
    }
    const width = Math.round(clamp(options.maxWidth ?? this.#state.width, 1, 3840))
    const height = Math.round(clamp(options.maxHeight ?? this.#state.height, 1, 2160))
    await connection.send('Page.startScreencast', {
      format: 'jpeg',
      quality: clamp(options.quality ?? 60, 1, 100),
      maxWidth: width,
      maxHeight: height,
      everyNthFrame: clamp(options.everyNthFrame ?? 1, 1, 60),
    }, sessionId)
    this.#screencastActive = true
  }

  /**
   * Capture the viewport or the whole page.
   * @param {{ format?: 'png' | 'jpeg', quality?: number, fullPage?: boolean, maxDimension?: number }} [options]
   * @returns {Promise<Buffer>}
   */
  async capture(options = {}) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const sessionId = this.#sessionId
    const format = options.format === 'jpeg' ? 'jpeg' : 'png'
    const maxDimension = options.maxDimension ?? MAX_TOOL_DIMENSION
    const metrics = await this.#conn.send('Page.getLayoutMetrics', {}, sessionId)
    const content = metrics.cssContentSize ?? metrics.contentSize
    const viewport = metrics.cssVisualViewport ?? metrics.visualViewport
    const viewportWidth = viewport?.clientWidth ?? this.#state.width
    const viewportHeight = viewport?.clientHeight ?? this.#state.height
    const width = options.fullPage === true && content !== undefined ? content.width : viewportWidth
    const height = options.fullPage === true && content !== undefined ? content.height : viewportHeight
    const scale = Math.min(1, maxDimension / Math.max(width, height))
    const params = { format }
    if (format === 'jpeg') params.quality = clamp(options.quality ?? 62, 1, 100)
    if (options.fullPage === true) {
      params.captureBeyondViewport = true
      params.clip = { x: 0, y: 0, width, height, scale }
    } else if (scale < 1) {
      const { result } = await this.#conn.send('Runtime.evaluate', {
        expression: '({ x: window.scrollX, y: window.scrollY })',
        returnByValue: true,
      }, sessionId)
      const scroll = result?.value ?? { x: 0, y: 0 }
      params.clip = { x: scroll.x, y: scroll.y, width: viewportWidth, height: viewportHeight, scale }
    }
    const { data } = await this.#conn.send('Page.captureScreenshot', params, sessionId)
    return Buffer.from(data, 'base64')
  }

  /**
   * Read the page as an accessibility outline with interaction refs and control state.
   * @param {{ interactiveOnly?: boolean, boxes?: boolean, depth?: number, maxNodes?: number }} [options] - compactness and optional coordinates.
   * @returns {Promise<{ url: string, title: string, viewport: { width: number, height: number }, outline: string, text: string, refs: number, truncated: boolean }>}
   */
  /**
   * List same-origin child frames so snapshots can include their controls.
   * Cross-origin and out-of-process frames stay out of the snapshot.
   * @returns {Promise<Array<{ id: string, url: string, name: string }>>}
   */
  async #sameOriginFrames() {
    try {
      const { frameTree } = await this.#conn.send('Page.getFrameTree', {}, this.#sessionId)
      const output = []
      const mainOrigin = (() => {
        try { return new URL(this.#state.url).origin } catch { return '' }
      })()
      const visit = (entry) => {
        for (const child of entry.childFrames ?? []) {
          const frame = child.frame
          let origin = ''
          try { origin = new URL(frame.url).origin } catch { origin = '' }
          const sameOrigin = frame.url === 'about:srcdoc' || (origin !== '' && origin === mainOrigin)
          if (sameOrigin) output.push({ id: frame.id, url: frame.url, name: frame.name ?? '' })
          visit(child)
        }
      }
      visit(frameTree)
      return output
    } catch {
      return []
    }
  }

  async snapshot({ interactiveOnly = false, boxes = false, depth, maxNodes } = {}) {
    await this.ensureStarted()
    this.#assertNoDialog()
    await this.#refreshIdentity()
    const maxDepth = clamp(depth ?? 50, 1, 50)
    const nodeLimit = clamp(maxNodes ?? AX_LINE_LIMIT, 20, 2000)
    const sessionId = this.#sessionId
    await this.#conn.send('Accessibility.enable', {}, sessionId)
    const { nodes = [] } = await this.#conn.send('Accessibility.getFullAXTree', {}, sessionId)
    this.#refs.clear()
    const byId = new Map(nodes.map((node) => [node.nodeId, node]))
    const roots = nodes.filter((node) => node.parentId === undefined || !byId.has(node.parentId))
    const lines = []
    const lineRefs = []
    const refEntries = []
    let truncated = false
    const interactiveRoles = new Set([
      'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio',
      'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'gridcell',
      'DisclosureTriangle',
    ])
    const skippedRoles = new Set(['none', 'generic', 'presentation', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'WebArea'])
    const walk = (node, depth, parentName, level = 0, lookup = byId) => {
      if (level > maxDepth) return
      if (lines.length >= nodeLimit) {
        truncated = true
        return
      }
      if (node === undefined) return
      const role = node.role?.value ?? ''
      const name = cleanText(node.name?.value)
      const ignored = node.ignored === true
      let nextDepth = depth
      if (!ignored) {
        let line = ''
        let ref = ''
        if (interactiveRoles.has(role) && node.backendDOMNodeId !== undefined) {
          ref = `e${this.#refs.size + 1}`
          this.#refs.set(ref, node.backendDOMNodeId)
          refEntries.push({ ref, backendNodeId: node.backendDOMNodeId })
          line = `${interactiveOnly ? '' : '  '.repeat(depth)}- ${role}${name === '' ? '' : ` "${truncate(name, 110)}"`} [ref=${ref}]${axStateSuffix(node, role, byId)}`
          nextDepth = depth + 1
        } else if (!interactiveOnly && role === 'heading' && name !== '') {
          line = `${'  '.repeat(depth)}- heading "${truncate(name, 110)}"`
          nextDepth = depth + 1
        } else if (!interactiveOnly && role === 'StaticText' && name !== '' && name !== parentName) {
          line = `${'  '.repeat(depth)}- ${truncate(name, 110)}`
        } else if (!interactiveOnly && !skippedRoles.has(role) && name !== '') {
          line = `${'  '.repeat(depth)}- ${role} "${truncate(name, 110)}"`
          nextDepth = depth + 1
        }
        if (line !== '') {
          lines.push(line)
          lineRefs.push(ref)
        }
      }
      for (const childId of node.childIds ?? []) walk(lookup.get(childId), nextDepth, name === '' ? parentName : name, level + 1, lookup)
    }
    for (const root of roots) walk(root, 0, '')
    const frames = await this.#sameOriginFrames()
    for (const frame of frames) {
      if (frame.url === this.#state.url) continue
      try {
        const { nodes: frameNodes = [] } = await this.#conn.send('Accessibility.getFullAXTree', { frameId: frame.id }, sessionId)
        if (frameNodes.length === 0) continue
        const frameById = new Map(frameNodes.map((node) => [node.nodeId, node]))
        const frameRoots = frameNodes.filter((node) => node.parentId === undefined || !frameById.has(node.parentId))
        const frameTitle = frame.name === '' ? frame.url : frame.name
        lines.push(`${interactiveOnly ? '' : '  '}- iframe "${truncate(frameTitle, 80)}"`)
        lineRefs.push('')
        for (const root of frameRoots) walk(root, interactiveOnly ? 0 : 1, '', 0, frameById)
      } catch {
        // A detached or cross-process frame cannot be read this way.
      }
    }
    if (boxes && refEntries.length > 0) {
      const boxesByRef = await this.#readBoxes(refEntries)
      for (let index = 0; index < lines.length; index += 1) {
        const box = boxesByRef.get(lineRefs[index])
        if (box !== undefined) lines[index] += ` [box=${box.x},${box.y},${box.width},${box.height}]`
      }
    }
    let text = ''
    if (!interactiveOnly) {
      const { result } = await this.#conn.send('Runtime.evaluate', {
        expression: "(document.body ? document.body.innerText : '').slice(0, 4000)",
        returnByValue: true,
      }, sessionId)
      text = typeof result?.value === 'string' ? result.value : ''
    }
    return {
      url: this.#state.url,
      title: this.#state.title,
      viewport: { width: this.#state.width, height: this.#state.height },
      outline: lines.join('\n'),
      text,
      refs: this.#refs.size,
      truncated,
    }
  }

  /**
   * Click one element by snapshot ref or CSS selector.
   * @param {{ ref?: string, selector?: string }} target - the element to click.
   * @param {{ button?: 'left' | 'right' | 'middle', clickCount?: number }} [options] - mouse button and clicks.
   * @returns {Promise<{ x: number, y: number, text: string, button: string, clickCount: number }>}
   */
  async click(target, options = {}) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const objectId = await this.#resolveObject(target)
    const point = await this.#measure(objectId)
    await this.#hitTest(objectId, point)
    const button = parseButton(options.button)
    const clickCount = parseClickCount(options.clickCount)
    await this.#dispatchMouse(point, { button, clickCount })
    await delay(250)
    return { ...point, button, clickCount }
  }

  /**
   * Click a viewport coordinate, for canvases and other elements without a ref.
   * @param {{ x: number, y: number, button?: 'left' | 'right' | 'middle', clickCount?: number }} input - the point.
   * @returns {Promise<{ x: number, y: number, text: string, button: string, clickCount: number }>}
   */
  async clickAt({ x, y, button, clickCount } = {}) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const point = this.#viewportPoint(x, y)
    const parsedButton = parseButton(button)
    const parsedCount = parseClickCount(clickCount)
    await this.#dispatchMouse(point, { button: parsedButton, clickCount: parsedCount })
    await delay(250)
    return { ...point, text: '', button: parsedButton, clickCount: parsedCount }
  }

  /**
   * Move the mouse over one element.
   * @param {{ ref?: string, selector?: string }} target - the element to hover.
   * @returns {Promise<{ x: number, y: number, text: string }>}
   */
  async hover(target) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const objectId = await this.#resolveObject(target)
    const point = await this.#measure(objectId)
    await this.#hitTest(objectId, point)
    await this.#input('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(point.x),
      y: Math.round(point.y),
      button: 'none',
    }, this.#sessionId)
    await delay(120)
    return point
  }

  /**
   * Drag from one element to another with a mouse-button drag.
   * @param {{ from?: object, to?: object, steps?: number }} input - endpoints and interpolation steps.
   * @returns {Promise<{ from: { x: number, y: number, text: string }, to: { x: number, y: number, text: string } }>}
   */
  async drag({ from, to, steps } = {}) {
    await this.ensureStarted()
    this.#assertNoDialog()
    if (from === undefined || to === undefined) throw new CdpError('drag needs both from and to targets')
    const fromId = await this.#resolveObject(from)
    const toId = await this.#resolveObject(to)
    const fromPoint = await this.#measure(fromId)
    const toPoint = await this.#measure(toId)
    await this.#hitTest(fromId, fromPoint)
    await this.#hitTest(toId, toPoint)
    const count = clamp(Number.isFinite(steps) ? Number(steps) : 10, 2, 40)
    const sessionId = this.#sessionId
    const startX = Math.round(fromPoint.x)
    const startY = Math.round(fromPoint.y)
    const endX = Math.round(toPoint.x)
    const endY = Math.round(toPoint.y)
    await this.#input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: startY, button: 'none' }, sessionId)
    await this.#input('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1 }, sessionId)
    if (this.#dialog !== null) return { from: fromPoint, to: toPoint }
    for (let index = 1; index <= count; index += 1) {
      const x = Math.round(startX + ((endX - startX) * index) / count)
      const y = Math.round(startY + ((endY - startY) * index) / count)
      await this.#input('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }, sessionId)
      if (this.#dialog !== null) return { from: fromPoint, to: toPoint }
      await delay(16)
    }
    await this.#input('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: endY, button: 'left', buttons: 0, clickCount: 1 }, sessionId)
    await delay(150)
    return { from: fromPoint, to: toPoint }
  }

  /**
   * List the controlled browser's page targets.
   * @returns {Promise<{ current: string | null, tabs: Array<{ targetId: string, url: string, title: string }> }>}
   */
  async listTabs() {
    await this.ensureStarted()
    const { targetInfos = [] } = await this.#conn.send('Target.getTargets')
    const tabs = targetInfos
      .filter((target) => target.type === 'page')
      .map((target) => ({
        targetId: target.targetId,
        url: typeof target.url === 'string' ? target.url : '',
        title: typeof target.title === 'string' ? target.title : '',
        sessionId: this.#ownerOf(target.targetId),
      }))
    return { current: this.#targetId ?? null, tabs }
  }

  /**
   * Create and select a new page.
   * @param {string} [url] - address; defaults to about:blank.
   * @returns {Promise<object>} the tab list after switching.
   */
  async newTab(url = 'about:blank') {
    const target = typeof url === 'string' && url.trim() !== '' ? normalizeUrl(url) : 'about:blank'
    this.#assertNavigationAllowed(target)
    await this.ensureStarted()
    const record = this.#contextRecord(this.#activeSessionId)
    const params = { url: target }
    if (record !== null) params.browserContextId = record.contextId
    const { targetId } = await this.#conn.send('Target.createTarget', params)
    return this.selectTab(targetId)
  }

  /**
   * Attach to one page target without opening a new one.
   * @param {string} targetId - the target id from listTabs.
   * @returns {Promise<object>} the tab list with the new current page.
   */
  async selectTab(targetId) {
    await this.ensureStarted()
    if (typeof targetId !== 'string' || targetId === '') throw new CdpError('selectTab needs a targetId')
    if (targetId === this.#targetId) return this.listTabs()
    const { targetInfos = [] } = await this.#conn.send('Target.getTargets')
    const target = targetInfos.find((entry) => entry.targetId === targetId && entry.type === 'page')
    if (target === undefined) throw new CdpError(`no page target ${targetId}`)
    const known = [...this.#contexts.values()].find((record) => record.targetId === targetId)
    const inContext = known ?? [...this.#contexts.values()].find((record) => record.contextId === target.browserContextId)
    const previous = this.#sessionId
    const { sessionId } = await this.#conn.send('Target.attachToTarget', { targetId, flatten: true })
    this.#sessionId = sessionId
    this.#targetId = targetId
    this.#refs.clear()
    this.#console = []
    this.#requests.clear()
    this.#network.clear()
    this.#networkActivityAt = 0
    this.#fetchEnabled = false
    if (previous !== undefined && previous !== sessionId) {
      this.#forgetPage(previous)
      this.#conn.send('Target.detachFromTarget', { sessionId: previous }).catch(() => { /* the old page stays open */ })
    }
    await this.#initializePage(this.#conn, sessionId)
    this.#state.phase = 'running'
    this.#state.error = null
    this.#state.url = typeof target.url === 'string' ? target.url : 'about:blank'
    this.#state.title = typeof target.title === 'string' ? target.title : ''
    if (inContext !== undefined) {
      const same = inContext.sessionId === this.#activeSessionId
      if (!same) this.#activateRecord(inContext)
      inContext.targetId = targetId
      inContext.cdpSessionId = sessionId
      inContext.url = this.#state.url
      inContext.title = this.#state.title
      inContext.phase = 'running'
      inContext.lastActivityAt = Date.now()
      this.#activeSessionId = inContext.sessionId
      this.#sessionTabs.set(inContext.sessionId, targetId)
    } else {
      this.#activeSessionId = this.#ownerOf(targetId)
    }
    await this.#refreshIdentity()
    if (this.#activeSessionId !== null) this.#rememberSession(this.#activeSessionId)
    if (this.#screencastRefs > 0) await this.#beginScreencast().catch(() => {})
    return this.listTabs()
  }

  /**
   * Close one page target; closing the current page selects the next one.
   * @param {string} [targetId] - target to close; defaults to the current page.
   * @returns {Promise<object>} the tab list after closing.
   */
  async closeTab(targetId) {
    await this.ensureStarted()
    const before = await this.listTabs()
    const closing = typeof targetId === 'string' && targetId !== '' ? targetId : this.#targetId
    if (closing === undefined || closing === null) throw new CdpError('there is no page to close')
    if (!before.tabs.some((tab) => tab.targetId === closing)) throw new CdpError(`no page target ${closing}`)
    const { targetInfos = [] } = await this.#conn.send('Target.getTargets')
    const target = targetInfos.find((entry) => entry.targetId === closing && entry.type === 'page')
    if (target === undefined) throw new CdpError(`no page target ${closing}`)
    const record = target.browserContextId === undefined
      ? undefined
      : [...this.#contexts.values()].find((entry) => entry.contextId === target.browserContextId)
    if (record !== undefined) {
      // A conversation's context can contain several pages. Closing one page
      // must never dispose the context: keep the siblings, and if this was the
      // last page create a fresh about:blank in the same context.
      if (record.targetId !== closing) {
        await this.#conn.send('Target.closeTarget', { targetId: closing })
        await delay(120)
        return this.listTabs()
      }
      const siblings = targetInfos.filter((entry) => entry.type === 'page'
        && entry.browserContextId === record.contextId && entry.targetId !== closing)
      if (record.cdpSessionId !== undefined) {
        this.#forgetPage(record.cdpSessionId)
        await this.#conn.send('Target.detachFromTarget', { sessionId: record.cdpSessionId }).catch(() => {})
      }
      await this.#conn.send('Target.closeTarget', { targetId: closing })
      await delay(150)
      let next = siblings.find((entry) => entry.targetId === this.#targetId) ?? siblings[0]
      if (next === undefined) {
        const created = await this.#conn.send('Target.createTarget', { url: 'about:blank', browserContextId: record.contextId })
        next = { targetId: created.targetId, url: 'about:blank', title: '' }
      }
      await this.#bindRecordPage(record, next.targetId, next.url, next.title)
      this.#sessionTabs.set(record.sessionId, next.targetId)
      return this.listTabs()
    }
    const owner = this.#ownerOf(closing)
    if (owner !== null && this.#sessionTabs.get(owner) === closing) {
      this.#sessionTabs.delete(owner)
      this.#sessionCache.delete(owner)
      if (this.#activeSessionId === owner) this.#activeSessionId = null
    }
    await this.#conn.send('Target.closeTarget', { targetId: closing })
    await delay(200)
    if (closing === this.#targetId) {
      const remaining = (await this.listTabs()).tabs.filter((tab) => tab.targetId !== closing)
      if (remaining.length > 0) {
        await this.selectTab(remaining[0].targetId)
      } else {
        await this.#attachDefaultPage()
      }
    }
    return this.listTabs()
  }

  /**
   * Attach a replacement page inside an existing conversation context.
   * @param {object} record - conversation record.
   * @param {string} targetId - page to attach.
   * @param {string} [url] - known URL.
   * @param {string} [title] - known title.
   * @returns {Promise<void>}
   */
  async #bindRecordPage(record, targetId, url = 'about:blank', title = '') {
    const connection = this.#conn
    if (connection === undefined || connection.closed) throw new CdpError('the browser connection is closed')
    const active = record.sessionId === this.#activeSessionId
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true })
    record.targetId = targetId
    record.cdpSessionId = sessionId
    record.url = url
    record.title = title
    record.phase = 'running'
    record.error = null
    record.lastActivityAt = Date.now()
    record.frame = null
    record.frameAt = 0
    record.screencast.active = false
    if (active) {
      this.#targetId = targetId
      this.#sessionId = sessionId
      this.#state.phase = 'running'
      this.#state.url = url
      this.#state.title = title
      this.#state.error = null
      this.#refs.clear()
      this.#console = []
      this.#requests.clear()
      this.#network.clear()
      this.#networkActivityAt = 0
      this.#fetchEnabled = false
      this.#dialog = null
    }
    await this.#initializePage(connection, sessionId)
    if (active) {
      await this.#refreshIdentity()
      this.#rememberSession(record.sessionId)
      this.#touch()
    }
  }

  /** Create a default-context page when no session page remains. */
  async #attachDefaultPage() {
    const connection = this.#conn
    if (connection === undefined || connection.closed) return
    const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true })
    this.#targetId = targetId
    this.#sessionId = sessionId
    this.#activeSessionId = null
    this.#state.phase = 'running'
    this.#state.url = 'about:blank'
    this.#state.title = 'about:blank'
    await this.#initializePage(connection, sessionId)
    await this.#refreshIdentity().catch(() => {})
  }

  /**
   * Crash the current renderer. Recovery is exercised by dev-check scripts;
   * browser tools are not expected to call this.
   * @returns {Promise<void>}
   */
  async crashForTesting() {
    await this.ensureStarted()
    const sessionId = this.#sessionId
    try {
      await Promise.race([
        this.#conn.send('Page.crash', {}, sessionId).catch(() => { /* the target crashes */ }),
        delay(1000),
      ])
    } catch {
      // The renderer may be gone before the command answers.
    }
    await delay(600)
  }

  /**
   * Drop the debugging socket without closing Chrome. The next browser
   * operation must reconnect and keep the current page; used by dev checks.
   * @returns {void}
   */
  dropConnectionForTesting() {
    this.#conn?.close()
  }

  /**
   * Focus one field, replace or append its content, and optionally submit.
   * @param {{ ref?: string, selector?: string, text: string, submit?: boolean, clear?: boolean, append?: boolean }} input - the edit.
   * @returns {Promise<{ label: string }>} the field's label, for the activity log.
   */
  async type(input) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const sessionId = this.#sessionId
    const objectId = await this.#resolveObject(input)
    const label = await this.#describe(objectId)
    await this.#conn.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function (append) {
        if (typeof this.focus === 'function') this.focus();
        const ownerDocument = this.ownerDocument;
        const selectionRoot = ownerDocument && ownerDocument.defaultView ? ownerDocument.defaultView : window;
        if (append === true) {
          if (this.isContentEditable) {
            const range = ownerDocument.createRange();
            range.selectNodeContents(this);
            range.collapse(false);
            const selection = selectionRoot.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
          } else if (typeof this.setSelectionRange === 'function' && typeof this.value === 'string') {
            try { this.setSelectionRange(this.value.length, this.value.length); } catch (error) { /* inputs without selection support */ }
          }
          return true;
        }
        if (this.isContentEditable) {
          const range = ownerDocument.createRange();
          range.selectNodeContents(this);
          const selection = selectionRoot.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        } else if (typeof this.select === 'function') {
          try { this.select(); } catch (error) { /* inputs without selection support */ }
        }
        return true;
      }`,
      arguments: [{ value: input.append === true }],
      returnByValue: true,
    }, sessionId)
    const text = typeof input.text === 'string' ? input.text : ''
    if (text !== '') {
      await this.#input('Input.insertText', { text }, sessionId)
      if (this.#dialog !== null) return { label }
    } else if (input.clear === true) await this.press('Backspace')
    if (input.submit === true && this.#dialog === null) await this.press('Enter')
    await delay(200)
    return { label }
  }

  /**
   * Choose an option in a native `<select>` by value, visible label, or index.
   * @param {{ ref?: string, selector?: string }} target - the select element.
   * @param {{ value?: string, label?: string, index?: number }} choice - what to choose.
   * @returns {Promise<{ value: string, label: string, index: number }>}
   */
  async selectOption(target, choice = {}) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const value = typeof choice.value === 'string' ? choice.value : null
    const label = typeof choice.label === 'string' ? choice.label : null
    const index = Number.isInteger(choice.index) ? choice.index : null
    if (value === null && label === null && index === null) throw new CdpError('selectOption needs value, label, or index')
    const objectId = await this.#resolveObject(target)
    const { result, exceptionDetails } = await this.#conn.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function (value, label, index) {
        if (!(this instanceof (this.ownerDocument?.defaultView?.HTMLSelectElement ?? HTMLSelectElement))) return { ok: false, error: 'the element is not a <select>' };
        const options = Array.from(this.options);
        let chosen = null;
        if (typeof index === 'number' && index >= 0) chosen = options[index] ?? null;
        else if (typeof value === 'string') chosen = options.find((option) => option.value === value) ?? null;
        else if (typeof label === 'string') {
          chosen = options.find((option) => option.text.trim() === label)
            ?? options.find((option) => option.text.includes(label))
            ?? null;
        }
        if (chosen === null) {
          return {
            ok: false,
            error: 'no matching option',
            options: options.slice(0, 25).map((option) => ({ value: option.value, label: option.text.trim(), selected: option.selected })),
          };
        }
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(this, chosen.value);
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: this.value, label: chosen.text.trim(), index: chosen.index };
      }`,
      arguments: [{ value }, { value: label }, { value: index }],
      returnByValue: true,
    }, this.#sessionId)
    if (exceptionDetails !== undefined) throw new CdpError('the select could not be changed')
    const info = result?.value
    if (info?.ok !== true) {
      const choices = Array.isArray(info?.options)
        ? ` Available: ${info.options.map((option) => `${option.value}=${option.label}${option.selected ? ' (selected)' : ''}`).join(', ')}`
        : ''
      throw new CdpError(`${info?.error ?? 'cannot select the option'}${choices}`)
    }
    await delay(120)
    return { value: info.value, label: info.label, index: info.index }
  }

  /**
   * Set files on a file input through the DevTools DOM domain.
   * @param {{ ref?: string, selector?: string }} target - the file input.
   * @param {string[]} files - absolute or relative file paths.
   * @returns {Promise<{ count: number, names: string[] }>}
   */
  async uploadFiles(target, files) {
    await this.ensureStarted()
    this.#assertNoDialog()
    if (!Array.isArray(files) || files.length === 0) throw new CdpError('uploadFiles needs at least one file path')
    const paths = files.map((file) => path.resolve(String(file)))
    for (const file of paths) {
      if (!existsSync(file)) throw new CdpError(`file does not exist: ${file}`)
    }
    const objectId = await this.#resolveObject(target)
    const { node } = await this.#conn.send('DOM.describeNode', { objectId }, this.#sessionId)
    if (node?.backendNodeId === undefined) throw new CdpError('the file input could not be resolved')
    try {
      await this.#conn.send('DOM.setFileInputFiles', { files: paths, backendNodeId: node.backendNodeId }, this.#sessionId)
    } catch (error) {
      throw new CdpError(`cannot set files: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    await delay(150)
    return { count: paths.length, names: paths.map((file) => path.basename(file)) }
  }

  /**
   * Fill several text fields in order with real input events.
   * @param {Array<{ ref?: string, selector?: string, text?: string, value?: string, append?: boolean, clear?: boolean }>} fields - the fields.
   * @returns {Promise<Array<{ label: string, target: string }>>}
   */
  async fillForm(fields) {
    await this.ensureStarted()
    this.#assertNoDialog()
    if (!Array.isArray(fields) || fields.length === 0) throw new CdpError('fillForm needs at least one field')
    const results = []
    for (const field of fields) {
      if (field === null || typeof field !== 'object') throw new CdpError('each field must be an object')
      const target = typeof field.target === 'string' ? field.target : undefined
      const ref = typeof field.ref === 'string' ? field.ref : undefined
      const selector = typeof field.selector === 'string' ? field.selector : undefined
      if (target === undefined && ref === undefined && selector === undefined) throw new CdpError('each field needs target, ref, or selector')
      if (field.append === true && field.clear === true) throw new CdpError('a field cannot append and clear at the same time')
      const text = typeof field.text === 'string' ? field.text : typeof field.value === 'string' ? field.value : ''
      const filled = await this.type({
        target,
        ref,
        selector,
        text,
        append: field.append === true,
        clear: field.clear === true,
      })
      results.push({ label: filled.label, target: target ?? ref ?? selector ?? '' })
      if (this.#dialog !== null) break
    }
    return results
  }

  /**
   * Read a short human label for one resolved element.
   * @param {string} objectId - remote object of the element.
   * @returns {Promise<string>}
   */
  async #describe(objectId) {
    try {
      const { result } = await this.#conn.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          const attribute = this.getAttribute
            ? (this.getAttribute('aria-label') || this.getAttribute('placeholder') || this.getAttribute('name') || '')
            : '';
          const value = typeof this.value === 'string' ? this.value : '';
          return String(attribute || value || this.tagName || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
        }`,
        returnByValue: true,
      }, this.#sessionId)
      return typeof result?.value === 'string' ? result.value : ''
    } catch {
      return ''
    }
  }

  /**
   * Send one key or chord to the page.
   * @param {string} expression - such as Enter, Tab, Escape, Control+A.
   * @returns {Promise<void>}
   */
  async press(expression) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const sessionId = this.#sessionId
    const parsed = parseKey(expression)
    if (parsed.insert !== undefined) {
      await this.#input('Input.insertText', { text: parsed.insert }, sessionId)
      await delay(80)
      return
    }
    const { key, code, virtualKeyCode, modifiers, text } = parsed
    const base = { key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers }
    await this.#input('Input.dispatchKeyEvent', { ...base, type: 'keyDown', ...(text === undefined ? {} : { text, unmodifiedText: text }) }, sessionId)
    if (this.#dialog !== null) return
    if (text !== undefined && key !== 'Enter') {
      await this.#input('Input.dispatchKeyEvent', { ...base, type: 'char', text, unmodifiedText: text }, sessionId)
      if (this.#dialog !== null) return
    }
    await this.#input('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, sessionId)
    await delay(90)
  }

  /**
   * Scroll the page, or bring one element into view.
   * @param {{ direction?: 'up' | 'down' | 'left' | 'right', amount?: number, ref?: string, selector?: string }} input - the scroll.
   * @returns {Promise<void>}
   */
  async scroll(input = {}) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const sessionId = this.#sessionId
    if (input.target !== undefined || input.ref !== undefined || input.selector !== undefined) {
      const objectId = await this.#resolveObject(input)
      await this.#conn.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () { this.scrollIntoView({ block: "center", inline: "center" }); return true; }',
        returnByValue: true,
      }, sessionId)
      await delay(150)
      return
    }
    const direction = input.direction ?? 'down'
    const amount = Number.isFinite(input.amount) ? Number(input.amount) : 1
    const step = clamp(amount, 0.25, 10) * 600
    const deltaX = direction === 'left' ? -step : direction === 'right' ? step : 0
    const deltaY = direction === 'up' ? -step : direction === 'down' ? step : 0
    await this.#input('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(this.#state.width / 2),
      y: Math.round(this.#state.height / 2),
      deltaX,
      deltaY,
      button: 'none',
    }, sessionId)
    await delay(250)
  }

  /**
   * Evaluate one expression in the page.
   * @param {string} expression - JavaScript expression.
   * @returns {Promise<any>}
   */
  async evaluate(expression) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const { result, exceptionDetails } = await this.#conn.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      includeCommandLineAPI: true,
      timeout: 15000,
    }, this.#sessionId)
    if (exceptionDetails !== undefined) {
      const description = exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'unknown page error'
      throw new CdpError(`the page threw while evaluating: ${truncate(description, 600)}`)
    }
    if (result?.unserializableValue !== undefined && result.value === undefined) return result.unserializableValue
    return result?.value ?? null
  }

  /**
   * Wait until every supplied page condition holds.
   *
   * Conditions are ANDed: `text` (visible body text, case-insensitive by
   * default), `selector` (present and visible), `url` (exact or with `*`
   * wildcards), and `networkIdle` (no tracked requests in flight for 500 ms).
   * Only one condition is required.
   * @param {{ text?: string, selector?: string, url?: string, networkIdle?: boolean, caseSensitive?: boolean, timeoutMs?: number }} conditions - what to wait for.
   * @returns {Promise<{ elapsedMs: number, url: string, title: string }>}
   */
  async waitFor({ text, selector, url, networkIdle = false, caseSensitive = false, timeoutMs } = {}) {
    await this.ensureStarted()
    this.#assertNoDialog()
    if (text === undefined && selector === undefined && url === undefined && networkIdle !== true) {
      throw new CdpError('waitFor needs at least one condition: text, selector, url, or networkIdle')
    }
    const timeout = clampWaitTimeout(timeoutMs)
    const startedAt = Date.now()
    const deadline = startedAt + timeout
    const expression = text === undefined && selector === undefined && url === undefined
      ? null
      : buildWaitProbe({ text, selector, caseSensitive })
    let last = { url: this.#state.url, title: this.#state.title }

    for (;;) {
      if (this.#dialog !== null) this.#assertNoDialog()
      let probe = null
      if (expression !== null) {
        try {
          probe = await this.evaluate(expression)
        } catch (error) {
          if (this.#conn === undefined || this.#conn.closed) {
            throw new CdpError('the browser connection closed while waiting', { cause: error })
          }
          // Navigation destroys the execution context; poll again until the deadline.
          if (!isNavigationError(error)) throw error
        }
      }
      if (probe !== null && typeof probe === 'object') {
        if (typeof probe.selectorError === 'string' && probe.selectorError !== '') {
          throw new CdpError(`invalid selector "${selector}": ${probe.selectorError}`)
        }
        last = {
          url: typeof probe.href === 'string' ? probe.href : last.url,
          title: typeof probe.title === 'string' ? probe.title : last.title,
        }
      } else {
        last = { url: this.#state.url, title: this.#state.title }
      }

      const textOk = text === undefined || probe?.textOk === true
      const selectorOk = selector === undefined || probe?.selectorOk === true
      const urlOk = url === undefined || matchesUrl(last.url, url)
      const idleOk = networkIdle !== true || this.#isNetworkIdle()
      if (textOk && selectorOk && urlOk && idleOk) {
        return { elapsedMs: Date.now() - startedAt, url: last.url, title: last.title }
      }
      if (Date.now() >= deadline) {
        const waited = Date.now() - startedAt
        const wanted = describeWaitConditions({ text, selector, url, networkIdle })
        throw new CdpError(`timed out after ${waited}ms waiting for ${wanted}; current URL: ${last.url || '(empty)'}`
          + `${last.title === '' ? '' : `, title: "${last.title}"`}. The page may still be loading; raise timeoutMs or call browser_snapshot to inspect.`)
      }
      await delay(WAIT_POLL_MS)
    }
  }

  /**
   * Poll one deterministic assertion until it passes or times out.
   *
   * A false assertion is a normal result (`ok: false`), not a protocol error:
   * the agent needs the actual value to decide what to do next.
   * @param {{ condition: string, target?: string, ref?: string, selector?: string, text?: string, value?: string, checked?: boolean, url?: string, title?: string, count?: number, caseSensitive?: boolean, timeoutMs?: number }} input - the assertion.
   * @returns {Promise<{ ok: boolean, label: string, expected: string, actual: string, elapsedMs: number }>}
   */
  async assert(input = {}) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const timeout = clampAssertTimeout(input.timeoutMs)
    const startedAt = Date.now()
    let last = null
    for (;;) {
      try {
        last = await this.#probeAssertion(input)
      } catch (error) {
        if (this.#conn === undefined || this.#conn.closed) throw error
        last = {
          ok: false,
          label: String(input.condition ?? 'assertion'),
          expected: 'a readable page',
          actual: error instanceof Error ? error.message : String(error),
        }
      }
      if (last.ok) return { ...last, elapsedMs: Date.now() - startedAt }
      if (Date.now() - startedAt >= timeout) return { ...last, elapsedMs: Date.now() - startedAt }
      await delay(WAIT_POLL_MS)
    }
  }

  /**
   * Evaluate one assertion once.
   * @param {object} input - assertion fields.
   * @returns {Promise<{ ok: boolean, label: string, expected: string, actual: string }>}
   */
  async #probeAssertion(input) {
    const condition = String(input.condition ?? '')
    const caseSensitive = input.caseSensitive === true
    if (condition === 'textVisible' || condition === 'textHidden') {
      const text = String(input.text ?? '')
      const { result } = await this.#conn.send('Runtime.evaluate', {
        expression: "(document.body ? document.body.innerText : '').slice(0, 8000)",
        returnByValue: true,
      }, this.#sessionId)
      const body = typeof result?.value === 'string' ? result.value : ''
      const haystack = caseSensitive ? body : body.toLowerCase()
      const needle = caseSensitive ? text : text.toLowerCase()
      const found = haystack.includes(needle)
      const ok = condition === 'textVisible' ? found : !found
      return {
        ok,
        label: `${condition === 'textVisible' ? 'text visible' : 'text hidden'} ${JSON.stringify(text)}`,
        expected: condition === 'textVisible' ? 'present in visible text' : 'absent from visible text',
        actual: found ? `present${textSnippet(body, text, caseSensitive)}` : 'not present',
      }
    }
    if (condition === 'elementVisible' || condition === 'elementHidden') {
      const found = await this.#resolveElements(input, { includeHidden: true })
      const label = describeTarget(found.spec)
      if (found.objectIds.length === 0) {
        return {
          ok: condition === 'elementHidden',
          label,
          expected: condition === 'elementVisible' ? 'visible' : 'hidden',
          actual: 'not found',
        }
      }
      if (found.objectIds.length > 1) {
        const candidates = await this.#describeElements(found.arrayObjectId)
        return {
          ok: false,
          label,
          expected: 'one element',
          actual: `${found.objectIds.length} matches${candidates === '' ? '' : `: ${candidates}`}`,
        }
      }
      const info = await this.#elementVisibility(found.objectIds[0])
      const ok = condition === 'elementVisible' ? info.visible : !info.visible
      return {
        ok,
        label,
        expected: condition === 'elementVisible' ? 'visible' : 'hidden',
        actual: `${info.visible ? 'visible' : 'hidden'} (${info.reason})`,
      }
    }
    if (condition === 'value') {
      const objectId = await this.#resolveObject(input, { includeHidden: true })
      const { result } = await this.#conn.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () { return this.value === undefined || this.value === null ? null : String(this.value); }',
        returnByValue: true,
      }, this.#sessionId)
      const actual = result?.value ?? null
      const expected = String(input.value ?? '')
      return {
        ok: actual === expected,
        label: `value of ${describeTarget(parseTarget(input))}`,
        expected: JSON.stringify(expected),
        actual: JSON.stringify(actual),
      }
    }
    if (condition === 'checked') {
      const objectId = await this.#resolveObject(input, { includeHidden: true })
      const { result } = await this.#conn.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () { return this.checked === true; }',
        returnByValue: true,
      }, this.#sessionId)
      const actual = result?.value === true
      const expected = input.checked !== false
      return {
        ok: actual === expected,
        label: `checked state of ${describeTarget(parseTarget(input))}`,
        expected: String(expected),
        actual: String(actual),
      }
    }
    if (condition === 'url') {
      await this.#refreshIdentity()
      const expected = String(input.url ?? '')
      return {
        ok: matchesUrl(this.#state.url, expected),
        label: 'page URL',
        expected,
        actual: this.#state.url === '' ? '(empty)' : this.#state.url,
      }
    }
    if (condition === 'title') {
      await this.#refreshIdentity()
      const expected = String(input.title ?? '')
      return {
        ok: this.#state.title === expected,
        label: 'page title',
        expected: JSON.stringify(expected),
        actual: JSON.stringify(this.#state.title),
      }
    }
    if (condition === 'count') {
      const found = await this.#resolveElements(input, { includeHidden: true })
      const expected = Number(input.count)
      return {
        ok: found.objectIds.length === expected,
        label: `count of ${describeTarget(found.spec)}`,
        expected: String(expected),
        actual: String(found.objectIds.length),
      }
    }
    throw new CdpError(`unknown assertion condition "${condition}"`)
  }

  /**
   * Answer a JavaScript dialog that is waiting under `dialogBehavior: "manual"`.
   * @param {{ accept?: boolean, promptText?: string }} [answer] - true accepts, false dismisses.
   * @returns {Promise<{ type: string, message: string, accepted: boolean }>} the answered dialog.
   */
  async handleDialog({ accept = false, promptText } = {}) {
    await this.ensureStarted()
    const info = this.#dialog
    if (info === null) {
      throw new CdpError(`no JavaScript dialog is waiting; the current dialogBehavior is "${this.#options.dialogBehavior}"`)
    }
    const shouldAccept = accept === true
    await this.#conn.send('Page.handleJavaScriptDialog', {
      accept: shouldAccept,
      ...(shouldAccept && info.type === 'prompt' ? { promptText: typeof promptText === 'string' ? promptText : info.defaultPrompt } : {}),
    }, this.#sessionId)
    this.#dialog = null
    this.#pushConsole('warn', `dialog ${info.type} ${shouldAccept ? 'accepted' : 'dismissed'}: ${info.message}`, info.url)
    return { ...info, accepted: shouldAccept }
  }

  /** Whether no tracked request is in flight and the network has been quiet for 500 ms. */
  #isNetworkIdle() {
    if (this.#requests.size > 0) return false
    return this.#networkActivityAt === 0 || Date.now() - this.#networkActivityAt >= NETWORK_IDLE_MS
  }

  /** Reject page operations while a manual dialog is waiting. */
  #assertNoDialog() {
    const info = this.#dialog
    if (info === null) return
    throw new CdpError(`a JavaScript ${info.type} dialog is open ("${truncate(info.message, 200)}"); `
      + 'call browser_handle_dialog with accept true or false first')
  }

  /**
   * Set the emulated viewport.
   * @param {{ width: number, height: number }} size - target viewport.
   * @returns {Promise<object>} the new state.
   */
  async resize(size) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const width = clamp(size.width ?? this.#state.width, 320, 3840)
    const height = clamp(size.height ?? this.#state.height, 240, 2160)
    await this.#conn.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 640,
    }, this.#sessionId)
    this.#state.width = width
    this.#state.height = height
    const record = this.#contextRecord(this.#activeSessionId)
    if (record !== null) {
      record.width = width
      record.height = height
      record.lastActivityAt = Date.now()
    }
    await delay(250)
    return this.getState()
  }

  /**
   * Read computed styles and matched CSS rules for one element.
   * @param {{ target?: string, ref?: string, selector?: string }} target - the element.
   * @param {{ properties?: string | string[], rules?: boolean }} [options] - property filter and rule toggle.
   * @returns {Promise<{ label: string, computed: Array<{ name: string, value: string }>, matched: Array<object> }>}
   */
  async styles(target = {}, options = {}) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const objectId = await this.#resolveObject(target, { includeHidden: true })
    const label = describeTarget(parseTarget(target))
    const wanted = parseStyleProperties(options.properties)
    await this.#conn.send('DOM.enable', {}, this.#sessionId)
    await this.#conn.send('DOM.getDocument', { depth: 0 }, this.#sessionId)
    await this.#conn.send('CSS.enable', {}, this.#sessionId)
    const { nodeId } = await this.#conn.send('DOM.requestNode', { objectId }, this.#sessionId)
    const { computedStyle = [] } = await this.#conn.send('CSS.getComputedStyleForNode', { nodeId }, this.#sessionId)
    const computed = computedStyle
      .filter((property) => wanted === null || wanted.has(String(property.name).toLowerCase()))
      .slice(0, 80)
      .map((property) => ({ name: String(property.name), value: String(property.value) }))
    let matched = []
    if (options.rules !== false) {
      try {
        const rulesResult = await this.#conn.send('CSS.getMatchedStylesForNode', { nodeId }, this.#sessionId)
        matched = (rulesResult.matchedCSSRules ?? []).slice(0, 12).map((match) => {
          const rule = match.rule ?? {}
          const properties = (rule.style?.cssProperties ?? [])
            .filter((property) => wanted === null || wanted.has(String(property.name).toLowerCase()))
            .slice(0, 20)
            .map((property) => `${property.name}: ${property.value}${property.important === true ? ' !important' : ''}`)
          return {
            selector: rule.selectorList?.text ?? '',
            origin: rule.origin ?? '',
            properties,
          }
        }).filter((rule) => rule.selector !== '')
      } catch {
        // Some nodes (pseudo-elements, detached nodes) have no matched styles.
      }
    }
    return { label, computed, matched }
  }

  /**
   * Capture one element, scrolled into view, with optional padding.
   * @param {{ target?: string, ref?: string, selector?: string }} target - the element.
   * @param {{ padding?: number, maxDimension?: number }} [options] - padding and output size.
   * @returns {Promise<{ buffer: Buffer, label: string, width: number, height: number }>}
   */
  async captureElement(target = {}, options = {}) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const objectId = await this.#resolveObject(target, { includeHidden: false })
    const { result, exceptionDetails } = await this.#conn.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: String.raw`function () {
        this.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = this.getBoundingClientRect();
        return {
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
          label: (this.getAttribute('aria-label') || this.innerText || this.value || this.tagName || '').toString().slice(0, 80),
        };
      }`,
      returnByValue: true,
    }, this.#sessionId)
    if (exceptionDetails !== undefined) throw new CdpError('the element could not be measured for a screenshot')
    const rect = result?.value
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) throw new CdpError('the element has no visible box to capture')
    const padding = clamp(options.padding ?? 0, 0, 100)
    const width = Math.max(1, Math.ceil(rect.width) + padding * 2)
    const height = Math.max(1, Math.ceil(rect.height) + padding * 2)
    const maxDimension = options.maxDimension ?? MAX_TOOL_DIMENSION
    const scale = Math.min(1, maxDimension / Math.max(width, height))
    const { data } = await this.#conn.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: {
        x: Math.max(0, Math.floor(rect.x) - padding),
        y: Math.max(0, Math.floor(rect.y) - padding),
        width,
        height,
        scale,
      },
    }, this.#sessionId)
    return {
      buffer: Buffer.from(data, 'base64'),
      label: cleanText(String(rect.label ?? '')),
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    }
  }

  /**
   * Apply or clear device emulation beyond the viewport size.
   * @param {{ colorScheme?: string, reducedMotion?: string, mobile?: boolean, touch?: boolean, cpuThrottlingRate?: number, network?: string, timezone?: string, geolocation?: string, clear?: boolean }} [options] - emulation settings.
   * @returns {Promise<{ applied: string[] }>}
   */
  async emulate(options = {}) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const applied = []
    if (options.clear === true) {
      await this.#conn.send('Emulation.setEmulatedMedia', { features: [] }, this.#sessionId)
      await this.#conn.send('Emulation.setTouchEmulationEnabled', { enabled: false }, this.#sessionId)
      await this.#conn.send('Emulation.setDeviceMetricsOverride', {
        width: this.#state.width,
        height: this.#state.height,
        deviceScaleFactor: 1,
        mobile: false,
      }, this.#sessionId)
      await this.#conn.send('Emulation.setCPUThrottlingRate', { rate: 1 }, this.#sessionId)
      await this.#conn.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      }, this.#sessionId)
      await this.#conn.send('Emulation.setTimezoneOverride', { timezoneId: '' }, this.#sessionId)
      await this.#conn.send('Emulation.clearGeolocationOverride', {}, this.#sessionId)
      return { applied: ['cleared'] }
    }
    if (options.colorScheme !== undefined || options.reducedMotion !== undefined) {
      const features = []
      const media = []
      if (options.colorScheme === 'light' || options.colorScheme === 'dark') {
        features.push({ name: 'prefers-color-scheme', value: options.colorScheme })
        media.push(`color-scheme:${options.colorScheme}`)
      } else if (options.colorScheme === 'system') {
        media.push('color-scheme:system')
      }
      if (options.reducedMotion === 'reduce' || options.reducedMotion === 'no-preference') {
        features.push({ name: 'prefers-reduced-motion', value: options.reducedMotion })
        media.push(`reduced-motion:${options.reducedMotion}`)
      } else if (options.reducedMotion === 'system') {
        media.push('reduced-motion:system')
      }
      await this.#conn.send('Emulation.setEmulatedMedia', { features }, this.#sessionId)
      applied.push(...media)
    }
    if (options.mobile !== undefined || options.touch !== undefined) {
      const mobile = options.mobile === true
      const touch = options.touch === true || mobile
      await this.#conn.send('Emulation.setTouchEmulationEnabled', { enabled: touch }, this.#sessionId)
      await this.#conn.send('Emulation.setDeviceMetricsOverride', {
        width: this.#state.width,
        height: this.#state.height,
        deviceScaleFactor: 1,
        mobile,
      }, this.#sessionId)
      applied.push(`mobile:${mobile},touch:${touch}`)
    }
    if (options.cpuThrottlingRate !== undefined) {
      const rate = clamp(options.cpuThrottlingRate, 1, 20)
      await this.#conn.send('Emulation.setCPUThrottlingRate', { rate }, this.#sessionId)
      applied.push(`cpu:${rate}x`)
    }
    if (options.network !== undefined) {
      const preset = NETWORK_PRESETS[String(options.network)]
      if (preset === undefined) throw new CdpError(`unknown network profile "${options.network}"; use offline, slow3g, fast3g, or none`)
      await this.#conn.send('Network.emulateNetworkConditions', preset, this.#sessionId)
      applied.push(`network:${options.network}`)
    }
    if (options.timezone !== undefined) {
      const timezone = String(options.timezone).trim()
      await this.#conn.send('Emulation.setTimezoneOverride', { timezoneId: timezone }, this.#sessionId)
      applied.push(`timezone:${timezone === '' ? 'system' : timezone}`)
    }
    if (options.geolocation !== undefined) {
      const point = parseGeolocation(options.geolocation)
      await this.#conn.send('Emulation.setGeolocationOverride', { ...point, accuracy: 1 }, this.#sessionId)
      applied.push(`geolocation:${point.latitude},${point.longitude}`)
    }
    return { applied }
  }

  /**
   * Read lightweight page performance and Chrome runtime metrics.
   * @returns {Promise<object>}
   */
  async performance() {
    await this.ensureStarted()
    this.#assertNoDialog()
    await this.#installPerformanceObserver(this.#sessionId)
    const { result } = await this.#conn.send('Runtime.evaluate', {
      expression: String.raw`(() => {
        const state = window.__dshPerfState || null;
        const navigation = performance.getEntriesByType('navigation')[0] || null;
        const paint = performance.getEntriesByType('paint') || [];
        const supported = {
          lcp: !!(state && state.lcpSupported),
          cls: !!(state && state.clsSupported),
          inp: !!(state && state.eventSupported),
          longTask: !!(state && state.longTaskSupported),
        };
        return {
          url: location.href,
          title: document.title,
          lcp: supported.lcp ? (state.lcp ?? null) : null,
          cls: supported.cls ? (state.cls ?? 0) : null,
          inp: supported.inp ? (state.inp ?? null) : null,
          longTaskCount: supported.longTask ? state.longTaskCount : null,
          longTaskMs: supported.longTask ? state.longTaskMs : null,
          supported,
          paint: Object.fromEntries(paint.map((entry) => [entry.name, entry.startTime])),
          resources: performance.getEntriesByType('resource').length,
          navigation: navigation === null ? null : {
            ttfb: navigation.responseStart,
            domContentLoaded: navigation.domContentLoadedEventEnd,
            load: navigation.loadEventEnd,
            duration: navigation.duration,
          },
        };
      })()`,
      returnByValue: true,
    }, this.#sessionId)
    const page = result?.value ?? {}
    let runtime = {}
    try {
      await this.#conn.send('Performance.enable', {}, this.#sessionId)
      const { metrics = [] } = await this.#conn.send('Performance.getMetrics', {}, this.#sessionId)
      const wanted = new Set(['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents', 'Frames', 'LayoutCount', 'RecalcStyleCount', 'TaskDuration', 'ScriptDuration'])
      runtime = Object.fromEntries(metrics.filter((metric) => wanted.has(metric.name)).map((metric) => [metric.name, metric.value]))
    } catch {
      // Metrics are best-effort; the page timings still answer.
    }
    const supported = page.supported ?? { lcp: false, cls: false, inp: false, longTask: false }
    return {
      url: page.url ?? this.#state.url,
      title: page.title ?? this.#state.title,
      lcp: supported.lcp ? (page.lcp ?? null) : null,
      cls: supported.cls ? (page.cls ?? 0) : null,
      inp: supported.inp ? (page.inp ?? null) : null,
      longTaskCount: supported.longTask ? (page.longTaskCount ?? 0) : null,
      longTaskMs: supported.longTask ? (page.longTaskMs ?? 0) : null,
      supported,
      paint: page.paint ?? {},
      resources: page.resources ?? 0,
      navigation: page.navigation ?? null,
      runtime,
    }
  }

  /**
   * Install the PerformanceObserver collector in the current page and future
   * documents. Called once per CDP page session.
   * @param {string} sessionId - page session.
   * @returns {Promise<void>}
   */
  async #installPerformanceObserver(sessionId) {
    if (this.#conn === undefined || sessionId === undefined) return
    const key = `${this.#conn.url}\u0000${sessionId}`
    if (this.#perfInjectedSessions.has(key)) return
    this.#perfInjectedSessions.add(key)
    await this.#conn.send('Page.addScriptToEvaluateOnNewDocument', { source: PERF_OBSERVER_SOURCE }, sessionId).catch(() => {})
    await this.#conn.send('Runtime.evaluate', {
      expression: PERF_OBSERVER_SOURCE,
      returnByValue: true,
    }, sessionId).catch(() => {})
  }

  /**
   * Draw a temporary box around one element so a human can see the target.
   * @param {{ target?: string, ref?: string, selector?: string }} target - the element.
   * @param {{ durationMs?: number, color?: string, label?: string }} [options] - how long it stays, its color and caption.
   * @returns {Promise<{ label: string, box: { x: number, y: number, width: number, height: number }, persisted: boolean }>}
   */
  async highlight(target = {}, options = {}) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const objectId = await this.#resolveObject(target, { includeHidden: true })
    const color = typeof options.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(options.color)
      ? options.color
      : '#ff9f1a'
    const durationMs = clamp(options.durationMs ?? 2500, 0, 60000)
    const label = cleanText(typeof options.label === 'string' && options.label !== ''
      ? options.label
      : describeTarget(parseTarget(target))).slice(0, 80)
    const { result, exceptionDetails } = await this.#conn.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: String.raw`function (color, label, durationMs) {
        const previous = document.getElementById('__dsh_bc_highlight__');
        if (previous) previous.remove();
        const rect = this.getBoundingClientRect();
        const box = document.createElement('div');
        box.id = '__dsh_bc_highlight__';
        box.style.cssText = [
          'position:fixed',
          'left:' + Math.max(0, rect.left) + 'px',
          'top:' + Math.max(0, rect.top) + 'px',
          'width:' + Math.max(1, rect.width) + 'px',
          'height:' + Math.max(1, rect.height) + 'px',
          'border:2px solid ' + color,
          'border-radius:3px',
          'box-shadow:0 0 0 2px rgba(0,0,0,.35), inset 0 0 0 1px rgba(255,255,255,.55)',
          'pointer-events:none',
          'z-index:2147483647',
          'box-sizing:border-box',
          'transition:opacity 120ms linear',
        ].join(';');
        const caption = document.createElement('div');
        caption.textContent = label;
        caption.style.cssText = [
          'position:fixed',
          'left:' + Math.max(0, rect.left) + 'px',
          'top:' + Math.max(0, rect.top - 24) + 'px',
          'max-width:420px',
          'padding:2px 6px',
          'border-radius:3px',
          'background:' + color,
          'color:#111',
          'font:11px/1.4 system-ui,sans-serif',
          'white-space:nowrap',
          'overflow:hidden',
          'text-overflow:ellipsis',
          'pointer-events:none',
          'z-index:2147483647',
        ].join(';');
        document.documentElement.appendChild(box);
        document.documentElement.appendChild(caption);
        if (durationMs > 0) {
          setTimeout(() => { box.remove(); caption.remove(); }, durationMs);
        }
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      }`,
      arguments: [{ value: color }, { value: label }, { value: durationMs }],
      returnByValue: true,
    }, this.#sessionId)
    if (exceptionDetails !== undefined) throw new CdpError('the element could not be highlighted')
    const box = result?.value ?? { x: 0, y: 0, width: 0, height: 0 }
    return { label, box, persisted: durationMs === 0 }
  }

  /** Remove a highlight box left by `highlight` with durationMs 0. */
  async clearHighlight() {
    await this.ensureStarted()
    await this.#conn.send('Runtime.evaluate', {
      expression: "document.querySelectorAll('#__dsh_bc_highlight__').forEach((node) => node.remove())",
    }, this.#sessionId)
  }

  /**
   * Add a network route served from the plugin instead of the network.
   * @param {{ urlPattern?: string, method?: string, status?: number, headers?: object, body?: string|object, contentType?: string, delayMs?: number, errorReason?: string }} [options] - the response.
   * @returns {Promise<object>} the stored route summary.
   */
  async addRoute(options = {}) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const pattern = typeof options.urlPattern === 'string' && options.urlPattern !== '' ? options.urlPattern : '*'
    const method = typeof options.method === 'string' && options.method !== '' ? options.method.toUpperCase() : null
    const headers = normalizeRouteHeaders(options.headers, options.contentType, options.body)
    const body = typeof options.body === 'string'
      ? options.body
      : options.body === undefined || options.body === null
        ? ''
        : JSON.stringify(options.body)
    const route = {
      id: `route-${++this.#routeSeq}`,
      pattern,
      method,
      status: clamp(options.status ?? 200, 100, 599),
      headers,
      body,
      delayMs: clamp(options.delayMs ?? 0, 0, 30000),
      errorReason: typeof options.errorReason === 'string' && options.errorReason !== '' ? options.errorReason : null,
      createdAt: Date.now(),
    }
    this.#routes.set(route.id, route)
    await this.#ensureFetch(this.#conn, this.#sessionId)
    return this.#describeRoute(route)
  }

  /** List network routes, oldest first. */
  listRoutes() {
    return [...this.#routes.values()].map((route) => this.#describeRoute(route))
  }

  /**
   * Remove one route or all routes.
   * @param {string} [id] - route id; omit or pass `all` to clear every route.
   * @returns {Promise<{ removed: number }>}
   */
  async removeRoute(id) {
    await this.ensureStarted()
    let removed = 0
    if (id === undefined || id === 'all') {
      removed = this.#routes.size
      this.#routes.clear()
    } else if (this.#routes.delete(id)) {
      removed = 1
    }
    if (this.#routes.size === 0) await this.#disableFetch()
    return { removed }
  }

  /**
   * Read cookies for the current page or a list of URLs.
   * @param {{ urls?: string[] }} [options] - URLs to query; defaults to the current page.
   * @returns {Promise<Array<object>>} cookies.
   */
  async listCookies(options = {}) {
    await this.ensureStarted()
    const cookies = await this.#rawCookies(options)
    return cookies.map((cookie) => ({
      name: cookie.name,
      value: this.#redactText(cookie.value),
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly === true,
      secure: cookie.secure === true,
      sameSite: cookie.sameSite ?? '',
      session: cookie.session === true,
    }))
  }

  /**
   * Read cookies without redaction, for a local storage-state file.
   * @param {{ urls?: string[] }} [options] - URLs to query; defaults to the current page.
   * @returns {Promise<Array<object>>}
   */
  async #rawCookies(options = {}) {
    const urls = Array.isArray(options.urls) && options.urls.length > 0
      ? options.urls.filter((url) => typeof url === 'string' && /^https?:/u.test(url))
      : (/^https?:/u.test(this.#state.url) ? [this.#state.url] : [])
    if (urls.length === 0) {
      const { cookies = [] } = await this.#conn.send('Network.getAllCookies', {}, this.#sessionId)
      return cookies
    }
    const { cookies = [] } = await this.#conn.send('Network.getCookies', { urls }, this.#sessionId)
    return cookies
  }

  /**
   * Set one cookie through the network domain.
   * @param {{ name: string, value: string, url?: string, domain?: string, path?: string, httpOnly?: boolean, secure?: boolean, sameSite?: string, expires?: number }} cookie - the cookie.
   * @returns {Promise<{ ok: boolean }>}
   */
  async setCookie(cookie = {}) {
    await this.ensureStarted()
    if (typeof cookie.name !== 'string' || cookie.name === '') throw new CdpError('setCookie needs a cookie name')
    if (typeof cookie.value !== 'string') throw new CdpError('setCookie needs a cookie value string')
    const { success } = await this.#conn.send('Network.setCookie', {
      name: cookie.name,
      value: cookie.value,
      ...(typeof cookie.url === 'string' && cookie.url !== '' ? { url: cookie.url } : { url: this.#state.url }),
      ...(typeof cookie.domain === 'string' ? { domain: cookie.domain } : {}),
      ...(typeof cookie.path === 'string' ? { path: cookie.path } : {}),
      ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly === true } : {}),
      ...(cookie.secure !== undefined ? { secure: cookie.secure === true } : {}),
      ...(typeof cookie.sameSite === 'string' ? { sameSite: cookie.sameSite } : {}),
      ...(Number.isFinite(cookie.expires) ? { expires: cookie.expires } : {}),
    }, this.#sessionId)
    return { ok: success === true }
  }

  /**
   * Delete one cookie or clear all cookies.
   * @param {{ name?: string, url?: string, domain?: string, path?: string, all?: boolean }} [options] - which cookies.
   * @returns {Promise<{ cleared: boolean }>}
   */
  async deleteCookie(options = {}) {
    await this.ensureStarted()
    if (options.all === true) {
      await this.#conn.send('Network.clearBrowserCookies', {}, this.#sessionId)
      return { cleared: true }
    }
    if (typeof options.name !== 'string' || options.name === '') throw new CdpError('deleteCookie needs a name or all: true')
    const hasDomain = typeof options.domain === 'string' && options.domain !== ''
    await this.#conn.send('Network.deleteCookies', {
      name: options.name,
      ...(typeof options.url === 'string' && options.url !== ''
        ? { url: options.url }
        : (hasDomain ? {} : { url: this.#state.url })),
      ...(hasDomain ? { domain: options.domain } : {}),
      ...(typeof options.path === 'string' ? { path: options.path } : {}),
    }, this.#sessionId)
    return { cleared: true }
  }

  /**
   * Read or change localStorage/sessionStorage.
   * @param {'list'|'get'|'set'|'remove'|'clear'} [action] - the operation.
   * @param {{ type?: 'local'|'session', key?: string, value?: string }} [options] - storage details.
   * @returns {Promise<object>}
   */
  async storage(action = 'list', options = {}) {
    await this.ensureStarted()
    this.#assertNoDialog()
    const type = options.type === 'session' ? 'sessionStorage' : 'localStorage'
    if (action === 'clear') {
      await this.#conn.send('Runtime.evaluate', { expression: `${type}.clear()` }, this.#sessionId)
      return { type, cleared: true }
    }
    if (action === 'set') {
      if (typeof options.key !== 'string' || options.key === '') throw new CdpError('storage set needs a key')
      const value = String(options.value ?? '')
      await this.#conn.send('Runtime.evaluate', {
        expression: `${type}.setItem(${JSON.stringify(options.key)}, ${JSON.stringify(value)})`,
      }, this.#sessionId)
      return { type, key: options.key, value: this.#redactText(value) }
    }
    if (action === 'remove') {
      if (typeof options.key !== 'string' || options.key === '') throw new CdpError('storage remove needs a key')
      await this.#conn.send('Runtime.evaluate', {
        expression: `${type}.removeItem(${JSON.stringify(options.key)})`,
      }, this.#sessionId)
      return { type, key: options.key, removed: true }
    }
    if (action === 'get') {
      if (typeof options.key !== 'string' || options.key === '') throw new CdpError('storage get needs a key')
      const { result } = await this.#conn.send('Runtime.evaluate', {
        expression: `${type}.getItem(${JSON.stringify(options.key)})`,
        returnByValue: true,
      }, this.#sessionId)
      return { type, key: options.key, value: this.#redactText(String(result?.value ?? '')) }
    }
    const { result } = await this.#conn.send('Runtime.evaluate', {
      expression: `(() => { const store = ${type}; const out = []; for (let i = 0; i < store.length && out.length < 200; i += 1) { const key = store.key(i); out.push({ key, value: store.getItem(key) }); } return out; })()`,
      returnByValue: true,
    }, this.#sessionId)
    const entries = Array.isArray(result?.value) ? result.value : []
    return {
      type,
      entries: entries.map((entry) => ({ key: String(entry.key), value: this.#redactText(String(entry.value ?? '')) })),
    }
  }

  /**
   * Export cookies and current-origin localStorage to a local JSON file.
   * The file is private to the user and never returned through the tool.
   * @param {{ path?: string, urls?: string[] }} [options] - output path and cookie URLs.
   * @returns {Promise<{ path: string, cookies: number, origins: number }>}
   */
  async exportStorageState(options = {}) {
    await this.ensureStarted()
    const { cookies = [] } = await this.#conn.send('Network.getAllCookies', {}, this.#sessionId)
    const origin = this.#currentOrigin()
    const local = origin === null ? [] : await this.#readLocalStorage()
    const state = {
      version: 1,
      exportedAt: new Date().toISOString(),
      url: this.#state.url,
      cookies,
      origins: origin === null || local.length === 0 ? [] : [{ origin, localStorage: local }],
    }
    const target = typeof options.path === 'string' && options.path !== ''
      ? path.resolve(options.path)
      : path.join(this.#storageStateDir, `state-${Date.now()}.json`)
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await fsp.writeFile(target, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    return { path: target, cookies: cookies.length, origins: state.origins.length }
  }

  /**
   * Import cookies and current-origin localStorage from a local JSON file.
   * @param {{ path: string, clear?: boolean }} options - input path and whether to replace existing state.
   * @returns {Promise<{ path: string, cookies: number, localKeys: number, origin: string | null }>}
   */
  async importStorageState(options = {}) {
    if (typeof options.path !== 'string' || options.path === '') {
      throw new CdpError('importStorageState needs a path to a storage-state JSON file')
    }
    await this.ensureStarted()
    const target = path.resolve(options.path)
    let parsed
    try {
      parsed = JSON.parse(await fsp.readFile(target, 'utf8'))
    } catch (error) {
      throw new CdpError(`could not read storage state ${target}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.cookies)) {
      throw new CdpError(`storage state ${target} is not a valid { cookies, origins } file`)
    }
    if (options.clear === true) await this.#conn.send('Network.clearBrowserCookies', {}, this.#sessionId)
    let imported = 0
    for (const cookie of parsed.cookies) {
      if (cookie === null || typeof cookie !== 'object' || typeof cookie.name !== 'string') continue
      const result = await this.#conn.send('Network.setCookie', {
        name: cookie.name,
        value: String(cookie.value ?? ''),
        ...(typeof cookie.domain === 'string' && cookie.domain !== ''
          ? { domain: cookie.domain, path: typeof cookie.path === 'string' ? cookie.path : '/' }
          : { url: this.#state.url }),
        ...(cookie.httpOnly === true ? { httpOnly: true } : {}),
        ...(cookie.secure === true ? { secure: true } : {}),
        ...(typeof cookie.sameSite === 'string' && cookie.sameSite !== '' ? { sameSite: cookie.sameSite } : {}),
        ...(Number.isFinite(cookie.expires) && cookie.expires > 0 ? { expires: cookie.expires } : {}),
      }, this.#sessionId)
      if (result.success === true) imported += 1
    }
    const origin = this.#currentOrigin()
    const entry = origin === null || !Array.isArray(parsed.origins)
      ? null
      : parsed.origins.find((item) => item?.origin === origin && Array.isArray(item.localStorage)) ?? null
    let localKeys = 0
    if (entry !== null) {
      if (options.clear === true) {
        await this.#conn.send('Runtime.evaluate', { expression: 'localStorage.clear()' }, this.#sessionId)
      }
      for (const item of entry.localStorage) {
        if (item === null || typeof item !== 'object' || typeof item.key !== 'string') continue
        await this.#conn.send('Runtime.evaluate', {
          expression: `localStorage.setItem(${JSON.stringify(item.key)}, ${JSON.stringify(String(item.value ?? ''))})`,
        }, this.#sessionId)
        localKeys += 1
      }
    }
    return { path: target, cookies: imported, localKeys, origin }
  }

  #currentOrigin() {
    try {
      const url = new URL(this.#state.url)
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
    } catch {
      return null
    }
  }

  async #readLocalStorage() {
    const { result } = await this.#conn.send('Runtime.evaluate', {
      expression: '(() => { const out = []; for (let i = 0; i < localStorage.length && out.length < 500; i += 1) { const key = localStorage.key(i); out.push({ key, value: localStorage.getItem(key) }); } return out; })()',
      returnByValue: true,
    }, this.#sessionId)
    return Array.isArray(result?.value) ? result.value : []
  }

  /** List downloads observed since the browser started. */
  listDownloads() {
    return [...this.#downloads.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((entry) => ({ ...entry }))
  }

  /**
   * Wait for one download to finish, or for the next finished download.
   * @param {{ guid?: string, timeoutMs?: number }} [options] - which download and how long.
   * @returns {Promise<object>} the download record.
   */
  async waitForDownload(options = {}) {
    await this.ensureStarted()
    const timeoutMs = clamp(options.timeoutMs ?? 30000, 1000, 120000)
    const guid = typeof options.guid === 'string' && options.guid !== '' ? options.guid : null
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const entry = guid === null
        ? [...this.#downloads.values()].reverse().find((item) => item.state === 'completed' || item.state === 'canceled')
        : this.#downloads.get(guid)
      if (entry !== undefined && (entry.state === 'completed' || entry.state === 'canceled')) return { ...entry }
      if (Date.now() >= deadline) {
        throw new CdpError(`timed out after ${timeoutMs}ms waiting for a download`);
      }
      await delay(150)
    }
  }

  /**
   * Replace configured secrets in free text; used by console/network output.
   * @param {string} text - the text to scrub.
   * @returns {string} scrubbed text.
   */
  redact(text) {
    return this.#redactText(text)
  }

  /**
   * Resolve a configured secret for typing, enforcing its domain allowlist.
   * @param {string} name - configured secret name.
   * @returns {string} the raw value.
   */
  secretValue(name) {
    const label = typeof name === 'string' ? name.trim() : ''
    const secret = this.#secrets.find((item) => item.name === label)
    if (secret === undefined) throw new CdpError(`unknown secret "${label}"; configure it in the browser-cockpit secrets option`)
    if (secret.domains.length > 0) {
      let host = ''
      try {
        host = new URL(this.#state.url).hostname.toLowerCase()
      } catch {
        host = ''
      }
      if (host === '' || !secret.domains.some((domain) => hostMatchesDomain(host, domain))) {
        throw new CdpError(`secret "${label}" is not allowed on ${host === '' ? 'the current page' : host}`)
      }
    }
    return secret.value
  }

  #describeRoute(route) {
    return {
      id: route.id,
      urlPattern: route.pattern,
      method: route.method,
      status: route.status,
      headers: { ...route.headers },
      bodyBytes: Buffer.byteLength(route.body),
      delayMs: route.delayMs,
      errorReason: route.errorReason,
    }
  }

  #redactText(value) {
    let text = String(value ?? '')
    for (const secret of this.#secrets) {
      if (secret.value === '' || !text.includes(secret.value)) continue
      text = text.split(secret.value).join('[redacted]')
    }
    return text
  }

  /**
   * Read recent console messages, page errors, and failed requests.
   * @param {{ limit?: number }} [options] - bounded tail size.
   * @returns {{ entries: Array<{ level: string, text: string, url: string, seq: number }>, total: number, errorCount: number }}
   */
  readConsole(options = {}) {
    const limit = clamp(options.limit ?? 40, 1, 200)
    return {
      entries: this.#console.slice(-limit).map((entry) => ({ ...entry })),
      total: this.#console.length,
      errorCount: this.#console.filter((entry) => entry.level === 'error').length,
    }
  }

  /**
   * List requests observed on the current page, newest first.
   * @param {{ limit?: number, url?: string, method?: string, status?: number, type?: string, failedOnly?: boolean }} [options] - filters.
   * @returns {{ total: number, matched: number, entries: Array<object> }}
   */
  readNetwork(options = {}) {
    const limit = clamp(options.limit ?? 50, 1, 200)
    const url = typeof options.url === 'string' && options.url !== '' ? options.url.toLowerCase() : undefined
    const method = typeof options.method === 'string' && options.method !== '' ? options.method.toUpperCase() : undefined
    const type = typeof options.type === 'string' && options.type !== '' ? options.type.toLowerCase() : undefined
    const status = Number.isFinite(options.status) ? Number(options.status) : undefined
    const matched = [...this.#network.values()].reverse().filter((entry) => {
      if (url !== undefined && !entry.url.toLowerCase().includes(url)) return false
      if (method !== undefined && entry.method.toUpperCase() !== method) return false
      if (type !== undefined && entry.resourceType.toLowerCase() !== type) return false
      if (status !== undefined && entry.status !== status) return false
      if (options.failedOnly === true && entry.failed !== true) return false
      return true
    })
    return {
      total: this.#network.size,
      matched: matched.length,
      entries: matched.slice(0, limit).map((entry) => ({
        ...publicNetworkEntry(entry),
        url: this.#redactText(entry.url),
      })),
    }
  }

  /**
   * Read one request with redacted headers and, optionally, its response body.
   * @param {string} requestId - full id or a unique suffix from `readNetwork`.
   * @param {{ includeBody?: boolean, bodyLimit?: number }} [options] - body controls.
   * @returns {Promise<object>}
   */
  async networkDetail(requestId, options = {}) {
    await this.ensureStarted()
    const entry = this.#findNetworkRequest(requestId)
    const bodyLimit = clamp(options.bodyLimit ?? 4096, 256, 32000)
    const detail = {
      ...publicNetworkEntry(entry),
      requestHeaders: redactHeaders(entry.requestHeaders),
      responseHeaders: redactHeaders(entry.responseHeaders),
    }
    if (options.includeBody === true) {
      detail.body = await this.#readResponseBody(entry.requestId, bodyLimit)
    }
    return detail
  }

  /** Find one request by full id or unique suffix. */
  #findNetworkRequest(requestId) {
    const key = String(requestId ?? '').trim()
    if (key === '') throw new CdpError('browser_network detail needs a requestId from action list')
    const direct = this.#network.get(key)
    if (direct !== undefined) return direct
    const matches = [...this.#network.values()].filter((entry) => entry.requestId.endsWith(key))
    if (matches.length === 1) return matches[0]
    if (matches.length === 0) throw new CdpError(`no request matches "${key}"; call browser_network action list`)
    throw new CdpError(`"${key}" matches ${matches.length} requests; use a longer requestId`)
  }

  async #readResponseBody(requestId, limit) {
    try {
      const { body, base64Encoded } = await this.#conn.send('Network.getResponseBody', { requestId }, this.#sessionId)
      const buffer = Buffer.from(body, base64Encoded === true ? 'base64' : 'utf8')
      const text = buffer.toString('utf8')
      return {
        text: this.#redactText(text.slice(0, limit)),
        bytes: buffer.length,
        truncated: text.length > limit,
        base64Encoded: base64Encoded === true,
      }
    } catch (error) {
      return { unavailable: true, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Keep one screenshot as a file the human or `present` can open.
   * @param {Buffer} buffer - PNG bytes.
   * @returns {Promise<string | null>} absolute path, or null when writing failed.
   */
  async saveScreenshot(buffer) {
    try {
      const directory = ensureDirectory(path.join(os.tmpdir(), 'dsh-browser-control'))
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
      const file = path.join(directory, `shot-${stamp}.png`)
      await fsp.writeFile(file, buffer)
      await pruneScreenshots(directory)
      return file
    } catch {
      return null
    }
  }

  /** Close the browser, keeping the session reusable for a later launch. */
  async close() {
    if (this.#disposed) return
    await this.#teardown()
  }

  #touch() {
    if (this.#idleTimeoutMs <= 0) return
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined
      if (this.#disposed || this.#dialog !== null) return
      if (this.#state.phase !== 'running') return
      void this.close().catch(() => { /* the browser may already be gone */ })
    }, this.#idleTimeoutMs)
    this.#idleTimer.unref?.()
  }

  async #configureDownloads(connection, contextId) {
    const configured = typeof this.#options.downloadDir === 'string' ? this.#options.downloadDir.trim() : ''
    const directory = ensureDirectory(
      configured !== ''
        ? configured
        : path.join(os.homedir(), '.dsh', 'browser-control', 'downloads'),
    )
    this.#downloadPath = directory
    try {
      await connection.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: directory,
        eventsEnabled: true,
        ...(typeof contextId === 'string' ? { browserContextId: contextId } : {}),
      })
    } catch {
      // Older Chrome builds may not support the Browser domain; downloads remain disabled.
    }
  }

  async #ensureFetch(connection, sessionId) {
    if (this.#fetchEnabled) return
    try {
      await connection.send('Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      }, sessionId)
      this.#fetchEnabled = true
    } catch {
      // Mocking is best-effort; a navigation still works without it.
    }
  }

  async #disableFetch() {
    if (!this.#fetchEnabled) return
    this.#fetchEnabled = false
    try {
      await this.#conn.send('Fetch.disable', {}, this.#sessionId)
    } catch {
      // The page may already be gone.
    }
  }

  async #handleFetch(params) {
    const requestId = params?.requestId
    if (typeof requestId !== 'string') return
    const request = params.request ?? {}
    const url = typeof request.url === 'string' ? request.url : ''
    const method = typeof request.method === 'string' ? request.method.toUpperCase() : 'GET'
    const route = [...this.#routes.values()].find((candidate) => (
      (candidate.method === null || candidate.method === method)
      && routePatternMatches(candidate.pattern, url)
    ))
    try {
      if (route === undefined) {
        await this.#conn.send('Fetch.continueRequest', { requestId }, this.#sessionId)
        return
      }
      if (route.delayMs > 0) await delay(route.delayMs)
      if (route.errorReason !== null) {
        await this.#conn.send('Fetch.failRequest', {
          requestId,
          errorReason: route.errorReason,
        }, this.#sessionId)
        return
      }
      const responseHeaders = Object.entries(route.headers).map(([name, value]) => ({ name, value: String(value) }))
      await this.#conn.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: route.status,
        responseHeaders,
        body: Buffer.from(route.body, 'utf8').toString('base64'),
      }, this.#sessionId)
    } catch {
      // A route can be removed while its request is paused; never leave the page hanging.
      await this.#conn.send('Fetch.continueRequest', { requestId }, this.#sessionId).catch(() => { /* gone */ })
    }
  }

  /** Close the browser and reject later commands. */
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    await this.#teardown()
  }

  async #launch() {
    this.#state.phase = 'starting'
    this.#crashed = false
    this.#state.error = null
    this.#sessionTabs.clear()
    this.#sessionCache.clear()
    this.#contexts.clear()
    this.#activeSessionId = null
    this.#console = []
    this.#requests.clear()
    this.#network.clear()
    this.#refs.clear()
    this.#fetchEnabled = false
    try {
      const browserPath = resolveBrowserPath(this.#options.browserPath)
      if (browserPath === undefined) {
        throw new CdpError('no Chrome or Edge executable was found; install one or set browserPath in the plugin configuration')
      }
      const configuredProfile = typeof this.#options.profileDir === 'string' ? this.#options.profileDir.trim() : ''
      const environmentProfile = typeof process.env.DSH_BROWSER_PROFILE === 'string' ? process.env.DSH_BROWSER_PROFILE.trim() : ''
      const profileDir = ensureDirectory(
        configuredProfile !== ''
          ? configuredProfile
          : environmentProfile !== ''
            ? environmentProfile
            : path.join(os.homedir(), '.dsh', 'browser-control', 'profile'),
      )
      const activePortFile = path.join(profileDir, 'DevToolsActivePort')
      this.#activePortFile = activePortFile
      // A previous Host process may have exited without closing its browser. If
      // that browser still answers on the port it recorded, adopt it instead of
      // spawning a second Chrome against the same locked profile.
      if (await this.#tryAdopt(activePortFile)) return
      await fsp.rm(activePortFile, { force: true })
      const args = [
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--mute-audio',
        '--disable-background-networking',
        '--disable-backgrounding-occluded-windows',
        '--disable-features=Translate,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion',
        `--window-size=${this.#options.width},${this.#options.height}`,
        ...this.#options.headless ? ['--headless=new'] : [],
        'about:blank',
      ]
      const child = spawn(browserPath, args, { stdio: 'ignore', windowsHide: true })
      this.#child = child
      this.#closing = false
      // A bad `browserPath`, or a binary the OS refuses to run, reports through
      // the child's 'error' event; race it against the port file so launch fails fast.
      let rejectSpawn
      const spawnFailure = new Promise((_, reject) => { rejectSpawn = reject })
      const onSpawnError = (error) => {
        rejectSpawn(new CdpError(`cannot launch the browser: ${error.message}`, { cause: error }))
      }
      child.once('error', onSpawnError)
      child.once('exit', () => {
        if (this.#closing) return
        this.#conn?.close()
        this.#conn = undefined
        this.#sessionId = undefined
        this.#state.phase = 'stopped'
      })
      let portInfo
      try {
        portInfo = await Promise.race([waitForActivePort(activePortFile, child), spawnFailure])
      } finally {
        child.off('error', onSpawnError)
      }
      const { port, wsPath } = portInfo
      const connection = await CdpConnection.open(`ws://127.0.0.1:${port}${wsPath}`, {
        timeoutMs: this.#options.timeoutMs,
      })
      this.#conn = connection
      await this.#attachPage(connection)
      await this.#enableTargetDiscovery(connection)
      this.#state.phase = 'running'
      this.#state.startedAt = Date.now()
      this.#state.url = 'about:blank'
      this.#state.title = 'about:blank'
      this.#touch()
    } catch (error) {
      this.#state.phase = 'failed'
      this.#state.error = error instanceof Error ? error.message : String(error)
      this.#closing = true
      try { this.#child?.kill() } catch { /* already gone */ }
      this.#child = undefined
      this.#conn?.close()
      this.#conn = undefined
      if (this.#activePortFile !== undefined) {
        try { await fsp.rm(this.#activePortFile, { force: true }) } catch { /* best effort */ }
      }
      if (error instanceof CdpError) throw error
      throw new CdpError(error instanceof Error ? error.message : String(error), { cause: error })
    }
  }

  /** Reconnect to the browser that still owns the profile and reattach its page. */
  async #reconnectPage() {
    if (this.#activePortFile === undefined) return false
    let port
    let wsPath
    try {
      const text = await fsp.readFile(this.#activePortFile, 'utf8')
      const [portLine, pathLine] = text.trim().split(/\r?\n/u)
      port = Number(portLine)
      wsPath = typeof pathLine === 'string' ? pathLine.trim() : ''
    } catch {
      return false
    }
    if (!Number.isInteger(port) || port <= 0 || !wsPath.startsWith('/')) return false
    let connection
    try {
      connection = await CdpConnection.open(`ws://127.0.0.1:${port}${wsPath}`, {
        timeoutMs: this.#options.timeoutMs,
        connectTimeoutMs: 2500,
      })
      let targetId = this.#targetId
      let sessionId
      if (targetId !== undefined) {
        try {
          const attached = await connection.send('Target.attachToTarget', { targetId, flatten: true })
          sessionId = attached.sessionId
        } catch {
          targetId = undefined
        }
      }
      if (sessionId === undefined) {
        const { targetInfos = [] } = await connection.send('Target.getTargets')
        const pages = targetInfos.filter((target) => target.type === 'page')
        const page = pages.find((target) => target.targetId === this.#targetId)
          ?? pages.find((target) => target.url !== 'about:blank')
          ?? pages[0]
        targetId = page?.targetId
        if (targetId === undefined) {
          const created = await connection.send('Target.createTarget', { url: 'about:blank' })
          targetId = created.targetId
        }
        const attached = await connection.send('Target.attachToTarget', { targetId, flatten: true })
        sessionId = attached.sessionId
      }
      if (this.#sessionId !== undefined) this.#forgetPage(this.#sessionId)
      this.#conn = connection
      this.#targetId = targetId
      this.#sessionId = sessionId
      this.#fetchEnabled = false
      await this.#initializePage(connection, sessionId)
      await this.#enableTargetDiscovery(connection)
      this.#state.phase = 'running'
      this.#state.error = null
      await this.#refreshIdentity()
      this.#touch()
      return true
    } catch {
      connection?.close()
      if (this.#conn === connection) this.#conn = undefined
      return false
    }
  }

  async #recoverPage() {
    this.#state.phase = 'starting'
    this.#state.error = null
    const connection = this.#conn
    if (connection === undefined || connection.closed) {
      this.#conn = undefined
      this.#sessionId = undefined
      this.#targetId = undefined
      this.#state.phase = 'stopped'
      await this.#launch()
      return
    }
    const previousTarget = this.#targetId
    const previousSession = this.#sessionId
    const activeRecord = this.#contextRecord(this.#activeSessionId)
    try {
      const createParams = { url: 'about:blank' }
      if (activeRecord !== null) createParams.browserContextId = activeRecord.contextId
      const { targetId } = await connection.send('Target.createTarget', createParams)
      const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true })
      this.#targetId = targetId
      this.#sessionId = sessionId
      if (this.#activeSessionId !== null) this.#sessionTabs.set(this.#activeSessionId, targetId)
      if (activeRecord !== null) {
        activeRecord.targetId = targetId
        activeRecord.cdpSessionId = sessionId
        activeRecord.phase = 'running'
        activeRecord.url = 'about:blank'
        activeRecord.title = ''
        activeRecord.lastActivityAt = Date.now()
      }
      this.#refs.clear()
      this.#console = []
      this.#consoleKeys.clear()
      this.#requests.clear()
      this.#network.clear()
      this.#networkActivityAt = 0
      this.#fetchEnabled = false
      this.#dialog = null
      if (previousSession !== undefined && previousSession !== sessionId) {
        this.#forgetPage(previousSession)
        connection.send('Target.detachFromTarget', { sessionId: previousSession }).catch(() => { /* the crashed session is gone */ })
      }
      if (previousTarget !== undefined && previousTarget !== targetId) {
        connection.send('Target.closeTarget', { targetId: previousTarget }).catch(() => { /* the crashed target may already be gone */ })
      }
      await this.#initializePage(connection, sessionId)
      this.#state.phase = 'running'
      this.#state.url = 'about:blank'
      this.#state.title = 'about:blank'
      await this.#refreshIdentity()
      this.#touch()
    } catch {
      this.#closing = true
      try { await this.#teardown() } catch { /* best effort */ }
      this.#closing = false
      this.#state.phase = 'stopped'
      await this.#launch()
    }
  }

  async #attachPage(connection) {
    const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true })
    this.#targetId = targetId
    this.#sessionId = sessionId
    await this.#initializePage(connection, sessionId)
  }

  /**
   * Adopt a browser left behind by a previous Host process.
   *
   * A Host restart can orphan the controlled Chrome: the process survives, the
   * profile stays locked, and a fresh launch dies with "profile in use". When
   * the profile still records a live debugging port, attach to that browser and
   * its current page instead of failing.
   * @param {string} activePortFile - the profile's `DevToolsActivePort` file.
   * @returns {Promise<boolean>} whether an existing browser was adopted.
   */
  async #tryAdopt(activePortFile) {
    let port
    let wsPath
    try {
      const text = await fsp.readFile(activePortFile, 'utf8')
      const [portLine, pathLine] = text.trim().split(/\r?\n/u)
      port = Number(portLine)
      wsPath = typeof pathLine === 'string' ? pathLine.trim() : ''
    } catch {
      return false
    }
    if (!Number.isInteger(port) || port <= 0 || !wsPath.startsWith('/')) return false
    let connection
    try {
      connection = await CdpConnection.open(`ws://127.0.0.1:${port}${wsPath}`, {
        timeoutMs: this.#options.timeoutMs,
        connectTimeoutMs: 2500,
      })
      const { targetInfos = [] } = await connection.send('Target.getTargets')
      const pages = targetInfos.filter((target) => target.type === 'page')
      // Chrome's startup about:blank is usually still open beside the page the
      // previous Host controlled; prefer the real page over that blank one.
      const page = pages.find((target) => typeof target.url === 'string' && target.url !== 'about:blank') ?? pages[0]
      let targetId = page?.targetId
      if (targetId === undefined) {
        const created = await connection.send('Target.createTarget', { url: 'about:blank' })
        targetId = created.targetId
      }
      const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true })
      this.#conn = connection
      this.#targetId = targetId
      this.#sessionId = sessionId
      await this.#initializePage(connection, sessionId)
      await this.#enableTargetDiscovery(connection)
      this.#state.phase = 'running'
      this.#state.error = null
      this.#state.startedAt = Date.now()
      await this.#refreshIdentity()
      this.#touch()
      return true
    } catch {
      connection?.close()
      if (this.#conn === connection) {
        this.#conn = undefined
        this.#sessionId = undefined
        this.#targetId = undefined
      }
      return false
    }
  }

  /**
   * Wire page events and enable the protocol domains for one attached page.
   * @param {CdpConnection} connection - the browser connection.
   * @param {string} sessionId - the page session.
   */
  async #initializePage(connection, sessionId) {
    const events = [
      'Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded',
      'Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed',
      'Page.frameNavigated', 'Page.loadEventFired', 'Page.javascriptDialogOpening', 'Page.javascriptDialogClosed',
      'Page.screencastFrame',
      'Inspector.targetCrashed', 'Fetch.requestPaused',
      'Browser.downloadWillBegin', 'Browser.downloadProgress',
    ]
    const existing = this.#initializedPages.get(sessionId)
    if (existing === undefined || existing.connection !== connection) {
      if (existing !== undefined) for (const off of existing.offs) off()
      const offs = events.map((method) => connection.on(method, (params, sid) => this.#handleEvent(method, params, sid)))
      this.#initializedPages.set(sessionId, { connection, offs })
      this.#consoleKeys.clear()
      // Enable each protocol domain once per page session. Re-enabling Log on a
      // context switch replays Chrome's buffered entries and duplicates the
      // console, so keep the enabled key across detach/reattach.
      const pageKey = `${connection.url}\u0000${sessionId}`
      if (!this.#enabledPages.has(pageKey)) {
        await connection.send('Page.enable', {}, sessionId)
        await connection.send('Runtime.enable', {}, sessionId)
        await connection.send('Log.enable', {}, sessionId)
        await connection.send('Network.enable', {}, sessionId)
        await connection.send('DOM.enable', {}, sessionId)
        this.#enabledPages.add(pageKey)
      }
      this.#networkActivityAt = Date.now()
    }
    await this.#installPerformanceObserver(sessionId)
    await this.#configureDownloads(connection, this.#recordForCdpSession(sessionId)?.contextId)
    if (this.#routes.size > 0) await this.#ensureFetch(connection, sessionId)
    await connection.send('Emulation.setDeviceMetricsOverride', {
      width: this.#options.width,
      height: this.#options.height,
      deviceScaleFactor: 1,
      mobile: this.#options.width < 640,
    }, sessionId)
    if (this.#screencastActive && this.#screencastRefs > 0 && connection === this.#conn) {
      await this.#beginScreencast().catch(() => {})
    }
  }

  /**
   * Remove the protocol listeners for a page session. Page sessions are unique
   * per attach, so this prevents listeners accumulating when tabs are churned.
   * @param {string} sessionId - page session.
   * @returns {void}
   */
  #forgetPage(sessionId) {
    const entry = this.#initializedPages.get(sessionId)
    if (entry !== undefined) {
      for (const off of entry.offs) off()
      this.#initializedPages.delete(sessionId)
    }
    for (const key of this.#perfInjectedSessions) {
      if (key.endsWith(`\u0000${sessionId}`)) this.#perfInjectedSessions.delete(key)
    }
    const ackTimer = this.#screencastAckTimers.get(sessionId)
    if (ackTimer !== undefined) {
      clearTimeout(ackTimer)
      this.#screencastAckTimers.delete(sessionId)
    }
  }

  /**
   * Watch for pages opened by the current page and follow them when configured.
   * @param {CdpConnection} connection - the browser connection.
   * @returns {Promise<void>}
   */
  async #enableTargetDiscovery(connection) {
    if (this.#discoveryConnection === connection) return
    this.#discoveryConnection = connection
    connection.on('Target.targetCreated', (params) => {
      const info = params?.targetInfo
      if (info === undefined || info.type !== 'page') return
      if (!this.#options.followNewTabs) return
      if (info.targetId === this.#targetId || info.openerId !== this.#targetId) return
      const targetId = info.targetId
      this.#switchChain = this.#switchChain
        .then(() => delay(250))
        .then(() => this.selectTab(targetId))
        .catch(() => { /* the tab may already be gone */ })
    })
    try {
      await connection.send('Target.setDiscoverTargets', { discover: true })
    } catch {
      // Listing still works through Target.getTargets; following a new tab is best-effort.
    }
  }

  /**
   * Acknowledge at most one screencast frame per 80ms per page. Chrome sends
   * a new frame only after an ack, so this caps the stream at roughly 12 fps
   * instead of letting a static page flood us at ~700 fps.
   * @param {CdpConnection} connection - browser connection.
   * @param {string} sessionId - page session.
   * @param {string} frameSessionId - id of the frame to acknowledge.
   * @returns {void}
   */
  #scheduleScreencastAck(connection, sessionId, frameSessionId) {
    if (this.#screencastAckTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.#screencastAckTimers.delete(sessionId)
      connection.send('Page.screencastFrameAck', { sessionId: frameSessionId }, sessionId).catch(() => {})
    }, 80)
    timer.unref?.()
    this.#screencastAckTimers.set(sessionId, timer)
  }

  #handleEvent(method, params, sessionId) {
    const record = this.#recordForCdpSession(sessionId)
    if (method === 'Page.screencastFrame') {
      const connection = this.#conn
      if (connection !== undefined && sessionId !== undefined && params.sessionId !== undefined) {
        this.#scheduleScreencastAck(connection, sessionId, params.sessionId)
      }
      if (typeof params.data === 'string') {
        const buffer = Buffer.from(params.data, 'base64')
        const metadata = params.metadata ?? {}
        if (record !== null) {
          record.frame = buffer
          record.frameAt = Date.now()
          record.lastActivityAt = record.frameAt
          for (const listener of record.screencast.listeners) {
            Promise.resolve().then(() => listener(buffer, metadata)).catch(() => {})
          }
        }
        if (sessionId === this.#sessionId && this.#screencastRefs > 0) {
          this.#screencastFrame = buffer
          this.#screencastAt = Date.now()
          this.#screencastMetadata = metadata
          for (const listener of this.#screencastListeners) {
            Promise.resolve().then(() => listener(buffer, this.#screencastMetadata)).catch(() => {})
          }
        }
      }
      return
    }
    if (record !== null && method === 'Page.frameNavigated') {
      const frame = params?.frame
      if (frame !== undefined) {
        const isMainFrame = typeof frame.parentId !== 'string'
        record.url = typeof frame.url === 'string' ? frame.url : record.url
        record.lastActivityAt = Date.now()
        // A new document starts a new error budget. Do not clear the ring when
        // an iframe navigates; that would hide the parent page's errors.
        if (isMainFrame) {
          record.console.length = 0
          if (record.sessionId === this.#activeSessionId) this.#console = record.console
        }
      }
    }
    if (record !== null && method === 'Page.loadEventFired') {
      record.phase = 'running'
      record.lastActivityAt = Date.now()
    }
    if (record !== null && method === 'Inspector.targetCrashed') {
      record.phase = 'crashed'
      record.error = 'the page crashed'
      record.lastActivityAt = Date.now()
    }
    // Console history is per conversation. Capture it for background pages
    // too; the old guard returned before this and made inactive cards show 0.
    if (record !== null && (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown' || method === 'Log.entryAdded')) {
      this.#pushRecordConsole(record, method, params)
      return
    }
    if (sessionId !== undefined && sessionId !== this.#sessionId) return
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const text = (params.args ?? []).map(serializeRemote).join(' ').slice(0, 2000)
        const level = params.type === 'error' ? 'error' : params.type === 'warning' ? 'warn' : 'log'
        const frame = params.stackTrace?.callFrames?.[0]
        this.#pushConsole(level, text, frame?.url, {
          line: frame === undefined ? null : (frame.lineNumber ?? 0) + 1,
          column: frame === undefined ? null : (frame.columnNumber ?? 0) + 1,
          stack: formatStack(params.stackTrace),
        })
        break
      }
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails ?? {}
        const description = details.exception?.description ?? details.text ?? 'uncaught exception'
        this.#pushConsole('error', String(description).slice(0, 2000), details.url, {
          line: Number.isInteger(details.lineNumber) ? details.lineNumber + 1 : null,
          column: Number.isInteger(details.columnNumber) ? details.columnNumber + 1 : null,
          stack: formatStack(details.stackTrace),
        })
        break
      }
      case 'Log.entryAdded': {
        const entry = params.entry ?? {}
        const level = entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warn' : 'log'
        this.#pushConsole(level, String(entry.text ?? '').slice(0, 2000), entry.url, {
          line: Number.isInteger(entry.lineNumber) ? entry.lineNumber + 1 : null,
          column: null,
          stack: formatStack(entry.stackTrace),
        })
        break
      }
      case 'Network.requestWillBeSent': {
        const requestId = params.requestId
        const request = params.request ?? {}
        const redirect = params.redirectResponse
        const previous = this.#network.get(requestId)
        if (previous === undefined) {
          this.#network.set(requestId, {
            requestId,
            url: typeof request.url === 'string' ? request.url : '',
            method: typeof request.method === 'string' ? request.method : 'GET',
            resourceType: typeof params.type === 'string' ? params.type : '',
            startedAt: Date.now(),
            endedAt: null,
            status: redirect?.status ?? null,
            statusText: redirect?.statusText ?? '',
            mimeType: redirect?.mimeType ?? '',
            encodedDataLength: redirect?.encodedDataLength ?? null,
            requestHeaders: request.headers ?? {},
            responseHeaders: redirect?.headers ?? {},
            failed: false,
            errorText: '',
            fromCache: redirect?.fromDiskCache === true || redirect?.fromMemoryCache === true,
          })
          if (this.#network.size > 300) {
            const oldest = this.#network.keys().next().value
            if (oldest !== undefined) this.#network.delete(oldest)
          }
        } else {
          previous.url = typeof request.url === 'string' ? request.url : previous.url
          previous.method = typeof request.method === 'string' ? request.method : previous.method
          previous.resourceType = typeof params.type === 'string' ? params.type : previous.resourceType
          if (redirect !== undefined) {
            previous.status = redirect.status ?? previous.status
            previous.statusText = redirect.statusText ?? previous.statusText
            previous.mimeType = redirect.mimeType ?? previous.mimeType
            previous.encodedDataLength = redirect.encodedDataLength ?? previous.encodedDataLength
            previous.responseHeaders = redirect.headers ?? previous.responseHeaders
          }
        }
        if (params.type !== 'WebSocket' && params.type !== 'EventSource') {
          this.#requests.set(requestId, request.url ?? '')
          this.#networkActivityAt = Date.now()
        }
        break
      }
      case 'Network.responseReceived': {
        this.#networkActivityAt = Date.now()
        const response = params.response ?? {}
        const entry = this.#network.get(params.requestId)
        if (entry !== undefined) {
          entry.status = response.status ?? entry.status
          entry.statusText = response.statusText ?? entry.statusText
          entry.mimeType = response.mimeType ?? entry.mimeType
          entry.responseHeaders = response.headers ?? entry.responseHeaders
          entry.resourceType = typeof params.type === 'string' ? params.type : entry.resourceType
          entry.fromCache = response.fromDiskCache === true || response.fromMemoryCache === true
        }
        const status = response.status ?? 0
        if (status >= 400) this.#pushConsole('warn', `HTTP ${status} ${response.url ?? ''}`, response.url)
        break
      }
      case 'Network.loadingFinished': {
        this.#requests.delete(params.requestId)
        const entry = this.#network.get(params.requestId)
        if (entry !== undefined) {
          entry.endedAt = Date.now()
          entry.encodedDataLength = params.encodedDataLength ?? entry.encodedDataLength
        }
        this.#networkActivityAt = Date.now()
        break
      }
      case 'Network.loadingFailed': {
        const url = this.#requests.get(params.requestId) ?? ''
        const entry = this.#network.get(params.requestId)
        if (entry !== undefined) {
          entry.failed = true
          entry.errorText = params.errorText ?? 'unknown error'
          entry.endedAt = Date.now()
        }
        if (params.canceled !== true && params.errorText !== 'net::ERR_ABORTED') {
          this.#pushConsole('error', `request failed: ${params.errorText ?? 'unknown error'} ${url}`, url)
        }
        this.#requests.delete(params.requestId)
        this.#networkActivityAt = Date.now()
        break
      }
      case 'Page.javascriptDialogOpening': {
        const info = {
          type: String(params.type ?? 'alert'),
          message: String(params.message ?? '').slice(0, 2000),
          defaultPrompt: typeof params.defaultPrompt === 'string' ? params.defaultPrompt : '',
          url: typeof params.url === 'string' ? params.url : this.#state.url,
          openedAt: Date.now(),
        }
        // A generated input event can pause the renderer until the dialog is
        // answered; release any tool waiting on it so the agent can handle the
        // dialog instead of timing out on Input.dispatchMouseEvent.
        for (const resolve of this.#dialogWaiters) resolve()
        this.#dialogWaiters.clear()
        if (this.#options.dialogBehavior === 'manual' && info.type !== 'beforeunload') {
          this.#dialog = info
          this.#pushConsole('warn', `dialog waiting (${info.type}): ${info.message}; call browser_handle_dialog`, info.url)
        } else {
          // beforeunload must be accepted or navigation/close would hang.
          const accept = info.type === 'beforeunload' || this.#options.dialogBehavior === 'accept'
          if (this.#conn !== undefined) {
            this.#conn.send('Page.handleJavaScriptDialog', {
              accept,
              ...(accept && info.type === 'prompt' ? { promptText: info.defaultPrompt } : {}),
            }, this.#sessionId).catch(() => { /* the dialog may already be gone */ })
          }
          this.#pushConsole('warn', `dialog ${info.type} ${accept ? 'accepted' : 'dismissed'}: ${info.message}`, info.url)
        }
        break
      }
      case 'Page.javascriptDialogClosed':
        this.#dialog = null
        break
      case 'Page.frameNavigated': {
        if (params.frame?.parentId === undefined) {
          this.#state.url = params.frame?.url ?? this.#state.url
          this.#networkActivityAt = Date.now()
          this.#refs.clear()
        }
        break
      }
      case 'Inspector.targetCrashed':
        this.#crashed = true
        this.#pushConsole('error', 'the page crashed; the next browser call will open a fresh page', undefined)
        break
      case 'Fetch.requestPaused':
        void this.#handleFetch(params)
        break
      case 'Browser.downloadWillBegin': {
        const guid = String(params.guid ?? '')
        if (guid === '') break
        this.#downloads.set(guid, {
          guid,
          url: String(params.url ?? ''),
          suggestedFilename: String(params.suggestedFilename ?? ''),
          startedAt: Date.now(),
          endedAt: null,
          receivedBytes: 0,
          totalBytes: null,
          state: 'inProgress',
          path: null,
        })
        if (this.#downloads.size > 50) {
          const oldest = this.#downloads.keys().next().value
          if (oldest !== undefined) this.#downloads.delete(oldest)
        }
        break
      }
      case 'Browser.downloadProgress': {
        const entry = this.#downloads.get(String(params.guid ?? ''))
        if (entry !== undefined) {
          entry.receivedBytes = Number(params.receivedBytes ?? entry.receivedBytes)
          entry.totalBytes = Number.isFinite(params.totalBytes) ? Number(params.totalBytes) : entry.totalBytes
          entry.state = String(params.state ?? entry.state)
          if (entry.state !== 'inProgress') entry.endedAt = Date.now()
          if (entry.state === 'completed' && this.#downloadPath !== null) {
            entry.path = path.join(this.#downloadPath, entry.suggestedFilename)
          }
        }
        break
      }
      default:
        break
    }
  }

  #pushRecordConsole(record, method, params) {
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args ?? []).map(serializeRemote).join(' ').slice(0, 2000)
      const level = params.type === 'error' ? 'error' : params.type === 'warning' ? 'warn' : 'log'
      const frame = params.stackTrace?.callFrames?.[0]
      this.#pushConsole(level, text, frame?.url, {
        line: frame === undefined ? null : (frame.lineNumber ?? 0) + 1,
        column: frame === undefined ? null : (frame.columnNumber ?? 0) + 1,
        stack: formatStack(params.stackTrace),
      }, record.console, record.sessionId)
      return
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails ?? {}
      const description = details.exception?.description ?? details.text ?? 'uncaught exception'
      this.#pushConsole('error', String(description).slice(0, 2000), details.url, {
        line: Number.isInteger(details.lineNumber) ? details.lineNumber + 1 : null,
        column: Number.isInteger(details.columnNumber) ? details.columnNumber + 1 : null,
        stack: formatStack(details.stackTrace),
      }, record.console, record.sessionId)
      return
    }
    const entry = params.entry ?? {}
    const level = entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warn' : 'log'
    this.#pushConsole(level, String(entry.text ?? '').slice(0, 2000), entry.url, {
      line: Number.isInteger(entry.lineNumber) ? entry.lineNumber + 1 : null,
      column: null,
      stack: formatStack(entry.stackTrace),
    }, record.console, record.sessionId)
  }

  #pushConsole(level, text, url, source = {}, target = null, owner = '') {
    const value = this.#redactText(cleanText(text))
    if (value === '') return
    const entries = Array.isArray(target) ? target : this.#console
    const now = Date.now()
    const line = Number.isInteger(source.line) ? source.line : null
    const column = Number.isInteger(source.column) ? source.column : null
    const key = `${owner}\u0000${level}\u0000${url ?? ''}\u0000${line}\u0000${column}\u0000${value}`
    const seenAt = this.#consoleKeys.get(key)
    if (seenAt !== undefined && now - seenAt < 2000) {
      this.#consoleKeys.set(key, now)
      return
    }
    this.#consoleKeys.set(key, now)
    for (const [entryKey, at] of this.#consoleKeys) {
      if (now - at > 5000) this.#consoleKeys.delete(entryKey)
    }
    entries.push({
      seq: ++this.#seq,
      level,
      text: value,
      url: url ?? '',
      at: Date.now(),
      line: Number.isInteger(source.line) ? source.line : null,
      column: Number.isInteger(source.column) ? source.column : null,
      stack: typeof source.stack === 'string' && source.stack !== '' ? source.stack : '',
    })
    if (entries.length > 400) entries.splice(0, entries.length - 400)
  }

  async #refreshIdentity() {
    if (this.#conn === undefined || this.#sessionId === undefined) return
    try {
      const { result } = await this.#conn.send('Runtime.evaluate', {
        expression: '({ url: location.href, title: document.title })',
        returnByValue: true,
      }, this.#sessionId)
      if (result?.value !== undefined) {
        this.#state.url = String(result.value.url ?? this.#state.url)
        this.#state.title = String(result.value.title ?? '')
      }
    } catch {
      // A page that is mid-navigation may not answer yet; the next call retries.
    }
  }

  async #resolveObject(target = {}, options = {}) {
    const found = await this.#resolveElements(target, options)
    if (found.objectIds.length === 0) throw new CdpError(`no element matches ${describeTarget(found.spec)}`)
    if (found.objectIds.length > 1 && found.spec.kind !== 'css') {
      const candidates = await this.#describeElements(found.arrayObjectId)
      throw new CdpError(`${found.objectIds.length} elements match ${describeTarget(found.spec)}; narrow it with a more specific target`
        + `${candidates === '' ? '' : ` (${candidates})`}`)
    }
    return found.objectIds[0]
  }

  /**
   * Resolve a ref, CSS selector, or locator string to the matching elements.
   * @param {{ target?: string, ref?: string, selector?: string }} target - tool target fields.
   * @param {{ includeHidden?: boolean }} [options] - include elements that are not visible.
   * @returns {Promise<{ spec: object, objectIds: string[], arrayObjectId?: string }>}
   */
  async #resolveElements(target = {}, options = {}) {
    const sessionId = this.#sessionId
    const spec = parseTarget(target)
    if (spec.kind === 'ref') {
      const backendNodeId = this.#refs.get(spec.ref)
      if (backendNodeId === undefined) {
        throw new CdpError(`unknown element ref "${spec.ref}"; call the snapshot tool again to read current refs`)
      }
      const { object } = await this.#conn.send('DOM.resolveNode', { backendNodeId }, sessionId)
      if (object?.objectId === undefined) throw new CdpError(`element ref "${spec.ref}" is no longer on the page`)
      return { spec, objectIds: [object.objectId] }
    }
    const expression = spec.kind === 'css'
      ? deepQueryExpression(spec.selector)
      : locatorExpression(spec, options.includeHidden === true)
    const { result, exceptionDetails } = await this.#conn.send('Runtime.evaluate', {
      expression,
      returnByValue: false,
    }, sessionId)
    if (exceptionDetails !== undefined) {
      if (spec.kind === 'css') throw new CdpError(`"${spec.selector}" is not a valid CSS selector`)
      throw new CdpError(`cannot evaluate ${describeTarget(spec)}: ${exceptionDetails.text ?? 'page error'}`)
    }
    if (result?.objectId === undefined) return { spec, objectIds: [] }
    const { result: properties = [] } = await this.#conn.send('Runtime.getProperties', {
      objectId: result.objectId,
      ownProperties: true,
    }, sessionId)
    const objectIds = properties
      .filter((property) => /^\d+$/u.test(property.name) && property.value?.objectId !== undefined)
      .map((property) => property.value.objectId)
    return { spec, objectIds, arrayObjectId: result.objectId }
  }

  /**
   * Format a few elements for a uniqueness error.
   * @param {string | undefined} arrayObjectId - the array returned by the locator.
   * @returns {Promise<string>}
   */
  async #describeElements(arrayObjectId) {
    if (arrayObjectId === undefined) return ''
    try {
      const { result } = await this.#conn.send('Runtime.callFunctionOn', {
        objectId: arrayObjectId,
        functionDeclaration: String.raw`function () {
          return this.slice(0, 6).map((element) => {
            const tag = element.tagName ? element.tagName.toLowerCase() : 'element';
            const id = element.id ? '#' + element.id : '';
            const text = String(element.innerText || element.textContent || element.value || '').replace(/\s+/g, ' ').trim().slice(0, 50);
            return tag + id + (text === '' ? '' : ' "' + text + '"');
          });
        }`,
        returnByValue: true,
      }, this.#sessionId)
      return Array.isArray(result?.value) ? result.value.join('; ') : ''
    } catch {
      return ''
    }
  }

  /**
   * Read viewport boxes for snapshot refs, without scrolling or changing the page.
   * @param {Array<{ ref: string, backendNodeId: number }>} entries - refs to measure.
   * @returns {Promise<Map<string, { x: number, y: number, width: number, height: number }>>}
   */
  async #readBoxes(entries) {
    const boxes = new Map()
    const queue = entries.slice(0, 200)
    const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
      for (;;) {
        const entry = queue.shift()
        if (entry === undefined) return
        try {
          const { object } = await this.#conn.send('DOM.resolveNode', { backendNodeId: entry.backendNodeId }, this.#sessionId)
          if (object?.objectId === undefined) continue
          const { result } = await this.#conn.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: String.raw`function () {
              const rect = this.getBoundingClientRect();
              let x = rect.left;
              let y = rect.top;
              let win = this.ownerDocument && this.ownerDocument.defaultView;
              while (win && win.frameElement) {
                const frameRect = win.frameElement.getBoundingClientRect();
                x += frameRect.left;
                y += frameRect.top;
                win = win.frameElement.ownerDocument && win.frameElement.ownerDocument.defaultView;
              }
              return { x: x, y: y, width: rect.width, height: rect.height };
            }`,
            returnByValue: true,
          }, this.#sessionId)
          const rect = result?.value
          if (rect === undefined || rect.width <= 0 || rect.height <= 0) continue
          if (rect.y + rect.height < 0 || rect.x + rect.width < 0
            || rect.x >= this.#state.width || rect.y >= this.#state.height) continue
          boxes.set(entry.ref, {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          })
        } catch {
          // A detached or hidden node has no usable box.
        }
      }
    })
    await Promise.all(workers)
    return boxes
  }

  /**
   * Measure one element's visibility without scrolling it into view.
   * @param {string} objectId - the element.
   * @returns {Promise<{ visible: boolean, reason: string }>}
   */
  async #elementVisibility(objectId) {
    const { result, exceptionDetails } = await this.#conn.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: String.raw`function () {
        const style = window.getComputedStyle(this);
        const rect = this.getBoundingClientRect();
        const visible = style.display !== 'none'
          && style.visibility !== 'hidden' && style.visibility !== 'collapse'
          && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
        return {
          visible: visible,
          reason: visible
            ? 'in layout'
            : 'display=' + style.display + ', visibility=' + style.visibility
              + ', opacity=' + style.opacity + ', size=' + Math.round(rect.width) + 'x' + Math.round(rect.height),
        };
      }`,
      returnByValue: true,
    }, this.#sessionId)
    if (exceptionDetails !== undefined) throw new CdpError('the element could not be inspected')
    return result?.value ?? { visible: false, reason: 'not measurable' }
  }

  /**
   * Reject a point outside the emulated viewport.
   * @param {number} x - viewport x.
   * @param {number} y - viewport y.
   * @returns {{ x: number, y: number, text: string }}
   */
  #viewportPoint(x, y) {
    const px = Number(x)
    const py = Number(y)
    if (!Number.isFinite(px) || !Number.isFinite(py)) throw new CdpError('clickAt needs numeric x and y coordinates')
    if (px < 0 || py < 0 || px >= this.#state.width || py >= this.#state.height) {
      throw new CdpError(`the point ${Math.round(px)},${Math.round(py)} is outside the ${this.#state.width}×${this.#state.height} viewport`)
    }
    return { x: px, y: py, text: '' }
  }

  /**
   * Verify that the center of the target is not covered by another element.
   * @param {string} objectId - the target element.
   * @param {{ x: number, y: number }} point - measured center.
   * @returns {Promise<void>}
   */
  async #hitTest(objectId, point) {
    const { result, exceptionDetails } = await this.#conn.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function () {
        const x = ${Number(point.x)};
        const y = ${Number(point.y)};
        let localX = x;
        let localY = y;
        let win = this.ownerDocument && this.ownerDocument.defaultView;
        while (win && win.frameElement) {
          const frameRect = win.frameElement.getBoundingClientRect();
          localX -= frameRect.left;
          localY -= frameRect.top;
          win = win.frameElement.ownerDocument && win.frameElement.ownerDocument.defaultView;
        }
        const root = this.getRootNode && this.getRootNode();
        const hit = (root && typeof root.elementFromPoint === 'function' ? root : document).elementFromPoint(localX, localY);
        const describe = (element) => {
          if (element === null) return 'nothing';
          const tag = element.tagName ? element.tagName.toLowerCase() : 'element';
          const id = element.id ? '#' + element.id : '';
          let cls = '';
          if (typeof element.className === 'string' && element.className.trim() !== '') {
            cls = '.' + element.className.trim().split(/\\s+/).slice(0, 2).join('.');
          }
          const text = String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
          return tag + id + cls + (text ? ' "' + text + '"' : '');
        };
        return {
          ok: hit !== null && (hit === this || this.contains(hit)),
          hit: describe(hit),
        };
      }`,
      returnByValue: true,
    }, this.#sessionId)
    if (exceptionDetails !== undefined) throw new CdpError('the element could not be hit-tested')
    const info = result?.value
    if (info?.ok === true) return
    throw new CdpError(`the element is covered at ${Math.round(point.x)},${Math.round(point.y)} by ${info?.hit ?? 'another element'}; `
      + 'close the overlay, scroll it into view, or click the covering element')
  }

  async #measure(objectId) {
    const { result } = await this.#conn.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function () {
        this.scrollIntoView({ block: 'center', inline: 'center' });
        let win = this.ownerDocument && this.ownerDocument.defaultView;
        while (win && win.frameElement) {
          win.frameElement.scrollIntoView({ block: 'center', inline: 'center' });
          win = win.frameElement.ownerDocument && win.frameElement.ownerDocument.defaultView;
        }
        const rect = this.getBoundingClientRect();
        let x = rect.left + rect.width / 2;
        let y = rect.top + rect.height / 2;
        win = this.ownerDocument && this.ownerDocument.defaultView;
        while (win && win.frameElement) {
          const frameRect = win.frameElement.getBoundingClientRect();
          x += frameRect.left;
          y += frameRect.top;
          win = win.frameElement.ownerDocument && win.frameElement.ownerDocument.defaultView;
        }
        const view = (this.ownerDocument && this.ownerDocument.defaultView) || window;
        const style = view.getComputedStyle(this);
        return {
          x: x,
          y: y,
          width: rect.width,
          height: rect.height,
          display: style.display,
          visibility: style.visibility,
          label: (this.getAttribute('aria-label') || this.innerText || this.value || this.tagName || '').toString().slice(0, 80),
        };
      }`,
      returnByValue: true,
    }, this.#sessionId)
    const point = result?.value
    if (point === undefined) throw new CdpError('the element could not be measured')
    if (point.width === 0 || point.height === 0) throw new CdpError('the element has no visible box to click')
    if (point.display === 'none' || point.visibility === 'hidden' || point.visibility === 'collapse') {
      throw new CdpError('the element is hidden; open its container first')
    }
    return { x: point.x, y: point.y, text: cleanText(point.label) }
  }

  async #dispatchMouse(point, { button = 'left', clickCount = 1 } = {}) {
    const sessionId = this.#sessionId
    const x = Math.round(point.x)
    const y = Math.round(point.y)
    await this.#input('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, sessionId)
    if (this.#dialog !== null) return
    for (let index = 1; index <= clickCount; index += 1) {
      await this.#input('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button, buttons: buttonBit(button), clickCount: index,
      }, sessionId)
      if (this.#dialog !== null) return
      await this.#input('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button, buttons: 0, clickCount: index,
      }, sessionId)
      if (this.#dialog !== null) return
      if (index < clickCount) await delay(60)
    }
  }

  /**
   * Dispatch one input event, but stop waiting if a JavaScript dialog freezes
   * the page. The pending protocol command is left to settle on its own; the
   * agent can then answer the dialog with browser_handle_dialog.
   * @param {string} method - CDP method.
   * @param {object} params - method parameters.
   * @param {string} sessionId - page session.
   * @returns {Promise<void>}
   */
  async #input(method, params, sessionId) {
    let signal
    const dialog = new Promise((resolve) => {
      signal = resolve
      this.#dialogWaiters.add(resolve)
    })
    try {
      const send = this.#conn.send(method, params, sessionId)
      send.catch(() => { /* the renderer may stay paused until the dialog is answered */ })
      await Promise.race([send, dialog])
    } finally {
      this.#dialogWaiters.delete(signal)
    }
  }

  async #teardown() {
    this.#closing = true
    this.#screencastActive = false
    this.#screencastRefs = 0
    this.#screencastFrame = null
    this.#screencastAt = 0
    this.#screencastListeners.clear()
    for (const timer of this.#screencastAckTimers.values()) clearTimeout(timer)
    this.#screencastAckTimers.clear()
    this.#initializedPages.clear()
    this.#enabledPages.clear()
    this.#perfInjectedSessions.clear()
    this.#sessionTabs.clear()
    this.#sessionCache.clear()
    for (const record of this.#contexts.values()) record.screencast.listeners.clear()
    this.#contexts.clear()
    this.#activeSessionId = null
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer)
      this.#idleTimer = undefined
    }
    const connection = this.#conn
    this.#conn = undefined
    this.#sessionId = undefined
    if (connection !== undefined && !connection.closed) {
      try { await connection.send('Browser.close', {}, undefined) } catch { /* the browser may already be gone */ }
      connection.close()
    }
    const child = this.#child
    this.#child = undefined
    if (child !== undefined && child.exitCode === null) {
      await delay(600)
      try { child.kill() } catch { /* already exited */ }
    }
    if (this.#activePortFile !== undefined) {
      try { await fsp.rm(this.#activePortFile, { force: true }) } catch { /* best effort */ }
      this.#activePortFile = undefined
    }
    this.#state.phase = 'stopped'
    this.#state.error = null
  }
}

/**
 * Poll the DevToolsActivePort file Chrome writes when it is ready.
 * @param {string} file - absolute path to the port file.
 * @param {import('node:child_process').ChildProcess} child - the spawned browser.
 * @returns {Promise<{ port: number, wsPath: string }>}
 */
async function waitForActivePort(file, child) {
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new CdpError(`the browser exited immediately (code ${child.exitCode}); another Chrome instance may already use this profile`)
    }
    try {
      const text = await fsp.readFile(file, 'utf8')
      const [portLine, pathLine] = text.trim().split(/\r?\n/u)
      const port = Number(portLine)
      if (Number.isInteger(port) && port > 0 && typeof pathLine === 'string' && pathLine.startsWith('/')) {
        return { port, wsPath: pathLine.trim() }
      }
    } catch {
      // The file appears once the browser is ready.
    }
    await delay(120)
  }
  throw new CdpError('timed out waiting for the browser debugging port; try closing leftover Chrome windows that use this profile')
}

/**
 * Parse a key or chord into CDP keyboard fields.
 * @param {string} expression - such as Enter, Tab, Control+A, or a single character.
 * @returns {{ insert?: string, key?: string, code?: string, virtualKeyCode?: number, modifiers?: number, text?: string }}
 */
function parseKey(expression) {
  const raw = String(expression ?? '').trim()
  if (raw === '') throw new CdpError('the key is empty')
  const named = {
    enter: { key: 'Enter', code: 'Enter', virtualKeyCode: 13, text: '\r' },
    tab: { key: 'Tab', code: 'Tab', virtualKeyCode: 9 },
    escape: { key: 'Escape', code: 'Escape', virtualKeyCode: 27 },
    esc: { key: 'Escape', code: 'Escape', virtualKeyCode: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', virtualKeyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', virtualKeyCode: 46 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', virtualKeyCode: 38 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', virtualKeyCode: 40 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', virtualKeyCode: 37 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', virtualKeyCode: 39 },
    home: { key: 'Home', code: 'Home', virtualKeyCode: 36 },
    end: { key: 'End', code: 'End', virtualKeyCode: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', virtualKeyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', virtualKeyCode: 34 },
    space: { key: ' ', code: 'Space', virtualKeyCode: 32, text: ' ' },
  }
  const parts = raw.split('+').map((part) => part.trim()).filter((part) => part !== '')
  let modifiers = 0
  let keyName = parts.pop() ?? ''
  for (const modifier of parts) {
    switch (modifier.toLowerCase()) {
      case 'alt':
      case 'option':
        modifiers |= 1
        break
      case 'ctrl':
      case 'control':
        modifiers |= 2
        break
      case 'meta':
      case 'cmd':
      case 'command':
        modifiers |= 4
        break
      case 'shift':
        modifiers |= 8
        break
      default:
        throw new CdpError(`unknown modifier "${modifier}" in "${raw}"`)
    }
  }
  const lowered = keyName.toLowerCase()
  if (named[lowered] !== undefined) {
    const entry = named[lowered]
    return { ...entry, modifiers }
  }
  if (keyName.length === 1) {
    if (modifiers === 0) return { insert: keyName }
    const upper = keyName.toUpperCase()
    const isDigit = /[0-9]/u.test(upper)
    const isLetter = /[A-Z]/u.test(upper)
    if (!isDigit && !isLetter) throw new CdpError(`"${raw}" is not supported; use a letter, a digit, or a named key such as Enter`)
    const shifted = (modifiers & 8) !== 0 && isLetter
    return {
      key: shifted ? upper : upper.toLowerCase(),
      code: isDigit ? `Digit${upper}` : `Key${upper}`,
      virtualKeyCode: upper.charCodeAt(0),
      modifiers,
      ...modifiers === 0 || isDigit ? { text: shifted ? upper : keyName } : {},
    }
  }
  throw new CdpError(`"${raw}" is not a known key; use Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space, or a single character`)
}

/**
 * Build the page probe used by waitFor.
 * @param {{ text?: string, selector?: string, caseSensitive?: boolean }} conditions - text/selector checks.
 * @returns {string} an expression returning `{ href, title, textOk, selectorOk, selectorError }`.
 */
function buildWaitProbe({ text, selector, caseSensitive }) {
  const checks = []
  if (text !== undefined) {
    const needle = caseSensitive ? text : text.toLowerCase()
    checks.push(`
      try {
        const bodyText = document.body ? document.body.innerText : '';
        result.textOk = ${caseSensitive ? 'bodyText' : 'bodyText.toLowerCase()'}.includes(${JSON.stringify(needle)});
      } catch (error) {
        result.probeError = String((error && error.message) || error);
      }
    `)
  }
  if (selector !== undefined) {
    checks.push(`
      try {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (element === null) {
          result.selectorOk = false;
        } else {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          result.selectorOk = style.display !== 'none' && style.visibility !== 'hidden'
            && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
        }
      } catch (error) {
        result.selectorError = String((error && error.message) || error);
      }
    `)
  }
  return `(() => {
    const result = { href: location.href, title: document.title, textOk: null, selectorOk: null, selectorError: null, probeError: null };
    ${checks.join('\n')}
    return result;
  })()`
}

/**
 * Clamp a wait timeout to a usable range.
 * @param {number | undefined} value - requested milliseconds.
 * @returns {number}
 */
const VALUE_AX_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider'])

/**
 * Read one accessibility property.
 * @param {object} node - AX node.
 * @param {string} name - property name.
 * @returns {unknown}
 */
function axProperty(node, name) {
  const property = (node.properties ?? []).find((entry) => entry.name === name)
  return property?.value?.value
}

/**
 * Find the first descendant AX node matching a predicate.
 * @param {object} node - AX node.
 * @param {Map<string, object>} byId - AX nodes by nodeId.
 * @param {(node: object) => boolean} predicate - match.
 * @param {number} [depth] - recursion depth.
 * @returns {object | undefined}
 */
function findAxDescendant(node, byId, predicate, depth = 0) {
  if (depth > 3) return undefined
  for (const id of node.childIds ?? []) {
    const child = byId.get(id)
    if (child === undefined) continue
    if (predicate(child)) return child
    const found = findAxDescendant(child, byId, predicate, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Describe the actionable state of one AX node.
 * @param {object} node - AX node.
 * @param {string} role - AX role.
 * @param {Map<string, object>} byId - AX nodes by nodeId, for child text and selected options.
 * @returns {string} suffix such as ` [checked] value="hello"`.
 */
function axStateSuffix(node, role, byId) {
  const truthy = (value) => value === true || value === 'true'
  const falsy = (value) => value === false || value === 'false'
  const parts = []
  const checked = axProperty(node, 'checked')
  if (truthy(checked)) parts.push(' [checked]')
  else if (checked === 'mixed') parts.push(' [mixed]')
  else if (falsy(checked) && (role === 'checkbox' || role === 'radio' || role === 'switch')) parts.push(' [unchecked]')
  if (truthy(axProperty(node, 'disabled'))) parts.push(' [disabled]')
  const expanded = axProperty(node, 'expanded')
  if (truthy(expanded)) parts.push(' [expanded]')
  else if (falsy(expanded)) parts.push(' [collapsed]')
  if (truthy(axProperty(node, 'selected'))) parts.push(' [selected]')
  const pressed = axProperty(node, 'pressed')
  if (truthy(pressed)) parts.push(' [pressed]')
  else if (falsy(pressed)) parts.push(' [not pressed]')
  else if (pressed === 'mixed') parts.push(' [mixed pressed]')
  if (truthy(axProperty(node, 'readonly'))) parts.push(' [readonly]')
  if (truthy(axProperty(node, 'required'))) parts.push(' [required]')
  const invalid = axProperty(node, 'invalid')
  if (invalid !== undefined && !falsy(invalid)) parts.push(' [invalid]')
  if (VALUE_AX_ROLES.has(role) && !truthy(axProperty(node, 'protected'))) {
    let value = axProperty(node, 'value') ?? axProperty(node, 'valuetext')
    if (value === undefined || value === null || String(value) === '') {
      if (role === 'combobox' || role === 'listbox') {
        const selected = findAxDescendant(node, byId, (child) => child.role?.value === 'option' && truthy(axProperty(child, 'selected')))
        if (selected !== undefined) value = selected.name?.value
      } else {
        const text = findAxDescendant(node, byId, (child) => child.role?.value === 'StaticText' && cleanText(child.name?.value) !== '')
        if (text !== undefined) value = text.name?.value
      }
    }
    if (value !== undefined && value !== null && String(value) !== '' && !/^[•●*]+$/u.test(String(value).trim())) {
      parts.push(` value=${JSON.stringify(truncate(String(value), 60))}`)
    }
  }
  return parts.join('')
}

/**
 * Normalize configured hosts into lowercase matching entries.
 * @param {unknown} input - comma/space-separated string or array.
 * @returns {string[]}
 */
function parseAllowedHosts(input) {
  const values = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,\s]+/u)
      : []
  const hosts = new Set()
  for (const value of values) {
    const host = String(value ?? '').trim().toLowerCase().replace(/^\[|\]$/gu, '')
    if (host !== '') hosts.add(host)
  }
  return [...hosts]
}

/**
 * Check whether a host matches a configured secret domain.
 * Supports exact hosts, `.example.com`, and `*.example.com`.
 * @param {string} host - current page hostname.
 * @param {string} domain - configured domain.
 * @returns {boolean}
 */
function hostMatchesDomain(host, domain) {
  const normalized = String(domain ?? '').trim().toLowerCase().replace(/^\*\./u, '.').replace(/^\./u, '')
  if (normalized === '' || normalized === '*') return true
  return host === normalized || host.endsWith(`.${normalized}`)
}

/**
 * Normalize configured secrets into `{ name, value, domains }` records.
 * @param {unknown} input - plugin configuration.
 * @returns {Array<{ name: string, value: string, domains: string[] }>}
 */
function parseSecrets(input) {
  const records = []
  const add = (name, raw) => {
    const label = String(name ?? '').trim()
    if (label === '') return
    if (typeof raw === 'string') {
      if (raw !== '') records.push({ name: label, value: raw, domains: [] })
      return
    }
    if (raw === null || typeof raw !== 'object') return
    const value = typeof raw.value === 'string' ? raw.value : ''
    if (value === '') return
    const domains = Array.isArray(raw.domains)
      ? raw.domains.map((domain) => String(domain).trim().toLowerCase()).filter((domain) => domain !== '')
      : typeof raw.domain === 'string'
        ? [raw.domain.trim().toLowerCase()]
        : []
    records.push({ name: label, value, domains })
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      if (item === null || typeof item !== 'object') continue
      add(item.name, item)
    }
  } else if (input !== null && typeof input === 'object') {
    for (const [name, raw] of Object.entries(input)) add(name, raw)
  }
  return records.filter((record) => record.value.length >= 4)
}

/**
 * Match a route pattern containing `*` wildcards against a URL.
 * @param {string} pattern - exact URL or wildcard pattern.
 * @param {string} url - request URL.
 * @returns {boolean}
 */
function routePatternMatches(pattern, url) {
  if (pattern === '*' || pattern === '') return true
  const source = String(pattern)
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 'u').test(url)
}

/**
 * Normalize route response headers and infer a content type.
 * @param {unknown} input - header object from the tool.
 * @param {string | undefined} contentType - explicit content type.
 * @param {unknown} body - response body.
 * @returns {Record<string, string>}
 */
function normalizeRouteHeaders(input, contentType, body) {
  const headers = {}
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    for (const [name, value] of Object.entries(input)) {
      if (String(name).trim() === '' || value === undefined || value === null) continue
      headers[String(name)] = String(value)
    }
  }
  const hasContentType = Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')
  if (!hasContentType && typeof contentType === 'string' && contentType !== '') {
    headers['content-type'] = contentType
  } else if (!hasContentType && body !== null && typeof body === 'object') {
    headers['content-type'] = 'application/json; charset=utf-8'
  }
  return headers
}

/**
 * Network throttling presets for `emulate`.
 * @type {Record<string, { offline: boolean, latency: number, downloadThroughput: number, uploadThroughput: number }>}
 */
const NETWORK_PRESETS = {
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  slow3g: { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 },
  fast3g: { offline: false, latency: 150, downloadThroughput: 200 * 1024, uploadThroughput: 100 * 1024 },
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
}

const DEFAULT_STYLE_PROPERTIES = [
  'display', 'position', 'width', 'height', 'min-width', 'min-height', 'margin', 'padding',
  'color', 'background-color', 'background-image', 'font-family', 'font-size', 'font-weight',
  'line-height', 'letter-spacing', 'border', 'border-radius', 'box-shadow', 'opacity',
  'overflow', 'z-index', 'flex', 'flex-direction', 'gap', 'grid-template-columns',
  'align-items', 'justify-content',
]

/**
 * Parse a comma/whitespace separated property filter; null means the curated list.
 * @param {unknown} raw - tool argument.
 * @returns {Set<string> | null}
 */
function parseStyleProperties(raw) {
  if (raw === undefined || raw === null || raw === '') return new Set(DEFAULT_STYLE_PROPERTIES)
  const values = Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/u)
  const names = values.map((value) => String(value).trim().toLowerCase()).filter((value) => value !== '')
  if (names.includes('*')) return null
  return names.length === 0 ? new Set(DEFAULT_STYLE_PROPERTIES) : new Set(names)
}

/**
 * Parse a `latitude,longitude` emulation point.
 * @param {unknown} raw - tool argument.
 * @returns {{ latitude: number, longitude: number }}
 */
function parseGeolocation(raw) {
  const parts = String(raw ?? '').split(',').map((part) => Number(part.trim()))
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    throw new CdpError('geolocation must be "latitude,longitude", such as 31.2304,121.4737')
  }
  const [latitude, longitude] = parts
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new CdpError('geolocation latitude must be -90..90 and longitude -180..180')
  }
  return { latitude, longitude }
}

/**
 * Parse one mouse button name.
 * @param {string | undefined} value - left, right, or middle.
 * @returns {'left' | 'right' | 'middle'}
 */
function parseButton(value) {
  if (value === undefined || value === 'left') return 'left'
  if (value === 'right' || value === 'middle') return value
  throw new CdpError(`unknown mouse button "${value}"; use left, right, or middle`)
}

/**
 * Clamp a click count to one, two, or three clicks.
 * @param {number | undefined} value - requested count.
 * @returns {number}
 */
function parseClickCount(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 1
  return Math.min(3, Math.max(1, Math.round(numeric)))
}

/**
 * CDP buttons bitmask for one mouse button.
 * @param {string} button - left, right, or middle.
 * @returns {number}
 */
function buttonBit(button) {
  return button === 'right' ? 2 : button === 'middle' ? 4 : 1
}

/**
 * Parse the waitUntil mode for navigation.
 * @param {unknown} value - load, networkIdle, or none.
 * @returns {'load' | 'networkIdle' | 'none'}
 */
function parseWaitUntil(value) {
  if (value === undefined || value === 'load') return 'load'
  if (value === 'networkIdle' || value === 'none') return value
  throw new CdpError(`unknown waitUntil "${value}"; use load, networkIdle, or none`)
}

/**
 * Clamp a navigation timeout.
 * @param {number | undefined} value - requested milliseconds.
 * @returns {number}
 */
function clampNavTimeout(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 15000
  return Math.min(60000, Math.max(1000, Math.round(numeric)))
}

function clampWaitTimeout(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 10000
  return Math.min(60000, Math.max(100, Math.round(numeric)))
}

/**
 * Clamp an assertion polling window.
 * @param {number | undefined} value - requested milliseconds.
 * @returns {number}
 */
function clampAssertTimeout(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 3000
  return Math.min(15000, Math.max(100, Math.round(numeric)))
}

/**
 * Short excerpt around a text match, or the start of the page text.
 * @param {string} body - page visible text.
 * @param {string} needle - searched text.
 * @param {boolean} caseSensitive - whether the search was case-sensitive.
 * @returns {string}
 */
function textSnippet(body, needle, caseSensitive) {
  const haystack = caseSensitive ? body : body.toLowerCase()
  const wanted = caseSensitive ? needle : needle.toLowerCase()
  const index = haystack.indexOf(wanted)
  const flat = body.replace(/\s+/gu, ' ').trim()
  if (index < 0) return flat === '' ? '' : ` (text starts: "${flat.slice(0, 120)}")`
  const start = Math.max(0, index - 50)
  const end = Math.min(body.length, index + needle.length + 50)
  return ` near "${body.slice(start, end).replace(/\s+/gu, ' ').trim()}"`
}

/**
 * Compact a CDP stack trace into at most four source lines.
 * @param {{ callFrames?: Array<{ functionName?: string, url?: string, lineNumber?: number, columnNumber?: number }> } | undefined} stackTrace - CDP stack trace.
 * @returns {string}
 */
function formatStack(stackTrace) {
  const frames = stackTrace?.callFrames ?? []
  return frames.slice(0, 4).map((frame) => {
    const name = frame.functionName === undefined || frame.functionName === '' ? '<anonymous>' : frame.functionName
    const url = frame.url === undefined || frame.url === '' ? '<page>' : frame.url
    const line = (frame.lineNumber ?? 0) + 1
    const column = (frame.columnNumber ?? 0) + 1
    return `${name} (${url}:${line}:${column})`
  }).join('\n')
}

/**
 * Public, bounded view of one tracked request.
 * @param {object} entry - internal network entry.
 * @returns {object}
 */
function publicNetworkEntry(entry) {
  const endedAt = entry.endedAt ?? null
  return {
    id: entry.requestId,
    url: entry.url,
    method: entry.method,
    resourceType: entry.resourceType,
    status: entry.status,
    statusText: entry.statusText ?? '',
    mimeType: entry.mimeType ?? '',
    durationMs: endedAt === null ? null : Math.max(0, endedAt - entry.startedAt),
    size: entry.encodedDataLength,
    failed: entry.failed,
    errorText: entry.errorText,
    fromCache: entry.fromCache,
  }
}

/**
 * Hide credentials in a CDP header map.
 * @param {unknown} headers - request or response headers.
 * @returns {Record<string, string>}
 */
function redactHeaders(headers) {
  if (headers === null || typeof headers !== 'object') return {}
  const sensitive = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token)$/iu
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name.toLowerCase(),
    sensitive.test(name) ? '<redacted>' : String(value),
  ]))
}

/**
 * Match a URL exactly, or with `*` wildcards.
 * @param {string} current - page URL.
 * @param {string} target - expected URL or wildcard pattern.
 * @returns {boolean}
 */
function matchesUrl(current, target) {
  if (!target.includes('*')) return current === target
  const source = `^${target.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*')}$`
  return new RegExp(source, 'u').test(current)
}

/**
 * Human-readable list of wait conditions for errors and activity labels.
 * @param {{ text?: string, selector?: string, url?: string, networkIdle?: boolean }} conditions - the conditions.
 * @returns {string}
 */
function describeWaitConditions({ text, selector, url, networkIdle }) {
  const parts = []
  if (text !== undefined) parts.push(`text "${text}"`)
  if (selector !== undefined) parts.push(`selector ${selector}`)
  if (url !== undefined) parts.push(`URL ${url}`)
  if (networkIdle === true) parts.push('network idle')
  return parts.join(' + ')
}

/**
 * Whether an evaluation error came from a navigation destroying the context.
 * @param {unknown} error - the thrown value.
 * @returns {boolean}
 */
function isNavigationError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /Execution context was destroyed|Cannot find context|Inspected target navigated|navigating/iu.test(message)
}

/**
 * Keep the screenshot directory bounded.
 * @param {string} directory - screenshot directory.
 */
async function pruneScreenshots(directory) {
  try {
    const entries = await fsp.readdir(directory)
    if (entries.length <= MAX_SHOT_FILES) return
    const stale = entries.sort().slice(0, entries.length - MAX_SHOT_FILES)
    await Promise.all(stale.map((name) => fsp.rm(path.join(directory, name), { force: true })))
  } catch {
    // Pruning is best-effort housekeeping.
  }
}
