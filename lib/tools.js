/**
 * Model-facing browser tools.
 *
 * Every tool returns a canonical `{ text, path?, image? }` value: `text` is the
 * bounded model-facing reading, `image` is the durable attachment of the shot,
 * and `path` is the same shot on disk for the human. Screenshots are committed
 * inside `execute`, because `output.render` must stay synchronous.
 * @module dsh-browser-cockpit/lib/tools
 */

import { captureThumbnail } from './activity.js'
import { openTarget } from './targets.js'

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height'],
      properties: { width: { type: 'integer' }, height: { type: 'integer' } },
    },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string' },
    path: { type: 'string' },
    image: IMAGE_SCHEMA,
  },
}

const MAX_TEXT_CHARS = 9000
const DEFAULT_OUTLINE_LINES = 220

const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)))

function bounded(text, max = MAX_TEXT_CHARS) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}\n… (truncated ${value.length - max} characters)`
}

function requireString(args, key) {
  const value = args?.[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`"${key}" must be a non-empty string`)
  return value.trim()
}

function optionalString(args, key) {
  const value = args?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function optionalNumber(args, key) {
  const value = args?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Read the page as bounded outline plus visible text, attaching a screenshot.
 * @param {import('./browser.js').BrowserSession} session - the controlled page.
 * @param {object} ctx - the plugin context, used for the attachment store.
 * @param {{ maxLines?: number, capture?: boolean, lead?: string }} [options] - bounds and framing.
 * @returns {Promise<{ text: string, path?: string, image?: object }>}
 */
async function readPage(session, ctx, options = {}) {
  const snapshot = await session.snapshot()
  const maxLines = clamp(options.maxLines ?? DEFAULT_OUTLINE_LINES, 20, 700)
  const lines = snapshot.outline === '' ? [] : snapshot.outline.split('\n')
  const shown = lines.slice(0, maxLines)
  const omitted = lines.length - shown.length
  const sections = []
  if (options.lead !== undefined) sections.push(options.lead)
  sections.push([
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title === '' ? '(empty)' : snapshot.title}`,
    `Viewport: ${snapshot.viewport.width}x${snapshot.viewport.height}`,
    `Interactive refs: ${snapshot.refs}`,
  ].join('\n'))
  sections.push(['Outline:', ...shown, omitted > 0 ? `… (${omitted} more outline lines not shown; raise maxLines to read them)` : ''].join('\n'))
  if (snapshot.text !== '') sections.push(`Visible text:\n${snapshot.text}`)
  const result = { text: bounded(sections.join('\n\n')) }

  if (options.capture !== false) {
    try {
      const png = await session.capture({ format: 'png', maxDimension: 1600 })
      const image = await attachImage(ctx, png, 'browser-page.png')
      if (image !== null) {
        result.image = image
        const saved = await session.saveScreenshot(png)
        if (saved !== null) result.path = saved
      }
    } catch {
      // A page that is mid-navigation may not screenshot yet; the outline still answers.
    }
  }
  return result
}

/**
 * Commit one PNG through the attachment store.
 * @param {object} ctx - the plugin context.
 * @param {Buffer} png - PNG bytes.
 * @param {string} name - display name.
 * @returns {Promise<object | null>}
 */
async function attachImage(ctx, png, name) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return null
  try {
    const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name })
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
      ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
    }
  } catch {
    return null
  }
}

/**
 * Render one canonical value as model content.
 * @param {{ text: string, image?: object }} value - tool value.
 * @returns {Array<object>} content blocks.
 */
function renderValue(value) {
  const blocks = [{ type: 'text', text: value.text }]
  if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
  return blocks
}

/** Content for one tool invocation. */
const commonOutput = { schema: OUTPUT_SCHEMA, render: (_args, value) => renderValue(value) }

/**
 * Describe the newest console entries for an action's follow-up line.
 * @param {import('./browser.js').BrowserSession} session - the controlled page.
 * @param {number} sinceTotal - console count before the action.
 * @returns {string}
 */
