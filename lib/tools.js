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

const ERROR_HINTS = [
  [/reference .*not found|ref .*not found|unknown ref|ref .*expired|stale ref|ref .*no longer/i, 'Re-run browser_snapshot and use a fresh ref, or target the element with role=, text=, label=, or testid=.'],
  [/multiple|ambiguous|more than one/i, 'Narrow the target to a unique locator (for example role=button[name="Save"], text=..., or a CSS selector); browser_snapshot lists candidates.'],
  [/not visible|hidden|zero size|has no layout/i, 'Scroll it into view or wait for it to appear, then re-snapshot; browser_highlight shows where it is.'],
  [/covered|intercept|obscured|another element/i, 'Close or move the covering element, or highlight the target to see the overlap; browser_click has a coordinate fallback when the normal click is blocked.'],
  [/allowlist|allowedhosts|navigation.*not allowed|file url|file:\/\//i, 'Add the host to allowedHosts or set allowFileUrls: true in the plugin config, then retry. Loopback hosts are always allowed.'],
  [/dialog/i, 'Call browser_handle_dialog (accept/dismiss/prompt) or set dialogBehavior to accept before the action.'],
  [/timed out|timeout/i, 'Raise timeoutMs, use waitUntil: "networkIdle" for slow apps, or check browser_console and browser_network for a stuck request.'],
  [/target closed|page crashed|not attached|detached|inspector.targetcrashed/i, 'Call browser_open or browser_tabs to pick a live page; a crashed page is replaced on the next tool call.'],
  [/browser.*not running|not started|no browser|chrome.*exited/i, 'Call browser_open first; it starts the controlled Chrome on demand.'],
  [/enoent|no such file|upload|file input/i, 'Check that the upload path exists and is readable, then retry with browser_upload_file.'],
  [/not found|no element|no match|cannot find|queryselector/i, 'Re-run browser_snapshot to see the current elements, or use a role=/text=/label= locator instead of a stale selector.'],
]

/**
 * Append one actionable suggestion to a failed tool call. False assertions are
 * normal results and do not pass through here; this is only for thrown errors.
 * @param {unknown} error - the caught failure.
 * @returns {string} a short next step.
 */
export function nextStepForError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  for (const [pattern, hint] of ERROR_HINTS) {
    if (pattern.test(message)) return hint
  }
  return 'Re-run browser_snapshot for the current page; if the failure is still unclear, read browser_console and browser_network.'
}

/** Decorate a thrown error once, preserving its stack and avoiding repeated hints. */
function withNextStep(error) {
  const value = error instanceof Error ? error : new Error(String(error))
  if (/\nNext:/u.test(value.message)) return value
  value.message = `${value.message}\nNext: ${nextStepForError(value)}`
  return value
}

function formatBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value < 1024) return `${Math.round(value)}B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`
  return `${(value / (1024 * 1024)).toFixed(2)}MB`
}

function shortRequestId(value) {
  const id = String(value ?? '')
  return id.length <= 12 ? id : id.slice(-12)
}

function headerLines(headers) {
  const entries = Object.entries(headers ?? {})
  if (entries.length === 0) return '  (none)'
  return entries.map(([name, value]) => `  ${name}: ${value}`).join('\n')
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
  const snapshot = await session.snapshot({
    interactiveOnly: options.interactiveOnly === true,
    boxes: options.boxes === true,
    depth: options.depth,
    maxNodes: options.maxNodes,
  })
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
    `Interactive refs: ${snapshot.refs}${options.boxes === true ? ' (box=x,y,width,height)' : ''}`,
  ].join('\n'))
  sections.push([options.interactiveOnly === true ? 'Interactive elements:' : 'Outline:', ...shown, omitted > 0 ? `… (${omitted} more outline lines not shown; raise maxLines to read them)` : ''].join('\n'))
  if (snapshot.truncated) sections.push('… outline truncated at maxNodes; raise maxNodes, lower depth, or use interactiveOnly for a smaller view.')
  if (snapshot.text !== '') sections.push(`Visible text:\n${snapshot.text}`)
  else if (options.interactiveOnly === true) sections.push('Visible text omitted in interactive-only mode; call browser_snapshot without interactiveOnly to read it.')
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
 * Render a tab list for the model.
 * @param {{ current: string | null, tabs: Array<{ targetId: string, url: string, title: string }> }} list - tab list.
 * @returns {{ text: string }}
 */
function tabSummary(list) {
  const shown = list.tabs.slice(0, 30)
  const lines = shown.map((tab) => {
    const marker = tab.targetId === list.current ? '*' : '-'
    const owner = typeof tab.sessionId === 'string' ? ` [session=${tab.sessionId.slice(0, 8)}]` : ''
    return `${marker} ${tab.title === '' ? '(untitled)' : tab.title} — ${tab.url} [targetId=${tab.targetId}]${owner}`
  })
  const more = list.tabs.length > shown.length ? `\n… (${list.tabs.length - shown.length} more tabs)` : ''
  return {
    text: bounded(`Pages (${list.tabs.length}), current ${list.current ?? '(none)'}:\n${lines.join('\n')}${more}`),
  }
}

/**
 * Parse a file-path list: JSON array, or one path per line.
 * @param {unknown} raw - tool argument.
 * @returns {string[]}
 */
function parseFileList(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed.map((file) => String(file).trim()).filter((file) => file !== '')
    } catch {
      // Fall back to newline-separated paths.
    }
  }
  return text.split(/\r?\n/u).map((file) => file.trim()).filter((file) => file !== '')
}

/**
 * Count fields in the browser_fill_form JSON argument.
 * @param {unknown} raw - the fields JSON string.
 * @returns {number}
 */
