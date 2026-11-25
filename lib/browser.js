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
  #requests = new Map()
  #networkActivityAt = 0
  #dialog = null
  #dialogWaiters = new Set()
  #switchChain = Promise.resolve()
  #discoveryConnection
  #seq = 0
  #launchPromise
  #closing = false
  #disposed = false

  /**
   * @param {{ browserPath?: string, headless?: boolean, width?: number, height?: number, profileDir?: string, timeoutMs?: number, dialogBehavior?: 'dismiss' | 'accept' | 'manual' }} [options]
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
    }
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
      consoleCount: this.#console.length,
      errorCount: this.#console.filter((entry) => entry.level === 'error').length,
      recentErrors: this.#console.filter((entry) => entry.level === 'error').slice(-3).map((entry) => entry.text),
    }
  }

  /** @returns {{ width: number, height: number }} the emulated viewport. */
  get viewport() {
    return { width: this.#state.width, height: this.#state.height }
  }

  /** Re-read the page URL and title into the panel state. */
  async refreshIdentity() {
    await this.#refreshIdentity()
  }

  /** Launch the browser if needed and resolve once it can navigate. */
  async ensureStarted() {
    if (this.#disposed) throw new CdpError('the browser plugin is shutting down')
    if (this.#state.phase === 'running' && this.#conn !== undefined && !this.#conn.closed) return
    if (this.#launchPromise !== undefined) return this.#launchPromise
    this.#launchPromise = this.#launch().finally(() => { this.#launchPromise = undefined })
    return this.#launchPromise
  }

  /**
   * Navigate the page and wait for the load event.
   * @param {string} url - address to open.
   * @returns {Promise<object>} the new state.
   */
  async open(url) {
    const target = normalizeUrl(url)
    await this.ensureStarted()
    this.#assertNoDialog()
    this.#console = []
    this.#refs.clear()
    const sessionId = this.#sessionId
    let loaded = false
    const off = this.#conn.on('Page.loadEventFired', (_params, sid) => {
      if (sid === sessionId) loaded = true
    })
    try {
      const result = await this.#conn.send('Page.navigate', { url: target }, sessionId)
      if (result.errorText !== undefined && result.errorText !== '') {
        throw new CdpError(`cannot open ${target}: ${result.errorText}`)
      }
      const deadline = Date.now() + 15000
      while (!loaded && Date.now() < deadline) await delay(80)
      await delay(300)
    } finally {
      off()
    }
    this.#state.url = target
    await this.#refreshIdentity()
    return this.getState()
  }

  /** Reload the current page, bypassing the cache. */
  async reload() {
    await this.ensureStarted()
    this.#assertNoDialog()
    this.#console = []
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
    return this.getState()
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
   * @param {{ interactiveOnly?: boolean }} [options] - omit static content and visible text.
   * @returns {Promise<{ url: string, title: string, viewport: { width: number, height: number }, outline: string, text: string, refs: number, truncated: boolean }>}
   */
  async snapshot({ interactiveOnly = false } = {}) {
    await this.ensureStarted()
    this.#assertNoDialog()
    await this.#refreshIdentity()
    const sessionId = this.#sessionId
    await this.#conn.send('Accessibility.enable', {}, sessionId)
    const { nodes = [] } = await this.#conn.send('Accessibility.getFullAXTree', {}, sessionId)
    this.#refs.clear()
    const byId = new Map(nodes.map((node) => [node.nodeId, node]))
    const roots = nodes.filter((node) => node.parentId === undefined || !byId.has(node.parentId))
    const lines = []
    let truncated = false
    const interactiveRoles = new Set([
      'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio',
      'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'gridcell',
      'DisclosureTriangle',
    ])
    const skippedRoles = new Set(['none', 'generic', 'presentation', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'WebArea'])
    const walk = (node, depth, parentName) => {
      if (lines.length >= AX_LINE_LIMIT) {
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
        if (interactiveRoles.has(role) && node.backendDOMNodeId !== undefined) {
          const ref = `e${this.#refs.size + 1}`
          this.#refs.set(ref, node.backendDOMNodeId)
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
        if (line !== '') lines.push(line)
      }
      for (const childId of node.childIds ?? []) walk(byId.get(childId), nextDepth, name === '' ? parentName : name)
    }
    for (const root of roots) walk(root, 0, '')
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
      }))
    return { current: this.#targetId ?? null, tabs }
  }

  /**
   * Create and select a new page.
   * @param {string} [url] - address; defaults to about:blank.
   * @returns {Promise<object>} the tab list after switching.
   */
  async newTab(url = 'about:blank') {
    await this.ensureStarted()
    const target = typeof url === 'string' && url.trim() !== '' ? normalizeUrl(url) : 'about:blank'
    const { targetId } = await this.#conn.send('Target.createTarget', { url: target })
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
    const previous = this.#sessionId
    const { sessionId } = await this.#conn.send('Target.attachToTarget', { targetId, flatten: true })
    this.#sessionId = sessionId
    this.#targetId = targetId
    this.#refs.clear()
    this.#console = []
    this.#requests.clear()
    this.#networkActivityAt = 0
    if (previous !== undefined && previous !== sessionId) {
      this.#conn.send('Target.detachFromTarget', { sessionId: previous }).catch(() => { /* the old page stays open */ })
    }
    await this.#initializePage(this.#conn, sessionId)
    this.#state.phase = 'running'
    this.#state.error = null
    this.#state.url = typeof target.url === 'string' ? target.url : 'about:blank'
    this.#state.title = typeof target.title === 'string' ? target.title : ''
    await this.#refreshIdentity()
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
    await this.#conn.send('Target.closeTarget', { targetId: closing })
    await delay(200)
    if (closing === this.#targetId) {
      const remaining = (await this.listTabs()).tabs.filter((tab) => tab.targetId !== closing)
      if (remaining.length > 0) {
        await this.selectTab(remaining[0].targetId)
      } else {
        const { targetId: fresh } = await this.#conn.send('Target.createTarget', { url: 'about:blank' })
        await this.selectTab(fresh)
      }
    }
    return this.listTabs()
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
        if (append === true) {
          if (this.isContentEditable) {
            const range = document.createRange();
            range.selectNodeContents(this);
            range.collapse(false);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
          } else if (typeof this.setSelectionRange === 'function' && typeof this.value === 'string') {
            try { this.setSelectionRange(this.value.length, this.value.length); } catch (error) { /* inputs without selection support */ }
          }
          return true;
        }
        if (this.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(this);
          const selection = window.getSelection();
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
        if (!(this instanceof HTMLSelectElement)) return { ok: false, error: 'the element is not a <select>' };
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
      const ref = typeof field.ref === 'string' ? field.ref : undefined
      const selector = typeof field.selector === 'string' ? field.selector : undefined
      if (ref === undefined && selector === undefined) throw new CdpError('each field needs ref or selector')
      if (field.append === true && field.clear === true) throw new CdpError('a field cannot append and clear at the same time')
      const text = typeof field.text === 'string' ? field.text : typeof field.value === 'string' ? field.value : ''
      const filled = await this.type({
        ref,
        selector,
        text,
        append: field.append === true,
        clear: field.clear === true,
      })
      results.push({ label: filled.label, target: ref ?? selector ?? '' })
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
    if (input.ref !== undefined || input.selector !== undefined) {
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
    await delay(250)
    return this.getState()
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

  /** Close the browser and reject later commands. */
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    await this.#teardown()
  }

  async #launch() {
    this.#state.phase = 'starting'
    this.#state.error = null
    this.#console = []
    this.#requests.clear()
    this.#refs.clear()
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
      'Inspector.targetCrashed',
    ]
    for (const method of events) connection.on(method, (params, sid) => this.#handleEvent(method, params, sid))
    await connection.send('Page.enable', {}, sessionId)
    await connection.send('Runtime.enable', {}, sessionId)
    await connection.send('Log.enable', {}, sessionId)
    await connection.send('Network.enable', {}, sessionId)
    this.#networkActivityAt = Date.now()
    await connection.send('DOM.enable', {}, sessionId)
    await connection.send('Emulation.setDeviceMetricsOverride', {
      width: this.#options.width,
      height: this.#options.height,
      deviceScaleFactor: 1,
      mobile: this.#options.width < 640,
    }, sessionId)
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

  #handleEvent(method, params, sessionId) {
    if (sessionId !== undefined && sessionId !== this.#sessionId) return
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const text = (params.args ?? []).map(serializeRemote).join(' ').slice(0, 2000)
        const level = params.type === 'error' ? 'error' : params.type === 'warning' ? 'warn' : 'log'
        this.#pushConsole(level, text, params.stackTrace?.callFrames?.[0]?.url)
        break
      }
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails ?? {}
        const description = details.exception?.description ?? details.text ?? 'uncaught exception'
        this.#pushConsole('error', String(description).slice(0, 2000), details.url)
        break
      }
      case 'Log.entryAdded': {
        const entry = params.entry ?? {}
        const level = entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warn' : 'log'
        this.#pushConsole(level, String(entry.text ?? '').slice(0, 2000), entry.url)
        break
      }
      case 'Network.requestWillBeSent': {
        const type = params.type
        if (type !== 'WebSocket' && type !== 'EventSource') {
          this.#requests.set(params.requestId, params.request?.url ?? '')
          this.#networkActivityAt = Date.now()
        }
        break
      }
      case 'Network.responseReceived': {
        this.#networkActivityAt = Date.now()
        const status = params.response?.status ?? 0
        if (status >= 400) this.#pushConsole('warn', `HTTP ${status} ${params.response?.url ?? ''}`, params.response?.url)
        break
      }
      case 'Network.loadingFinished':
        this.#requests.delete(params.requestId)
        this.#networkActivityAt = Date.now()
        break
      case 'Network.loadingFailed': {
        const url = this.#requests.get(params.requestId) ?? ''
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
        this.#pushConsole('error', 'the page crashed', undefined)
        break
      default:
        break
    }
  }

  #pushConsole(level, text, url) {
    const value = cleanText(text)
    if (value === '') return
    this.#console.push({ seq: ++this.#seq, level, text: value, url: url ?? '', at: Date.now() })
    if (this.#console.length > 400) this.#console.splice(0, this.#console.length - 400)
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

  async #resolveObject(target = {}) {
    const sessionId = this.#sessionId
    const rawRef = typeof target.ref === 'string' ? target.ref.trim() : ''
    if (rawRef !== '') {
      const key = /^e\d+$/u.test(rawRef) ? rawRef : `e${rawRef.replace(/[^0-9]/gu, '')}`
      const backendNodeId = this.#refs.get(key)
      if (backendNodeId === undefined) {
        throw new CdpError(`unknown element ref "${rawRef}"; call the snapshot tool again to read current refs`)
      }
      const { object } = await this.#conn.send('DOM.resolveNode', { backendNodeId }, sessionId)
      if (object?.objectId === undefined) throw new CdpError(`element ref "${rawRef}" is no longer on the page`)
      return object.objectId
    }
    if (typeof target.selector === 'string' && target.selector.trim() !== '') {
      const selector = target.selector.trim()
      const { result, exceptionDetails } = await this.#conn.send('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
        returnByValue: false,
      }, sessionId)
      if (exceptionDetails !== undefined) throw new CdpError(`"${selector}" is not a valid CSS selector`)
      if (result?.objectId === undefined || result.subtype === 'null') throw new CdpError(`no element matches the selector ${selector}`)
      return result.objectId
    }
    throw new CdpError('pass either ref or selector')
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
        const root = this.getRootNode && this.getRootNode();
        const hit = (root && typeof root.elementFromPoint === 'function' ? root : document).elementFromPoint(x, y);
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
        const rect = this.getBoundingClientRect();
        const style = window.getComputedStyle(this);
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
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

function clampWaitTimeout(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 10000
  return Math.min(60000, Math.max(100, Math.round(numeric)))
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