function consoleDelta(session, sinceTotal) {
  const read = session.readConsole({ limit: 200 })
  const fresh = read.entries.filter((entry) => entry.seq > sinceTotal)
  if (fresh.length === 0) return ''
  const errors = fresh.filter((entry) => entry.level === 'error')
  const lines = fresh.slice(0, 6).map((entry) => `- [${entry.level}] ${entry.text}`)
  const suffix = fresh.length > lines.length ? `\n… (${fresh.length - lines.length} more; call browser_console)` : ''
  return `\n\nNew console output (${fresh.length}${errors.length > 0 ? `, ${errors.length} errors` : ''}):\n${lines.join('\n')}${suffix}`
}

/**
 * Tell the agent when an action left a manual dialog waiting.
 * @param {import('./browser.js').BrowserSession} session - the controlled page.
 * @returns {string}
 */
function dialogNote(session) {
  const dialog = session.getState().dialog
  if (dialog === null || dialog === undefined) return ''
  return `\n\nA JavaScript ${dialog.type} dialog is waiting: "${dialog.message}". Call browser_handle_dialog with accept true or false.`
}

/**
 * What each tool contributes to the panel's activity timeline.
 * `thumb` asks for one small post-action screenshot as visual evidence.
 */
const ACTIVITY_SPECS = {
  browser_open: { kind: 'open', thumb: true, detail: (args) => ({ url: typeof args.url === 'string' ? args.url : '' }) },
  browser_snapshot: { kind: 'read-page', thumb: false, detail: () => ({}) },
  browser_click: {
    kind: 'click',
    thumb: true,
    detail: (args) => ({
      target: typeof args.ref === 'string'
        ? args.ref
        : typeof args.selector === 'string'
          ? args.selector
          : typeof args.x === 'number' && typeof args.y === 'number' ? `${args.x},${args.y}` : '',
      button: typeof args.button === 'string' ? args.button : 'left',
      clickCount: typeof args.clickCount === 'number' ? args.clickCount : 1,
    }),
  },
  browser_hover: {
    kind: 'hover',
    thumb: true,
    detail: (args) => ({ target: typeof args.ref === 'string' ? args.ref : typeof args.selector === 'string' ? args.selector : '' }),
  },
  browser_drag: {
    kind: 'drag',
    thumb: true,
    detail: (args) => ({
      from: typeof args.fromRef === 'string' ? args.fromRef : typeof args.fromSelector === 'string' ? args.fromSelector : '',
      to: typeof args.toRef === 'string' ? args.toRef : typeof args.toSelector === 'string' ? args.toSelector : '',
    }),
  },
  browser_type: {
    kind: 'type',
    thumb: true,
    detail: (args) => ({
      target: typeof args.ref === 'string' ? args.ref : typeof args.selector === 'string' ? args.selector : '',
      text: typeof args.text === 'string' ? args.text.slice(0, 80) : '',
    }),
  },
  browser_key: { kind: 'key', thumb: true, detail: (args) => ({ key: typeof args.key === 'string' ? args.key : '' }) },
  browser_wait_for: {
    kind: 'wait',
    thumb: false,
    detail: (args) => ({
      text: typeof args.text === 'string' ? args.text.slice(0, 60) : '',
      selector: typeof args.selector === 'string' ? args.selector.slice(0, 60) : '',
      url: typeof args.url === 'string' ? args.url.slice(0, 60) : '',
      networkIdle: args.networkIdle === true,
    }),
  },
  browser_handle_dialog: { kind: 'dialog', thumb: false, detail: (args) => ({ accept: args.accept === true }) },
  browser_scroll: {
    kind: 'scroll',
    thumb: true,
    detail: (args) => ({
      direction: typeof args.direction === 'string' ? args.direction : 'down',
      target: typeof args.ref === 'string' ? args.ref : typeof args.selector === 'string' ? args.selector : '',
    }),
  },
  browser_eval: {
    kind: 'eval',
    thumb: false,
    detail: (args) => ({ expression: typeof args.expression === 'string' ? args.expression.slice(0, 100) : '' }),
  },
  browser_console: { kind: 'read-console', thumb: false, detail: () => ({}) },
  browser_screenshot: { kind: 'screenshot', thumb: true, detail: (args) => ({ fullPage: args.fullPage === true }) },
  browser_resize: {
    kind: 'resize',
    thumb: true,
    detail: (args) => ({ width: args.width, height: args.height }),
  },
  browser_close: { kind: 'close', thumb: false, detail: () => ({}) },
}

