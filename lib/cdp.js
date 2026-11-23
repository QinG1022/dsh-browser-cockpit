/**
 * Minimal Chrome DevTools Protocol transport over the WebSocket that the
 * running Node runtime already provides. No dependency is added to the profile.
 * @module dsh-browser-cockpit/lib/cdp
 */

/** A failed or unavailable browser connection. */
export class CdpError extends Error {
  /**
   * @param {string} message - human-readable failure.
   * @param {{ method?: string, cause?: unknown }} [options] - the command that failed.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CdpError'
    this.method = options.method
  }
}

/** One CDP connection: command/reply matching plus session-scoped events. */
export class CdpConnection {
  #url
  #socket
  #nextId = 1
  #pending = new Map()
  #listeners = new Map()
  #closed = false
  #timeoutMs

  /**
   * @param {string} url - browser-level WebSocket debugger URL.
   * @param {{ timeoutMs?: number }} [options] - per-command deadline.
   */
  constructor(url, options = {}) {
    this.#url = url
    this.#timeoutMs = options.timeoutMs ?? 20000
  }

  /** @returns {boolean} whether the connection is gone. */
  get closed() {
    return this.#closed
  }

  /** @returns {string} the debugger URL this connection speaks to. */
  get url() {
    return this.#url
  }

  /**
   * Open one socket and resolve the connection only after it is usable.
   * @param {string} url - browser-level WebSocket debugger URL.
   * @param {{ timeoutMs?: number, connectTimeoutMs?: number }} [options] - deadlines.
   * @returns {Promise<CdpConnection>}
   */
  static open(url, options = {}) {
    const connectTimeoutMs = options.connectTimeoutMs ?? 15000
    return new Promise((resolve, reject) => {
      let socket
      try {
        socket = new WebSocket(url)
      } catch (cause) {
        reject(new CdpError(`cannot create the browser debugging socket: ${cause.message}`, { cause }))
        return
      }
      const connection = new CdpConnection(url, options)
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { socket.close() } catch { /* already closed */ }
        reject(new CdpError('timed out connecting to the browser debugging socket'))
      }, connectTimeoutMs)
      socket.addEventListener('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        connection.#adopt(socket)
        resolve(connection)
      }, { once: true })
      socket.addEventListener('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new CdpError('the browser debugging socket refused the connection'))
      }, { once: true })
    })
  }

  /**
   * Send one command and resolve its result.
   * @param {string} method - CDP method name.
   * @param {object} [params] - CDP parameters.
   * @param {string} [sessionId] - target session for page-scoped commands.
   * @returns {Promise<any>}
   */
  send(method, params = {}, sessionId) {
    if (this.#closed || this.#socket === undefined) {
      return Promise.reject(new CdpError(`cannot send ${method}: the browser connection is closed`, { method }))
    }
    const id = this.#nextId++
    const message = { id, method, params }
    if (sessionId !== undefined) message.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new CdpError(`timed out waiting for ${method}`, { method }))
      }, this.#timeoutMs)
      this.#pending.set(id, { resolve, reject, timer, method })
      try {
        this.#socket.send(JSON.stringify(message))
      } catch (cause) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new CdpError(`cannot send ${method}: ${cause.message}`, { method, cause }))
      }
    })
  }

  /**
   * Listen for one protocol event on every session.
   * @param {string} method - CDP event name.
   * @param {(params: any, sessionId?: string) => void} listener - event callback.
   * @returns {() => void} unsubscribe.
   */
  on(method, listener) {
    let bucket = this.#listeners.get(method)
    if (bucket === undefined) {
      bucket = new Set()
      this.#listeners.set(method, bucket)
    }
    bucket.add(listener)
    return () => {
      bucket.delete(listener)
      if (bucket.size === 0) this.#listeners.delete(method)
    }
  }

  /** Close the socket and reject every command still waiting for a reply. */
  close() {
    if (this.#closed) return
    this.#shutdown(new CdpError('the browser connection was closed by the plugin'))
    try { this.#socket?.close(1000) } catch { /* already closed */ }
  }

  #adopt(socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => {
      const data = event.data
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
      this.#dispatch(text)
    })
    socket.addEventListener('close', () => {
      this.#shutdown(new CdpError('the browser closed the debugging connection'))
    })
    socket.addEventListener('error', () => {
      this.#shutdown(new CdpError('the browser debugging connection failed'))
    })
  }

  #dispatch(text) {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error !== undefined) {
        const detail = message.error.data === undefined ? '' : `: ${message.error.data}`
        pending.reject(new CdpError(`${pending.method} failed: ${message.error.message}${detail}`, { method: pending.method }))
      } else {
        pending.resolve(message.result ?? {})
      }
      return
    }
    if (typeof message.method !== 'string') return
    const bucket = this.#listeners.get(message.method)
    if (bucket === undefined) return
    for (const listener of [...bucket]) {
      try {
        listener(message.params ?? {}, message.sessionId)
      } catch {
        // A listener must never break protocol dispatch.
      }
    }
  }

  #shutdown(error) {
    if (this.#closed) return
    this.#closed = true
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      this.#pending.delete(id)
      pending.reject(error)
    }
    this.#listeners.clear()
    this.#socket = undefined
  }
}