function countFormFields(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? ''))
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
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
      target: typeof args.target === 'string'
        ? args.target
        : typeof args.ref === 'string'
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
    detail: (args) => ({ target: typeof args.target === 'string' ? args.target : typeof args.ref === 'string' ? args.ref : typeof args.selector === 'string' ? args.selector : '' }),
  },
  browser_drag: {
    kind: 'drag',
    thumb: true,
    detail: (args) => ({
      from: typeof args.fromRef === 'string' ? args.fromRef : typeof args.fromSelector === 'string' ? args.fromSelector : '',
      to: typeof args.toRef === 'string' ? args.toRef : typeof args.toSelector === 'string' ? args.toSelector : '',
    }),
  },
  browser_fill_form: { kind: 'fill-form', thumb: true, detail: (args) => ({ count: countFormFields(args.fields) }) },
  browser_select: {
    kind: 'select',
    thumb: true,
    detail: (args) => ({
      target: typeof args.target === 'string'
        ? args.target
        : typeof args.ref === 'string'
          ? args.ref
          : typeof args.selector === 'string' ? args.selector : '',
      value: args.value ?? args.label ?? args.index ?? '',
    }),
  },
  browser_upload_file: { kind: 'upload', thumb: true, detail: (args) => ({ count: parseFileList(args.files).length }) },
  browser_tabs: {
    kind: 'tabs',
    thumb: false,
    detail: (args) => ({ action: typeof args.action === 'string' ? args.action : 'list' }),
  },
  browser_type: {
    kind: 'type',
    thumb: true,
    detail: (args) => ({
      target: typeof args.target === 'string'
        ? args.target
        : typeof args.ref === 'string'
          ? args.ref
          : typeof args.selector === 'string' ? args.selector : '',
      text: typeof args.secret === 'string'
        ? `[secret:${args.secret}]`
        : typeof args.text === 'string' ? args.text.slice(0, 80) : '',
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
  browser_assert: {
    kind: 'assert',
    thumb: false,
    detail: (args) => ({
      condition: typeof args.condition === 'string' ? args.condition : '',
      target: typeof args.target === 'string' ? args.target.slice(0, 60) : '',
      text: typeof args.text === 'string' ? args.text.slice(0, 60) : '',
      value: typeof args.value === 'string' ? args.value.slice(0, 40) : '',
    }),
  },
  browser_network: {
    kind: 'network',
    thumb: false,
    detail: (args) => ({
      action: typeof args.action === 'string' ? args.action : 'list',
      url: typeof args.url === 'string' ? args.url.slice(0, 60) : '',
      requestId: typeof args.requestId === 'string' ? args.requestId.slice(-12) : '',
    }),
  },
  browser_styles: {
    kind: 'styles',
    thumb: false,
    detail: (args) => ({
      target: typeof args.target === 'string'
        ? args.target.slice(0, 60)
        : typeof args.ref === 'string'
          ? args.ref
          : typeof args.selector === 'string' ? args.selector.slice(0, 60) : '',
    }),
  },
  browser_emulate: {
    kind: 'emulate',
    thumb: true,
    detail: (args) => ({
      network: typeof args.network === 'string' ? args.network : '',
      colorScheme: typeof args.colorScheme === 'string' ? args.colorScheme : '',
      mobile: args.mobile === true,
      clear: args.clear === true,
    }),
  },
  browser_performance: { kind: 'performance', thumb: false, detail: () => ({}) },
  browser_highlight: {
    kind: 'highlight',
    thumb: true,
    detail: (args) => ({
      target: typeof args.target === 'string' ? args.target.slice(0, 60) : typeof args.ref === 'string' ? args.ref : typeof args.selector === 'string' ? args.selector.slice(0, 60) : '',
    }),
  },
  browser_route: {
    kind: 'route',
    thumb: false,
    detail: (args) => ({
      action: typeof args.action === 'string' ? args.action : 'list',
      urlPattern: typeof args.urlPattern === 'string' ? args.urlPattern.slice(0, 60) : '',
    }),
  },
  browser_cookies: {
    kind: 'cookies',
    thumb: false,
    detail: (args) => ({ action: typeof args.action === 'string' ? args.action : 'list' }),
  },
  browser_storage: {
    kind: 'storage',
    thumb: false,
    detail: (args) => ({
      action: typeof args.action === 'string' ? args.action : 'list',
      type: args.type === 'session' ? 'session' : 'local',
    }),
  },
  browser_download: {
    kind: 'download',
    thumb: false,
    detail: (args) => ({ action: typeof args.action === 'string' ? args.action : 'list' }),
  },
  browser_handle_dialog: { kind: 'dialog', thumb: false, detail: (args) => ({ accept: args.accept === true }) },
  browser_scroll: {
    kind: 'scroll',
    thumb: true,
    detail: (args) => ({
      direction: typeof args.direction === 'string' ? args.direction : 'down',
      target: typeof args.target === 'string'
        ? args.target
        : typeof args.ref === 'string'
          ? args.ref
          : typeof args.selector === 'string' ? args.selector : '',
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
    target: {
      type: 'string',
      description: 'Locator string: role=button[name="Save"], text=Save, label=Email, placeholder=Email, testid=value, css=#main, or ref=e12. Prefer this over guessing a CSS selector.',
    },
    ref: { type: 'string', description: 'Element handle from the latest snapshot, such as e12.' },
    selector: { type: 'string', description: 'CSS selector, used when no ref or target is known.' },
  }

  /** Scrub configured secrets from a recorded activity detail. */
  const scrubDetail = (detail) => {
    if (typeof session.redact !== 'function') return detail
    const out = {}
    for (const [key, value] of Object.entries(detail ?? {})) {
      out[key] = typeof value === 'string' ? session.redact(value) : value
    }
    return out
  }

  /**
   * Convert the authoring parameter map into raw JSON Schema, the shape the
   * host forwards to the model as `input_schema`.
   *
   * The map form (`{ name: { type, description, required } }`) is what
   * `defineTool` accepts; `ctx.tools.register` expects the compiled schema.
   * Passing the map through unchanged puts `required: true` and every
   * parameter name at the schema root, where JSON Schema reads them as its own
   * keywords: a parameter named `title` becomes the root `title` annotation
   * and strict providers reject the whole tool list for that one key.
   * @param {Record<string, { required?: boolean }>} [parameters] - authoring map.
   * @returns {object} object-rooted JSON Schema.
   */
  const parametersToJsonSchema = (parameters) => {
    const properties = {}
    const required = []
    for (const [name, spec] of Object.entries(parameters ?? {})) {
      const { required: isRequired, ...schema } = spec
      properties[name] = schema
      if (isRequired === true) required.push(name)
    }
    return {
      type: 'object',
      properties,
      ...required.length > 0 ? { required } : {},
    }
  }

  /** Wrap one definition so the panel records its start, result, page, and a thumbnail. */
  const registerTool = (definition) => {
    const spec = ACTIVITY_SPECS[definition.name] ?? { kind: 'other', thumb: false, detail: () => ({}) }
    const original = definition.execute
    definition.execute = async (args, exec) => {
      const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : null
      const before = session.getState()
      const handle = activity.begin({
        tool: definition.name,
        source: 'agent',
        kind: spec.kind,
        detail: scrubDetail(spec.detail(args ?? {})),
        errorCount: before.errorCount,
        sessionId,
      })
      try {
        const value = await session.runExclusive(async () => {
          const skipsSession = definition.name === 'browser_tabs' || definition.name === 'browser_close'
          if (!skipsSession) await session.enterSession(sessionId)
          const result = await original(args, exec, handle)
          if (!skipsSession) session.claimCurrentTab(sessionId)
          return result
        })
        const after = session.getState()
        const thumbnail = spec.thumb ? await captureThumbnail(session) : null
        activity.finish(handle, { status: 'ok', page: after, errorCount: after.errorCount, thumbnail })
        return value
      } catch (error) {
        const after = session.getState()
        const thumbnail = spec.thumb ? await captureThumbnail(session) : null
        const message = error instanceof Error ? error.message : String(error)
        activity.finish(handle, {
          status: 'error',
          error: session.redact(message),
          page: after,
          errorCount: after.errorCount,
          thumbnail,
        })
        const decorated = withNextStep(error)
        decorated.message = session.redact(decorated.message)
        throw decorated
      }
    }
    ctx.tools.register({ ...definition, parameters: parametersToJsonSchema(definition.parameters) })
  }

  registerTool({
    name: 'browser_open',
    description: 'Open a URL in the controlled Chrome and return the page outline, visible text, and a screenshot. '
      + 'Starts a headless browser on first use. Waits for the load event by default; use waitUntil "networkIdle" for apps that keep loading, '
      + 'or "none" to navigate without waiting.',
    parameters: {
      url: { type: 'string', required: true, description: 'Address such as http://localhost:3000/ or localhost:5173.' },
      maxLines: { type: 'integer', description: 'Outline lines to return; defaults to 220, maximum 700.' },
      boxes: { type: 'boolean', description: 'Add [box=x,y,width,height] viewport coordinates to interactive refs.' },
      depth: { type: 'integer', description: 'Maximum accessibility-tree depth; defaults to 50.' },
      maxNodes: { type: 'integer', description: 'Maximum outline nodes before truncation; defaults to 700, maximum 2000.' },
      waitUntil: { type: 'string', enum: ['load', 'networkIdle', 'none'], description: 'Navigation wait; defaults to load.' },
      timeoutMs: { type: 'integer', description: 'Navigation timeout in milliseconds; defaults to 15000, maximum 60000.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Open ${args.url}`, kind: 'fetch' }
    },
    async execute(args) {
      const url = requireString(args, 'url')
      await openTarget(session, resolveTarget, url, {
        waitUntil: args.waitUntil,
        timeoutMs: optionalNumber(args, 'timeoutMs'),
      })
      return readPage(session, ctx, {
        maxLines: optionalNumber(args, 'maxLines'),
        boxes: args.boxes === true,
        depth: optionalNumber(args, 'depth'),
        maxNodes: optionalNumber(args, 'maxNodes'),
        lead: `Opened ${url}.`,
      })
    },
  })

  registerTool({
    name: 'browser_snapshot',
    description: 'Read the page that is already open: interactive elements with [ref=…] handles and control state '
      + '(checked, disabled, value, selected, expanded), visible text, and a screenshot. '
      + 'Use interactiveOnly for a compact action list without static content or visible text.',
    parameters: {
      maxLines: { type: 'integer', description: 'Outline lines to return; defaults to 220, maximum 700.' },
      interactiveOnly: { type: 'boolean', description: 'Only interactive elements with refs and state; omits static content and visible text.' },
      boxes: { type: 'boolean', description: 'Add [box=x,y,width,height] viewport coordinates to interactive refs.' },
      depth: { type: 'integer', description: 'Maximum accessibility-tree depth; defaults to 50.' },
      maxNodes: { type: 'integer', description: 'Maximum outline nodes before truncation; defaults to 700, maximum 2000.' },
    },
    output: commonOutput,
    presentCall() {
      return { card: 'generic', title: 'Read the browser page', kind: 'read' }
    },
    async execute(args) {
      return readPage(session, ctx, {
        maxLines: optionalNumber(args, 'maxLines'),
        interactiveOnly: args.interactiveOnly === true,
        boxes: args.boxes === true,
        depth: optionalNumber(args, 'depth'),
        maxNodes: optionalNumber(args, 'maxNodes'),
      })
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
      const target = optionalString(args, 'target')
      const ref = optionalString(args, 'ref')
      const selector = optionalString(args, 'selector')
      const x = optionalNumber(args, 'x')
      const y = optionalNumber(args, 'y')
      const hasPoint = x !== undefined || y !== undefined
      if (hasPoint && (x === undefined || y === undefined)) throw new Error('pass both x and y, or neither')
      if (hasPoint && (target !== undefined || ref !== undefined || selector !== undefined)) throw new Error('pass either target/ref/selector or x/y, not both')
      if (!hasPoint && target === undefined && ref === undefined && selector === undefined) throw new Error('pass target, ref, selector, or both x and y')
      const before = session.readConsole({ limit: 1 }).total
      const point = hasPoint
        ? await session.clickAt({ x, y, button: args.button, clickCount: optionalNumber(args, 'clickCount') })
        : await session.click({ target, ref, selector }, { button: args.button, clickCount: optionalNumber(args, 'clickCount') })
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
      const point = await session.hover({
        target: optionalString(args, 'target'),
        ref: optionalString(args, 'ref'),
        selector: optionalString(args, 'selector'),
      })
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
      fromTarget: { type: 'string', description: 'Locator string to drag from, such as text=Card or role=button[name="Move"].' },
      fromRef: { type: 'string', description: 'Element handle to drag from.' },
      fromSelector: { type: 'string', description: 'CSS selector to drag from, when no ref is known.' },
      toTarget: { type: 'string', description: 'Locator string to drop on.' },
      toRef: { type: 'string', description: 'Element handle to drop on.' },
      toSelector: { type: 'string', description: 'CSS selector to drop on, when no ref is known.' },
      steps: { type: 'integer', description: 'Mouse moves between the endpoints; defaults to 10, maximum 40.' },
    },
    output: commonOutput,
    presentCall() {
      return { card: 'generic', title: 'Drag an element', kind: 'edit' }
    },
    async execute(args) {
      const from = {
        target: optionalString(args, 'fromTarget'),
        ref: optionalString(args, 'fromRef'),
        selector: optionalString(args, 'fromSelector'),
      }
      const to = {
        target: optionalString(args, 'toTarget'),
        ref: optionalString(args, 'toRef'),
        selector: optionalString(args, 'toSelector'),
      }
      const has = (entry) => entry.target !== undefined || entry.ref !== undefined || entry.selector !== undefined
      if (!has(from)) throw new Error('pass fromTarget, fromRef, or fromSelector')
      if (!has(to)) throw new Error('pass toTarget, toRef, or toSelector')
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
    description: 'Focus a field, replace or append its content, and optionally submit with Enter. '
      + 'Works with React-controlled inputs because the text is typed, not assigned. '
      + 'Pass secret instead of text to type a configured secret; the secret is only allowed on its configured domains.',
    parameters: {
      ...targetParams,
      text: { type: 'string', description: 'Text to enter; pass an empty string to only clear.' },
      secret: { type: 'string', description: 'Name of a configured secret to type instead of text; the raw value never enters the tool result.' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
      clear: { type: 'boolean', description: 'Clear the field first; typing already replaces the selected content.' },
      append: { type: 'boolean', description: 'Append after the current value instead of replacing it.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Type into ${args.ref ?? args.selector ?? 'field'}`, kind: 'edit' }
    },
    async execute(args, exec, activity) {
      let text = typeof args.text === 'string' ? args.text : ''
      if (args.secret !== undefined) {
        if (text !== '') throw new Error('pass text or secret, not both')
        text = session.secretValue(args.secret)
      } else if (typeof args.text !== 'string') {
        throw new Error('browser_type needs text or secret')
      }
      if (args.append === true && args.clear === true) throw new Error('pass either append or clear, not both')
      const before = session.readConsole({ limit: 1 }).total
      const typed = await session.type({
        target: optionalString(args, 'target'),
        ref: optionalString(args, 'ref'),
        selector: optionalString(args, 'selector'),
        text,
        submit: args.submit === true,
        clear: args.clear === true,
        append: args.append === true,
      })
      if (typed !== null && typeof typed.label === 'string' && typed.label !== '') {
        activity?.annotate?.({ targetLabel: typed.label })
      }
      const state = session.getState()
      const shown = args.secret !== undefined ? `[secret:${args.secret}]` : JSON.stringify(text)
      return {
        text: bounded(`${args.append === true ? 'Appended' : 'Typed'} ${shown}${args.submit === true ? ' and pressed Enter' : ''}.\n`
          + `Page: ${state.title === '' ? state.url : `${state.title} — ${state.url}`}${consoleDelta(session, before)}${dialogNote(session)}`),
      }
    },
  })

  registerTool({
    name: 'browser_fill_form',
    description: 'Fill several text fields in one call. Pass "fields" as a JSON array of objects: '
      + '[{"target":"label=Email","text":"a@b.c"},{"ref":"e3","text":"Ada","append":true}]. '
      + 'Each field needs target, ref, or selector and supports text (or value), append, and clear. '
      + 'Use browser_select for native <select> and browser_upload_file for file inputs.',
    parameters: {
      fields: { type: 'string', required: true, description: 'JSON array of {ref?, selector?, text, append?, clear?}.' },
    },
    output: commonOutput,
    presentCall() {
      return { card: 'generic', title: 'Fill a form', kind: 'edit' }
    },
    async execute(args) {
      const raw = requireString(args, 'fields')
      let fields
      try {
        fields = JSON.parse(raw)
      } catch {
        throw new Error('"fields" must be valid JSON')
      }
      if (!Array.isArray(fields) || fields.length === 0) throw new Error('"fields" must be a non-empty array')
      if (fields.length > 20) throw new Error('fill at most 20 fields at once')
      const before = session.readConsole({ limit: 1 }).total
      const results = await session.fillForm(fields)
      const lines = results.map((item, index) => `${index + 1}. ${item.label === '' ? item.target : item.label}`)
      return {
        text: bounded(`Filled ${results.length} fields:\n${lines.join('\n')}\n`
          + `Page: ${session.getState().title === '' ? session.getState().url : `${session.getState().title} — ${session.getState().url}`}`
          + `${consoleDelta(session, before)}${dialogNote(session)}`),
      }
    },
  })

  registerTool({
    name: 'browser_select',
    description: 'Choose an option in a native <select> by value, visible label, or zero-based index. '
      + 'This sets the value and fires input/change without opening the OS popup.',
    parameters: {
      ...targetParams,
      value: { type: 'string', description: 'Option value to choose.' },
      label: { type: 'string', description: 'Visible option label to choose, when the value is unknown.' },
      index: { type: 'integer', description: 'Zero-based option index.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Select ${args.value ?? args.label ?? '#index'}`, kind: 'edit' }
    },
    async execute(args) {
      const value = optionalString(args, 'value')
      const label = optionalString(args, 'label')
      const index = optionalNumber(args, 'index')
      if (value === undefined && label === undefined && index === undefined) {
        throw new Error('pass value, label, or index')
      }
      const before = session.readConsole({ limit: 1 }).total
      const result = await session.selectOption(
        { target: optionalString(args, 'target'), ref: optionalString(args, 'ref'), selector: optionalString(args, 'selector') },
        { value, label, index },
      )
      return {
        text: bounded(`Selected "${result.label}" (value "${result.value}", index ${result.index}).\n`
          + `Page: ${session.getState().title === '' ? session.getState().url : `${session.getState().title} — ${session.getState().url}`}`
          + `${consoleDelta(session, before)}${dialogNote(session)}`),
      }
    },
  })

  registerTool({
    name: 'browser_upload_file',
    description: 'Set files on a file input. Pass absolute paths separated by newlines (a JSON array is also accepted).',
    parameters: {
      ...targetParams,
      files: { type: 'string', required: true, description: 'Absolute file paths, one per line.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Upload ${parseFileList(args.files ?? '').length || ''} file(s)`, kind: 'edit' }
    },
    async execute(args) {
      const files = parseFileList(requireString(args, 'files'))
      if (files.length === 0) throw new Error('pass at least one file path')
      if (files.length > 10) throw new Error('upload at most 10 files at once')
      const before = session.readConsole({ limit: 1 }).total
      const result = await session.uploadFiles(
        { target: optionalString(args, 'target'), ref: optionalString(args, 'ref'), selector: optionalString(args, 'selector') },
        files,
      )
      return {
        text: bounded(`Uploaded ${result.count} file(s): ${result.names.join(', ')}.\n`
          + `Page: ${session.getState().title === '' ? session.getState().url : `${session.getState().title} — ${session.getState().url}`}`
          + `${consoleDelta(session, before)}${dialogNote(session)}`),
      }
    },
  })

  registerTool({
    name: 'browser_tabs',
    description: 'List, open, switch, or close pages in the controlled browser. '
      + 'New tabs opened by the current page are followed automatically unless followNewTabs is false.',
    parameters: {
      action: { type: 'string', enum: ['list', 'new', 'select', 'close'], required: true, description: 'What to do with the pages.' },
      url: { type: 'string', description: 'Address for a new tab; defaults to about:blank.' },
      targetId: { type: 'string', description: 'Target id from action list; required for select, optional for close.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Tabs: ${args.action ?? 'list'}`, kind: 'other' }
    },
    async execute(args) {
      const action = typeof args.action === 'string' ? args.action : 'list'
      if (!['list', 'new', 'select', 'close'].includes(action)) throw new Error('action must be list, new, select, or close')
      if (action === 'list') return tabSummary(await session.listTabs())
      if (action === 'new') {
        await session.newTab()
        const url = optionalString(args, 'url')
        if (url !== undefined) await openTarget(session, resolveTarget, url)
        return tabSummary(await session.listTabs())
      }
      if (action === 'select') {
        const targetId = requireString(args, 'targetId')
        return tabSummary(await session.selectTab(targetId))
      }
      const targetId = optionalString(args, 'targetId')
      return tabSummary(await session.closeTab(targetId))
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
    name: 'browser_assert',
    description: 'Check one fact about the page and return PASS or FAIL with the expected and actual values. '
      + 'The assertion polls until it passes or timeoutMs expires, and a failed check is a normal result (not a tool error). '
      + 'Use textVisible/textHidden for user-visible copy, elementVisible/elementHidden with target/ref/selector, '
      + 'value or checked for a form control, url/title for navigation, and count for how many elements match.',
    parameters: {
      condition: {
        type: 'string',
        required: true,
        enum: ['textVisible', 'textHidden', 'elementVisible', 'elementHidden', 'value', 'checked', 'url', 'title', 'count'],
        description: 'What to assert.',
      },
      target: { type: 'string', description: 'Locator string, such as role=button[name="Save"] or text=Saved.' },
      ref: { type: 'string', description: 'Element handle from the latest snapshot.' },
      selector: { type: 'string', description: 'CSS selector.' },
      text: { type: 'string', description: 'Text for textVisible/textHidden.' },
      value: { type: 'string', description: 'Expected value for condition value.' },
      checked: { type: 'boolean', description: 'Expected checked state for condition checked; defaults to true.' },
      url: { type: 'string', description: 'Expected URL for condition url; * wildcards are allowed.' },
      title: { type: 'string', description: 'Expected exact title for condition title.' },
      count: { type: 'integer', description: 'Expected number of matching elements for condition count.' },
      caseSensitive: { type: 'boolean', description: 'Match text case-sensitively; defaults to false.' },
      timeoutMs: { type: 'integer', description: 'How long to poll; defaults to 3000, maximum 15000.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Assert ${args.condition ?? 'page state'}`, kind: 'read' }
    },
    async execute(args) {
      const condition = requireString(args, 'condition')
      const hasTarget = optionalString(args, 'target') !== undefined
        || optionalString(args, 'ref') !== undefined
        || optionalString(args, 'selector') !== undefined
      const needTarget = () => {
        if (!hasTarget) throw new Error(`condition "${condition}" needs target, ref, or selector`)
      }
      switch (condition) {
        case 'textVisible':
        case 'textHidden':
          requireString(args, 'text')
          break
        case 'elementVisible':
        case 'elementHidden':
          needTarget()
          break
        case 'value':
          needTarget()
          if (typeof args.value !== 'string') throw new Error('condition "value" needs a string value')
          break
        case 'checked':
          needTarget()
          if (args.checked !== undefined && typeof args.checked !== 'boolean') throw new Error('"checked" must be a boolean')
          break
        case 'url':
          requireString(args, 'url')
          break
        case 'title':
          requireString(args, 'title')
          break
        case 'count':
          needTarget()
          if (!Number.isInteger(args.count) || args.count < 0) throw new Error('condition "count" needs a non-negative integer count')
          break
        default:
          throw new Error(`unknown condition "${condition}"`)
      }
      const result = await session.assert({
        condition,
        target: optionalString(args, 'target'),
        ref: optionalString(args, 'ref'),
        selector: optionalString(args, 'selector'),
        text: optionalString(args, 'text'),
        value: typeof args.value === 'string' ? args.value : undefined,
        checked: typeof args.checked === 'boolean' ? args.checked : undefined,
        url: optionalString(args, 'url'),
        title: optionalString(args, 'title'),
        count: Number.isInteger(args.count) ? args.count : undefined,
        caseSensitive: args.caseSensitive === true,
        timeoutMs: optionalNumber(args, 'timeoutMs'),
      })
      const lines = [
        `${result.ok ? 'PASS' : 'FAIL'} ${result.label} (${result.elapsedMs}ms)`,
        `Expected: ${result.expected}`,
        `Actual: ${result.actual}`,
      ]
      if (!result.ok) lines.push('This is a failed check, not a protocol error; adjust the page or the expectation and assert again.')
      return { text: bounded(lines.join('\n')) }
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
      ...targetParams,
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Scroll ${args.direction ?? 'down'}`, kind: 'other' }
    },
    async execute(args) {
      await session.scroll({
        direction: args.direction,
        amount: optionalNumber(args, 'amount'),
        target: optionalString(args, 'target'),
        ref: optionalString(args, 'ref'),
        selector: optionalString(args, 'selector'),
      })
      const target = optionalString(args, 'target') ?? optionalString(args, 'ref') ?? optionalString(args, 'selector')
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
      maxChars: { type: 'integer', description: 'Maximum result characters; defaults to 6000, maximum 20000. Large values are truncated with a marker.' },
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
      const maxChars = clamp(optionalNumber(args, 'maxChars') ?? 6000, 500, 20000)
      return { text: bounded(`Result:\n${rendered}`, maxChars) }
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
    name: 'browser_network',
    description: 'Inspect requests the page made: list recent requests with status, type, duration, size, and URL; '
      + 'read one request\'s headers (credentials redacted) and optionally its response body. '
      + 'Use it to debug failed APIs, missing assets, or slow requests.',
    parameters: {
      action: { type: 'string', enum: ['list', 'detail'], description: 'list (default) or detail for one request.' },
      requestId: { type: 'string', description: 'Request id, or its unique suffix, from action list; required for detail.' },
      url: { type: 'string', description: 'Only requests whose URL contains this text.' },
      method: { type: 'string', description: 'Only this HTTP method, such as GET or POST.' },
      status: { type: 'integer', description: 'Only this HTTP status code, such as 404.' },
      type: { type: 'string', description: 'Only this resource type, such as document, xhr, fetch, script, stylesheet, image.' },
      failedOnly: { type: 'boolean', description: 'Only requests that failed at the network layer.' },
      limit: { type: 'integer', description: 'Maximum list rows; defaults to 50, maximum 200.' },
      includeBody: { type: 'boolean', description: 'For detail: also return the response body (bounded).' },
      bodyLimit: { type: 'integer', description: 'Maximum body characters for detail; defaults to 4096, maximum 32000.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: args.action === 'detail' ? 'Inspect request' : 'List network requests', kind: 'read' }
    },
    async execute(args) {
      const action = args.action === 'detail' ? 'detail' : 'list'
      if (action === 'detail') {
        const requestId = requireString(args, 'requestId')
        const detail = await session.networkDetail(requestId, {
          includeBody: args.includeBody === true,
          bodyLimit: optionalNumber(args, 'bodyLimit'),
        })
        const lines = [
          `Request ${detail.id}`,
          `${detail.method} ${detail.url}`,
          `Status: ${detail.failed ? 'FAILED' : detail.status ?? 'pending'}${detail.statusText === '' ? '' : ` ${detail.statusText}`}`,
          `Type: ${detail.resourceType === '' ? 'unknown' : detail.resourceType}${detail.mimeType === '' ? '' : ` (${detail.mimeType})`}`,
          `Duration: ${detail.durationMs === null ? 'in flight' : `${detail.durationMs}ms`}; size: ${formatBytes(detail.size)}${detail.fromCache ? '; from cache' : ''}`,
          `Failed: ${detail.failed ? detail.errorText || 'yes' : 'no'}`,
          '',
          'Request headers:',
          headerLines(detail.requestHeaders),
          '',
          'Response headers:',
          headerLines(detail.responseHeaders),
        ]
        if (detail.body !== undefined) {
          lines.push('', 'Response body:')
          if (detail.body.unavailable === true) lines.push(`  unavailable: ${detail.body.error}`)
          else {
            lines.push(`  (${formatBytes(detail.body.bytes)}${detail.body.truncated ? ', truncated' : ''}${detail.body.base64Encoded ? ', decoded' : ''})`)
            lines.push(detail.body.text)
          }
        }
        return { text: bounded(lines.join('\n')) }
      }
      const read = session.readNetwork({
        url: optionalString(args, 'url'),
        method: optionalString(args, 'method'),
        status: Number.isInteger(args.status) ? args.status : undefined,
        type: optionalString(args, 'type'),
        failedOnly: args.failedOnly === true,
        limit: optionalNumber(args, 'limit'),
      })
      if (read.entries.length === 0) {
        return { text: `No matching requests (${read.total} tracked).` }
      }
      const lines = read.entries.map((entry) => {
        const status = entry.failed ? 'FAILED' : entry.status ?? 'pending'
        const duration = entry.durationMs === null ? '…' : `${entry.durationMs}ms`
        return `[${shortRequestId(entry.id)}] ${entry.method} ${status} ${entry.resourceType || 'other'} ${duration} ${formatBytes(entry.size)} ${entry.url}`
      })
      return {
        text: bounded(`Network, ${read.entries.length} of ${read.matched} matched (${read.total} tracked; newest first):\n${lines.join('\n')}\n\nUse action detail with a requestId for headers and body.`),
      }
    },
  })

  registerTool({
    name: 'browser_styles',
    description: 'Read an element\'s computed styles and matched CSS rules (selector, origin, and declarations). '
      + 'Use it to debug why an element looks wrong, instead of guessing from the screenshot.',
    parameters: {
      ...targetParams,
      properties: { type: 'string', description: 'Comma or space separated CSS properties; omit for a curated layout/typography/color set; use * for all computed properties.' },
      rules: { type: 'boolean', description: 'Include matched CSS rules; defaults to true.' },
    },
    output: commonOutput,
    presentCall() {
      return { card: 'generic', title: 'Inspect element styles', kind: 'read' }
    },
    async execute(args) {
      if (optionalString(args, 'target') === undefined && optionalString(args, 'ref') === undefined && optionalString(args, 'selector') === undefined) {
        throw new Error('browser_styles needs target, ref, or selector')
      }
      const result = await session.styles({ target: optionalString(args, 'target'), ref: optionalString(args, 'ref'), selector: optionalString(args, 'selector') }, {
        properties: optionalString(args, 'properties'),
        rules: args.rules !== false,
      })
      const lines = [`Styles for ${result.label}`, '', `Computed (${result.computed.length}):`]
      if (result.computed.length === 0) lines.push('  (no matching computed properties)')
      else lines.push(...result.computed.map((property) => `  ${property.name}: ${property.value}`))
      if (result.matched.length > 0) {
        lines.push('', `Matched rules (${result.matched.length}, nearest first):`)
        for (const [index, rule] of result.matched.entries()) {
          lines.push(`  ${index + 1}. ${rule.selector}${rule.origin === '' ? '' : ` [${rule.origin}]`}`)
          if (rule.properties.length === 0) lines.push('     (selected properties not set)')
          else lines.push(...rule.properties.map((property) => `     ${property}`))
        }
      }
      return { text: bounded(lines.join('\n')) }
    },
  })

  registerTool({
    name: 'browser_emulate',
    description: 'Emulate device and environment conditions: color scheme, reduced motion, mobile/touch, CPU throttling, '
      + 'network speed or offline, timezone, and geolocation. Use clear true to return to normal.',
    parameters: {
      colorScheme: { type: 'string', enum: ['light', 'dark', 'system'], description: 'prefers-color-scheme; system clears the override.' },
      reducedMotion: { type: 'string', enum: ['reduce', 'no-preference', 'system'], description: 'prefers-reduced-motion; system clears the override.' },
      mobile: { type: 'boolean', description: 'Emulate a mobile viewport flag (also enables touch).' },
      touch: { type: 'boolean', description: 'Enable or disable touch emulation.' },
      cpuThrottlingRate: { type: 'number', description: 'CPU slowdown factor, 1 to 20; 1 is normal.' },
      network: { type: 'string', enum: ['offline', 'slow3g', 'fast3g', 'none'], description: 'Network profile.' },
      timezone: { type: 'string', description: 'IANA timezone such as Asia/Shanghai; empty string restores the system timezone.' },
      geolocation: { type: 'string', description: 'Latitude,longitude such as 31.2304,121.4737.' },
      clear: { type: 'boolean', description: 'Clear every emulation override.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: args.clear === true ? 'Clear emulation' : 'Emulate device conditions', kind: 'other' }
    },
    async execute(args) {
      const result = await session.emulate({
        clear: args.clear === true,
        colorScheme: optionalString(args, 'colorScheme'),
        reducedMotion: optionalString(args, 'reducedMotion'),
        mobile: typeof args.mobile === 'boolean' ? args.mobile : undefined,
        touch: typeof args.touch === 'boolean' ? args.touch : undefined,
        cpuThrottlingRate: optionalNumber(args, 'cpuThrottlingRate'),
        network: optionalString(args, 'network'),
        timezone: typeof args.timezone === 'string' ? args.timezone : undefined,
        geolocation: optionalString(args, 'geolocation'),
      })
      const state = session.getState()
      const lines = result.applied.length === 0
        ? ['No emulation changes requested.']
        : ['Emulation updated:', ...result.applied.map((item) => `- ${item}`)]
      lines.push(`Viewport: ${state.viewport.width}x${state.viewport.height}`)
      return { text: bounded(lines.join('\n')) }
    },
  })

  registerTool({
    name: 'browser_performance',
    description: 'Read lightweight page performance: LCP, CLS, approximate INP, long tasks, navigation timing, resource count, '
      + 'and Chrome runtime metrics such as heap, nodes, layout count, and task duration.',
    parameters: {},
    output: commonOutput,
    presentCall() {
      return { card: 'generic', title: 'Read page performance', kind: 'read' }
    },
    async execute() {
      const perf = await session.performance()
      const navigation = perf.navigation
      const lines = [
        `Performance for ${perf.title === '' ? perf.url : `${perf.title} — ${perf.url}`}`,
        `LCP: ${perf.lcp === null ? 'not measured' : `${Math.round(perf.lcp)}ms`}`,
        `CLS: ${Number(perf.cls).toFixed(3)}`,
        `INP (approx.): ${perf.inp === null ? 'not measured (no event entries)' : `${Math.round(perf.inp)}ms`}`,
        `Long tasks: ${perf.longTaskCount} (${Math.round(perf.longTaskMs)}ms total)`,
        `Resources: ${perf.resources}`,
      ]
      if (navigation !== null) {
        lines.push(`TTFB: ${Math.round(navigation.ttfb)}ms; DOMContentLoaded: ${Math.round(navigation.domContentLoaded)}ms; load: ${Math.round(navigation.load)}ms`)
      }
      const runtime = perf.runtime ?? {}
      const runtimeKeys = ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents', 'Frames', 'LayoutCount', 'RecalcStyleCount', 'TaskDuration', 'ScriptDuration']
      const runtimeLines = runtimeKeys.filter((key) => typeof runtime[key] === 'number').map((key) => {
        const raw = runtime[key]
        let rendered
        if (key === 'JSHeapUsedSize' || key === 'JSHeapTotalSize') rendered = formatBytes(raw)
        else if (key === 'TaskDuration' || key === 'ScriptDuration') rendered = `${Math.round(raw * 1000)}ms`
        else rendered = String(Math.round(raw))
        return `- ${key}: ${rendered}`
      })
      if (runtimeLines.length > 0) lines.push('', 'Runtime:', ...runtimeLines)
      lines.push('', 'CLS and INP are collected from the Performance API; reload the page after instrumentation and interact before reading INP for stable values.')
      return { text: bounded(lines.join('\n')) }
    },
  })

  registerTool({
    name: 'browser_highlight',
    description: 'Draw a temporary colored box and caption around one element. Use it to point a human at the exact target '
      + 'before a screenshot or a destructive action. durationMs 0 keeps the box until clearHighlight or navigation.',
    parameters: {
      ...targetParams,
      durationMs: { type: 'integer', description: 'How long the box stays, in milliseconds; 0 persists until cleared or the page navigates; default 2500.' },
      color: { type: 'string', description: 'CSS hex color such as #ff9f1a.' },
      label: { type: 'string', description: 'Optional caption; defaults to the locator.' },
      clear: { type: 'boolean', description: 'Remove every highlight overlay instead of drawing one.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: 'Highlight element', kind: 'other' }
    },
    async execute(args) {
      if (args.clear === true) {
        await session.clearHighlight()
        return { text: 'Cleared all element highlights.' }
      }
      const result = await session.highlight({
        target: optionalString(args, 'target'),
        ref: optionalString(args, 'ref'),
        selector: optionalString(args, 'selector'),
      }, {
        durationMs: optionalNumber(args, 'durationMs'),
        color: optionalString(args, 'color'),
        label: optionalString(args, 'label'),
      })
      const box = result.box
      return {
        text: `Highlighted ${result.label} at ${Math.round(box.x)},${Math.round(box.y)} (${Math.round(box.width)}x${Math.round(box.height)})${result.persisted ? '; it stays until navigation or clearHighlight.' : '.'}`,
      }
    },
  })

  registerTool({
    name: 'browser_route',
    description: 'Mock network responses from the plugin: add a URL pattern, list routes, remove one, or clear all. '
      + 'Useful for testing empty, error, slow, and offline states without changing the server. Routes apply to the current page session.',
    parameters: {
      action: { type: 'string', enum: ['list', 'add', 'remove', 'clear'], description: 'list (default), add, remove, or clear.' },
      id: { type: 'string', description: 'Route id for remove; use action clear for every route.' },
      urlPattern: { type: 'string', description: 'URL pattern with * wildcards, such as */api/users*; defaults to *.' },
      method: { type: 'string', description: 'Only this HTTP method, such as GET or POST; defaults to every method.' },
      status: { type: 'integer', description: 'Response status code, 100 to 599; default 200.' },
      headers: { type: 'string', description: 'Optional JSON object of response headers, such as {"content-type":"application/json"}.' },
      body: { type: 'string', description: 'Response body text; JSON is fine as text. Default empty.' },
      contentType: { type: 'string', description: 'Convenience content-type when headers omit it.' },
      delayMs: { type: 'integer', description: 'Wait before answering, 0 to 30000; useful for loading states.' },
      errorReason: { type: 'string', enum: ['Failed', 'Aborted', 'TimedOut', 'AccessDenied', 'ConnectionClosed', 'ConnectionReset', 'ConnectionRefused', 'ConnectionAborted', 'ConnectionFailed', 'NameNotResolved', 'InternetDisconnected', 'AddressUnreachable', 'BlockedByClient', 'BlockedByResponse'], description: 'Fail the request at the network layer with this error instead of responding.' },
    },
    output: commonOutput,
    presentCall(args) {
      const action = typeof args.action === 'string' ? args.action : 'list'
      return { card: 'generic', title: action === 'add' ? 'Mock a request' : action === 'list' ? 'List network routes' : 'Change network routes', kind: 'other' }
    },
    async execute(args) {
      const action = typeof args.action === 'string' ? args.action : 'list'
      if (action === 'list') {
        const routes = session.listRoutes()
        if (routes.length === 0) return { text: 'No network routes.' }
        const lines = routes.map((route) => `[${route.id}] ${route.method ?? 'ANY'} ${route.urlPattern} -> ${route.errorReason ?? route.status}`
          + `${route.delayMs > 0 ? ` (+${route.delayMs}ms)` : ''}${route.bodyBytes > 0 ? `, ${formatBytes(route.bodyBytes)}` : ''}`)
        return { text: bounded(`Network routes (${routes.length}):\n${lines.join('\n')}`) }
      }
      if (action === 'remove') {
        const id = requireString(args, 'id')
        const result = await session.removeRoute(id)
        return { text: result.removed === 0 ? `No route ${id}.` : `Removed ${result.removed} route.` }
      }
      if (action === 'clear') {
        const result = await session.removeRoute('all')
        return { text: `Removed ${result.removed} route(s).` }
      }
      let headers
      if (typeof args.headers === 'string' && args.headers.trim() !== '') {
        try {
          headers = JSON.parse(args.headers)
        } catch {
          throw new Error('headers must be a JSON object string')
        }
        if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
          throw new Error('headers must be a JSON object string')
        }
      }
      const route = await session.addRoute({
        urlPattern: optionalString(args, 'urlPattern'),
        method: optionalString(args, 'method'),
        status: optionalNumber(args, 'status'),
        headers,
        body: typeof args.body === 'string' ? args.body : '',
        contentType: optionalString(args, 'contentType'),
        delayMs: optionalNumber(args, 'delayMs'),
        errorReason: optionalString(args, 'errorReason'),
      })
      return {
        text: `Added ${route.id}: ${route.method ?? 'ANY'} ${route.urlPattern} -> ${route.errorReason ?? route.status}`
          + `${route.delayMs > 0 ? ` after ${route.delayMs}ms` : ''}. Reload the page or trigger the request to see it.`,
      }
    },
  })

  registerTool({
    name: 'browser_cookies',
    description: 'List, set, delete, or clear browser cookies for the current page. Cookie values are redacted when they match configured secrets.',
    parameters: {
      action: { type: 'string', enum: ['list', 'set', 'delete', 'clear'], description: 'list (default), set, delete, or clear.' },
      url: { type: 'string', description: 'Cookie URL for list/set/delete; defaults to the current page.' },
      urls: { type: 'string', description: 'Comma-separated URLs to list; optional.' },
      name: { type: 'string', description: 'Cookie name for set/delete.' },
      value: { type: 'string', description: 'Cookie value for set.' },
      domain: { type: 'string', description: 'Cookie domain for set/delete.' },
      path: { type: 'string', description: 'Cookie path for set/delete.' },
      httpOnly: { type: 'boolean', description: 'Set the HttpOnly flag.' },
      secure: { type: 'boolean', description: 'Set the Secure flag.' },
      sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'], description: 'SameSite policy.' },
      expires: { type: 'number', description: 'Expiry as a Unix timestamp in seconds.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Cookies: ${typeof args.action === 'string' ? args.action : 'list'}`, kind: 'other' }
    },
    async execute(args) {
      const action = typeof args.action === 'string' ? args.action : 'list'
      if (action === 'clear') {
        await session.deleteCookie({ all: true })
        return { text: 'Cleared all cookies.' }
      }
      if (action === 'set') {
        const result = await session.setCookie({
          name: requireString(args, 'name'),
          value: typeof args.value === 'string' ? args.value : '',
          url: optionalString(args, 'url'),
          domain: optionalString(args, 'domain'),
          path: optionalString(args, 'path'),
          httpOnly: typeof args.httpOnly === 'boolean' ? args.httpOnly : undefined,
          secure: typeof args.secure === 'boolean' ? args.secure : undefined,
          sameSite: optionalString(args, 'sameSite'),
          expires: optionalNumber(args, 'expires'),
        })
        return { text: result.ok ? `Set cookie ${args.name}.` : `Chrome refused cookie ${args.name}.` }
      }
      if (action === 'delete') {
        await session.deleteCookie({
          name: requireString(args, 'name'),
          url: optionalString(args, 'url'),
          domain: optionalString(args, 'domain'),
          path: optionalString(args, 'path'),
        })
        return { text: `Deleted cookie ${args.name}.` }
      }
      const rawUrls = optionalString(args, 'urls')
      const urls = rawUrls === undefined ? undefined : rawUrls.split(',').map((item) => item.trim()).filter((item) => item !== '')
      const cookies = await session.listCookies({ urls })
      if (cookies.length === 0) return { text: 'No cookies for this page.' }
      const lines = cookies.map((cookie) => `${cookie.domain}${cookie.path} ${cookie.name}=${cookie.value}`
        + `${cookie.httpOnly ? '; HttpOnly' : ''}${cookie.secure ? '; Secure' : ''}${cookie.session ? '; session' : ''}${cookie.sameSite === '' ? '' : `; SameSite=${cookie.sameSite}`}`)
      return { text: bounded(`Cookies (${cookies.length}):\n${lines.join('\n')}`) }
    },
  })

  registerTool({
    name: 'browser_storage',
    description: 'Read or change localStorage/sessionStorage, or export/import a storage-state file (cookies + localStorage). '
      + 'Secret values are redacted in tool output; storage-state files are written under ~/.dsh/browser-control/state.',
    parameters: {
      action: { type: 'string', enum: ['list', 'get', 'set', 'remove', 'clear', 'export', 'import'], description: 'list (default), get, set, remove, clear, export, or import.' },
      type: { type: 'string', enum: ['local', 'session'], description: 'localStorage (default) or sessionStorage.' },
      key: { type: 'string', description: 'Storage key for get/set/remove.' },
      value: { type: 'string', description: 'Storage value for set.' },
      path: { type: 'string', description: 'Storage-state file path for export/import; defaults to a timestamped file under the state directory.' },
      clear: { type: 'boolean', description: 'For import, replace existing cookies and localStorage instead of merging.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: `Storage: ${typeof args.action === 'string' ? args.action : 'list'}`, kind: 'other' }
    },
    async execute(args) {
      const action = typeof args.action === 'string' ? args.action : 'list'
      if (action === 'export') {
        const result = await session.exportStorageState({ path: optionalString(args, 'path') })
        return { text: `Storage state exported to ${result.path} (${result.cookies} cookies, ${result.origins} origins).` }
      }
      if (action === 'import') {
        const result = await session.importStorageState({
          path: optionalString(args, 'path'),
          clear: args.clear === true,
        })
        return { text: `Imported ${result.cookies} cookies and ${result.localKeys} localStorage keys from ${result.path}` }
      }
      const result = await session.storage(action, {
        type: args.type === 'session' ? 'session' : 'local',
        key: optionalString(args, 'key'),
        value: typeof args.value === 'string' ? args.value : undefined,
      })
      if (action === 'list') {
        if (result.entries.length === 0) return { text: `${result.type} is empty.` }
        return { text: bounded(`${result.type} (${result.entries.length}):\n${result.entries.map((entry) => `  ${entry.key} = ${entry.value}`).join('\n')}`) }
      }
      if (action === 'clear') return { text: `Cleared ${result.type}.` }
      if (action === 'get') return { text: result.value === '' ? `${result.key} is not set in ${result.type}.` : `${result.key} = ${result.value}` }
      return { text: `${action === 'set' ? 'Set' : 'Removed'} ${result.key} in ${result.type}.` }
    },
  })

  registerTool({
    name: 'browser_download',
    description: 'List files downloaded by the page or wait for one to finish. Downloads are saved under the plugin download directory '
      + '(default ~/.dsh/browser-control/downloads).',
    parameters: {
      action: { type: 'string', enum: ['list', 'wait'], description: 'list (default) or wait.' },
      guid: { type: 'string', description: 'Download id for wait; omit to wait for the next completed download.' },
      timeoutMs: { type: 'integer', description: 'Wait timeout, 1000 to 120000; default 30000.' },
    },
    output: commonOutput,
    presentCall(args) {
      return { card: 'generic', title: 'Download', kind: 'read' }
    },
    async execute(args) {
      const action = typeof args.action === 'string' ? args.action : 'list'
      if (action === 'wait') {
        const result = await session.waitForDownload({
          guid: optionalString(args, 'guid'),
          timeoutMs: optionalNumber(args, 'timeoutMs'),
        })
        return { text: `Download ${result.state}: ${result.path ?? (result.suggestedFilename || result.url)}` }
      }
      const downloads = session.listDownloads()
      if (downloads.length === 0) return { text: 'No downloads yet.' }
      const lines = downloads.map((entry) => `[${entry.guid}] ${entry.state} ${entry.suggestedFilename || entry.url}`
        + `${entry.totalBytes === null ? '' : ` (${formatBytes(entry.receivedBytes)} of ${formatBytes(entry.totalBytes)})`}`
        + `${entry.path === null || entry.path === undefined ? '' : ` -> ${entry.path}`}`)
      return { text: bounded(`Downloads (${downloads.length}):\n${lines.join('\n')}`) }
    },
  })

  registerTool({
    name: 'browser_screenshot',
    description: 'Capture an image: the viewport by default, the whole page with fullPage, or one element with target/ref/selector.',
    parameters: {
      fullPage: { type: 'boolean', description: 'Capture the entire scrollable page instead of the viewport.' },
      ...targetParams,
      padding: { type: 'integer', description: 'For an element screenshot, pixels of padding around it; 0 to 100.' },
    },
    output: commonOutput,
    presentCall(args) {
      const element = optionalString(args, 'target') ?? optionalString(args, 'ref') ?? optionalString(args, 'selector')
      if (element !== undefined) return { card: 'generic', title: `Screenshot ${element}`, kind: 'read' }
      return { card: 'generic', title: args.fullPage === true ? 'Screenshot the full page' : 'Screenshot the page', kind: 'read' }
    },
    async execute(args) {
      const target = optionalString(args, 'target')
      const ref = optionalString(args, 'ref')
      const selector = optionalString(args, 'selector')
      if (target !== undefined || ref !== undefined || selector !== undefined) {
        const shot = await session.captureElement({ target, ref, selector }, {
          padding: optionalNumber(args, 'padding') ?? 0,
          maxDimension: 1600,
        })
        const image = await attachImage(ctx, shot.buffer, 'browser-element.png')
        const path = await session.saveScreenshot(shot.buffer)
        const label = shot.label === '' ? (target ?? ref ?? selector) : shot.label
        const size = image === null ? '' : ` (${image.width}x${image.height} px)`
        const value = { text: bounded(`Screenshot of ${label}${size}.`) }
        if (image !== null) value.image = image
        if (path !== null) value.path = path
        return value
      }
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
    description: 'Close this conversation browser page. Other conversations keep their pages, and the next browser tool here starts a fresh page.',
    parameters: {},
    output: commonOutput,
    presentCall() {
      return { card: 'generic', title: 'Close the browser', kind: 'other' }
    },
    async execute(_args, exec) {
      const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : null
      if (sessionId !== null) {
        await session.closeSession(sessionId)
        return { text: 'This conversation browser page is closed.' }
      }
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