/**
 * Register every browser tool on the plugin context.
 * @param {object} ctx - host plugin context with the `tools` service.
 * @param {import('./browser.js').BrowserSession} session - the controlled page.
 * @param {(url: string) => { target: string, cleanAfterLoad: boolean }} resolveTarget - address resolver.
 * @param {import('./activity.js').ActivityLog} activity - the panel's action log.
 */
export function registerBrowserTools(ctx, session, resolveTarget, activity) {
  const targetParams = {
    ref: { type: 'string', description: 'Element handle from the latest snapshot, such as e12.' },
    selector: { type: 'string', description: 'CSS selector, used when no ref is known. Prefer ref.' },
  }

  /** Wrap one definition so the panel records its start, result, page, and a thumbnail. */
  const registerTool = (definition) => {
    const spec = ACTIVITY_SPECS[definition.name] ?? { kind: 'other', thumb: false, detail: () => ({}) }
    const original = definition.execute
    definition.execute = async (args, exec) => {
      const before = session.getState()
      const handle = activity.begin({
        tool: definition.name,
        source: 'agent',
        kind: spec.kind,
        detail: spec.detail(args ?? {}),
        errorCount: before.errorCount,
        sessionId: typeof exec?.agent?.id === 'string' ? exec.agent.id : null,
      })
      try {
        const value = await original(args, exec, handle)
        const after = session.getState()
        const thumbnail = spec.thumb ? await captureThumbnail(session) : null
        activity.finish(handle, { status: 'ok', page: after, errorCount: after.errorCount, thumbnail })
        return value
      } catch (error) {
        const after = session.getState()
        const thumbnail = spec.thumb ? await captureThumbnail(session) : null
        activity.finish(handle, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          page: after,
          errorCount: after.errorCount,
          thumbnail,
        })
        throw error
      }
    }
    ctx.tools.register(definition)
  }

  registerTool({
    name: 'browser_open',
    description: 'Open a URL in the controlled Chrome and return the page outline, visible text, and a screenshot. '
      + 'Starts a headless browser on first use. Use this to look at a running project yourself instead of asking for screenshots.',
    parameters: {
      url: { type: 'string', required: true, description: 'Address such as http://localhost:3000/ or localhost:5173.' },
      maxLines: { type: 'integer', description: 'Outline lines to return; defaults to 220, maximum 700.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Open ${args.url}`, kind: 'fetch' }
    },
    async execute(args) {
      const url = requireString(args, 'url')
      await openTarget(session, resolveTarget, url)
      return readPage(session, ctx, { maxLines: optionalNumber(args, 'maxLines'), lead: `Opened ${url}.` })
    },
  })

  registerTool({
    name: 'browser_snapshot',
    description: 'Read the page that is already open: interactive elements with [ref=…] handles, visible text, and a screenshot. '
      + 'Call it after an action when the page changed.',
    parameters: {
      maxLines: { type: 'integer', description: 'Outline lines to return; defaults to 220, maximum 700.' },
    },
    output: commonOutput,
    presentCall() {
      return { card: 'generic', title: 'Read the browser page', kind: 'read' }
    },
    async execute(args) {
      return readPage(session, ctx, { maxLines: optionalNumber(args, 'maxLines') })
    },
  })

  registerTool({
    name: 'browser_click',
    description: 'Click in the controlled page: an element by snapshot ref or CSS selector, or a viewport point by x/y. '
      + 'Supports left/right/middle buttons and 1–3 clicks (2 is a double-click). The center must not be covered by an overlay.',
    parameters: {
      ...targetParams,
      x: { type: 'integer', description: 'Viewport x coordinate; pass with y to click a point instead of an element.' },
      y: { type: 'integer', description: 'Viewport y coordinate; pass with x.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button; defaults to left.' },
      clickCount: { type: 'integer', description: 'Number of clicks (1–3); 2 is a double-click. Defaults to 1.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Click ${args.ref ?? args.selector ?? `${args.x ?? '?'},${args.y ?? '?'}`}`, kind: 'edit' }
    },
    async execute(args, exec, activity) {
      const ref = optionalString(args, 'ref')
      const selector = optionalString(args, 'selector')
      const x = optionalNumber(args, 'x')
      const y = optionalNumber(args, 'y')
      const hasPoint = x !== undefined || y !== undefined
      if (hasPoint && (x === undefined || y === undefined)) throw new Error('pass both x and y, or neither')
      if (hasPoint && (ref !== undefined || selector !== undefined)) throw new Error('pass either ref/selector or x/y, not both')
      if (!hasPoint && ref === undefined && selector === undefined) throw new Error('pass ref, selector, or both x and y')
      const before = session.readConsole({ limit: 1 }).total
      const point = hasPoint
        ? await session.clickAt({ x, y, button: args.button, clickCount: optionalNumber(args, 'clickCount') })
        : await session.click({ ref, selector }, { button: args.button, clickCount: optionalNumber(args, 'clickCount') })
      if (!hasPoint && point.text !== '') activity?.annotate?.({ targetLabel: point.text })
      const state = session.getState()
      const label = point.text === '' ? `${Math.round(point.x)},${Math.round(point.y)}` : `"${point.text}"`
      const action = point.clickCount > 1 ? `${point.clickCount} clicks` : 'click'
      return {
        text: bounded(`Clicked ${label} with a ${point.button} ${action} at ${Math.round(point.x)},${Math.round(point.y)}.\n`
          + `Page: ${state.title === '' ? state.url : `${state.title} — ${state.url}`}${consoleDelta(session, before)}${dialogNote(session)}`),
      }
    },
  })

  registerTool({
    name: 'browser_hover',
    description: 'Move the mouse over one element by snapshot ref or CSS selector. Use it for menus, tooltips, and hover-only controls.',
    parameters: {
      ...targetParams,
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Hover ${args.ref ?? args.selector ?? 'element'}`, kind: 'other' }
    },
    async execute(args) {
      const before = session.readConsole({ limit: 1 }).total
      const point = await session.hover({ ref: optionalString(args, 'ref'), selector: optionalString(args, 'selector') })
      const label = point.text === '' ? `${Math.round(point.x)},${Math.round(point.y)}` : `"${point.text}"`
      return {
        text: bounded(`Hovered ${label} at ${Math.round(point.x)},${Math.round(point.y)}.\n`
          + `Page: ${session.getState().title === '' ? session.getState().url : `${session.getState().title} — ${session.getState().url}`}`
          + `${consoleDelta(session, before)}${dialogNote(session)}`),
      }
    },
  })

  registerTool({
    name: 'browser_drag',
    description: 'Drag from one element to another with the left mouse button. Pass refs or selectors for both endpoints. '
      + 'This is a mouse drag, so native HTML5 drag-and-drop may not fire drag events.',
    parameters: {
      fromRef: { type: 'string', description: 'Element handle to drag from.' },
      fromSelector: { type: 'string', description: 'CSS selector to drag from, when no ref is known.' },
      toRef: { type: 'string', description: 'Element handle to drop on.' },
      toSelector: { type: 'string', description: 'CSS selector to drop on, when no ref is known.' },
      steps: { type: 'integer', description: 'Mouse moves between the endpoints; defaults to 10, maximum 40.' },
    },
    output: commonOutput,
    presentCall() {
      return { card: 'generic', title: 'Drag an element', kind: 'edit' }
    },
    async execute(args) {
      const from = { ref: optionalString(args, 'fromRef'), selector: optionalString(args, 'fromSelector') }
      const to = { ref: optionalString(args, 'toRef'), selector: optionalString(args, 'toSelector') }
      if (from.ref === undefined && from.selector === undefined) throw new Error('pass fromRef or fromSelector')
      if (to.ref === undefined && to.selector === undefined) throw new Error('pass toRef or toSelector')
      const before = session.readConsole({ limit: 1 }).total
      const result = await session.drag({ from, to, steps: optionalNumber(args, 'steps') })
      const name = (point) => point.text === '' ? `${Math.round(point.x)},${Math.round(point.y)}` : `"${point.text}"`
      return {
        text: bounded(`Dragged from ${name(result.from)} to ${name(result.to)} `
          + `(${Math.round(result.to.x - result.from.x)},${Math.round(result.to.y - result.from.y)}).\n`
          + `Page: ${session.getState().title === '' ? session.getState().url : `${session.getState().title} — ${session.getState().url}`}`
          + `${consoleDelta(session, before)}${dialogNote(session)}`),
      }
    },
  })

  registerTool({
    name: 'browser_type',
    description: 'Focus a field, replace its content with the given text, and optionally submit with Enter. '
      + 'Works with React-controlled inputs because the text is typed, not assigned.',
    parameters: {
      ...targetParams,
      text: { type: 'string', required: true, description: 'Text to enter; pass an empty string to only clear.' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
      clear: { type: 'boolean', description: 'Clear the field first; typing already replaces the selected content.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Type into ${args.ref ?? args.selector ?? 'field'}`, kind: 'edit' }
    },
    async execute(args, exec, activity) {
      const text = typeof args.text === 'string' ? args.text : ''
      const before = session.readConsole({ limit: 1 }).total
      const typed = await session.type({
        ref: optionalString(args, 'ref'),
        selector: optionalString(args, 'selector'),
        text,
        submit: args.submit === true,
        clear: args.clear === true,
      })
      if (typed !== null && typeof typed.label === 'string' && typed.label !== '') {
        activity?.annotate?.({ targetLabel: typed.label })
      }
      const state = session.getState()
      return {
        text: bounded(`Typed ${JSON.stringify(text)}${args.submit === true ? ' and pressed Enter' : ''}.\n`
          + `Page: ${state.title === '' ? state.url : `${state.title} — ${state.url}`}${consoleDelta(session, before)}${dialogNote(session)}`),
      }
    },
  })

  registerTool({
    name: 'browser_key',
    description: 'Send one key or chord to the page: Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space, Control+A, and so on.',
    parameters: {
      key: { type: 'string', required: true, description: 'Key or chord, such as Enter or Control+A.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Press ${args.key}`, kind: 'edit' }
    },
    async execute(args) {
      const key = requireString(args, 'key')
      const before = session.readConsole({ limit: 1 }).total
      await session.press(key)
      return { text: bounded(`Pressed ${key}.${consoleDelta(session, before)}${dialogNote(session)}`) }
    },
  })

  registerTool({
    name: 'browser_wait_for',
    description: 'Wait until the page is ready before the next action. Conditions are ANDed: visible text (case-insensitive by default), '
      + 'a CSS selector that exists and is visible, a URL (exact or with * wildcards), and/or network idle (no requests in flight for 500 ms). '
      + 'Supply at least one condition; returns as soon as all supplied conditions hold, otherwise fails with the current page state.',
    parameters: {
      text: { type: 'string', description: 'Visible text to wait for; case-insensitive unless caseSensitive is true.' },
      selector: { type: 'string', description: 'CSS selector that must exist and be visible.' },
      url: { type: 'string', description: 'URL to wait for: exact match, or a pattern with * wildcards.' },
      networkIdle: { type: 'boolean', description: 'Wait until no requests are in flight for 500 ms.' },
      caseSensitive: { type: 'boolean', description: 'Match text case-sensitively; defaults to false.' },
      timeoutMs: { type: 'integer', description: 'Maximum wait in milliseconds; defaults to 10000, maximum 60000.' },
    },
    output: commonOutput,
    presentCall() {
      return { card: 'generic', title: 'Wait for the page', kind: 'read' }
    },
    async execute(args) {
      const text = optionalString(args, 'text')
      const selector = optionalString(args, 'selector')
      const url = optionalString(args, 'url')
      const networkIdle = args.networkIdle === true
      if (text === undefined && selector === undefined && url === undefined && !networkIdle) {
        throw new Error('browser_wait_for needs at least one of "text", "selector", "url", or "networkIdle"')
      }
      const result = await session.waitFor({
        text,
        selector,
        url,
        networkIdle,
        caseSensitive: args.caseSensitive === true,
        timeoutMs: optionalNumber(args, 'timeoutMs'),
      })
      const wanted = []
      if (text !== undefined) wanted.push(`text "${text}"`)
      if (selector !== undefined) wanted.push(`selector ${selector}`)
      if (url !== undefined) wanted.push(`URL ${url}`)
      if (networkIdle) wanted.push('network idle')
      return {
        text: bounded(`Waited ${result.elapsedMs}ms; all conditions are met.\n`
          + `Conditions: ${wanted.join(' + ')}\n`
          + `URL: ${result.url === '' ? '(empty)' : result.url}`
          + (result.title === '' ? '' : `\nTitle: ${result.title}`)),
      }
    },
  })

  registerTool({
    name: 'browser_handle_dialog',
    description: 'Answer a JavaScript alert, confirm, or prompt that is waiting under dialogBehavior "manual". '
      + 'With the default "dismiss" policy dialogs are answered automatically, so this tool reports that nothing is waiting. '
      + 'Use accept true for OK/confirm, false for Cancel/dismiss; promptText fills an accepted prompt.',
    parameters: {
      accept: { type: 'boolean', description: 'true accepts (OK), false dismisses (Cancel). Defaults to false.' },
      promptText: { type: 'string', description: 'Text to enter when accepting a prompt dialog.' },
    },
    output: commonOutput,
    presentCall() {
      return { card: 'generic', title: 'Answer the browser dialog', kind: 'edit' }
    },
    async execute(args) {
      const result = await session.handleDialog({
        accept: args.accept === true,
        promptText: optionalString(args, 'promptText'),
      })
      return {
        text: bounded(`${result.accepted ? 'Accepted' : 'Dismissed'} ${result.type} dialog: ${result.message}`),
      }
    },
  })

  registerTool({
    name: 'browser_scroll',
    description: 'Scroll the page, or bring one element into view.',
    parameters: {
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction; defaults to down.' },
      amount: { type: 'number', description: 'Number of wheel steps between 0.25 and 10; defaults to 1.' },
      ref: { type: 'string', description: 'Scroll this element into view instead.' },
      selector: { type: 'string', description: 'CSS selector to scroll into view instead.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Scroll ${args.direction ?? 'down'}`, kind: 'other' }
    },
    async execute(args) {
      await session.scroll({
        direction: args.direction,
        amount: optionalNumber(args, 'amount'),
        ref: optionalString(args, 'ref'),
        selector: optionalString(args, 'selector'),
      })
      const target = optionalString(args, 'ref') ?? optionalString(args, 'selector')
      const where = target === undefined ? ` ${args.direction ?? 'down'}` : ` to ${target}`
      return { text: bounded(`Scrolled${where}.`) }
    },
  })

  registerTool({
    name: 'browser_eval',
    description: 'Evaluate a JavaScript expression in the page and return its JSON value. '
      + 'Use it for state a snapshot does not show, such as computed styles, layout boxes, or localStorage.',
    parameters: {
      expression: { type: 'string', required: true, description: 'JavaScript expression; promises are awaited.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Evaluate in page`, kind: 'other' }
    },
    async execute(args) {
      const expression = requireString(args, 'expression')
      const value = await session.evaluate(expression)
      let rendered
      try {
        rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value)
      } catch {
        rendered = String(value)
      }
      return { text: bounded(`Result:\n${rendered}`) }
    },
  })

  registerTool({
    name: 'browser_console',
    description: 'Return recent console messages, uncaught page errors, and failed requests. Read it after load or an action to find why the interface broke.',
    parameters: {
      limit: { type: 'integer', description: 'Entries to return; defaults to 40, maximum 200.' },
    },
    output: commonOutput,
    presentCall() {
      return { card: 'generic', title: 'Read browser console', kind: 'read' }
    },
    async execute(args) {
      const read = session.readConsole({ limit: optionalNumber(args, 'limit') ?? 40 })
      if (read.entries.length === 0) {
        return { text: `No console output recorded yet (${read.total} entries total).` }
      }
      const lines = read.entries.map((entry) => {
        const where = entry.url === '' ? '' : `  (${entry.url})`
        return `[${entry.level}] ${entry.text}${where}`
      })
      return {
        text: bounded(`Console, ${read.entries.length} of ${read.total} entries (${read.errorCount} errors):\n${lines.join('\n')}`),
      }
    },
  })

  registerTool({
    name: 'browser_screenshot',
    description: 'Capture the page as an image: the viewport by default, or the whole page.',
    parameters: {
      fullPage: { type: 'boolean', description: 'Capture the entire scrollable page instead of the viewport.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: args.fullPage === true ? 'Screenshot the full page' : 'Screenshot the page', kind: 'read' }
    },
    async execute(args) {
      const state = session.getState()
      const png = await session.capture({ format: 'png', fullPage: args.fullPage === true, maxDimension: 1600 })
      const image = await attachImage(ctx, png, 'browser-shot.png')
      const path = await session.saveScreenshot(png)
      const size = image === null ? '' : `${image.width}x${image.height} px`
      const value = {
        text: bounded(`Screenshot of ${state.title === '' ? state.url : `${state.title} — ${state.url}`}${size === '' ? '' : ` (${size})`}.`),
      }
      if (image !== null) value.image = image
      if (path !== null) value.path = path
      return value
    },
  })

  registerTool({
    name: 'browser_resize',
    description: 'Set the page viewport size to check a layout at another width, such as a phone.',
    parameters: {
      width: { type: 'integer', required: true, description: 'Viewport width in CSS pixels, 320 to 3840.' },
      height: { type: 'integer', required: true, description: 'Viewport height in CSS pixels, 240 to 2160.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Resize to ${args.width}x${args.height}`, kind: 'other' }
    },
    async execute(args) {
      const state = await session.resize({ width: requireNumber(args, 'width'), height: requireNumber(args, 'height') })
      return { text: `Viewport is now ${state.viewport.width}x${state.viewport.height}.` }
    },
  })

  registerTool({
    name: 'browser_close',
    description: 'Close the controlled browser. The next browser tool starts a fresh one.',
    parameters: {},
    output: commonOutput,
    presentCall() {
      return { card: 'generic', title: 'Close the browser', kind: 'other' }
    },
    async execute() {
      await session.close()
      return { text: 'The controlled browser is closed.' }
    },
  })
}

function requireNumber(args, key) {
  const value = args?.[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`"${key}" must be a number`)
  return value
}
