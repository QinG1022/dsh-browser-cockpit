/**
 * Turn a requested address into the URL the controlled browser should load.
 *
 * The Harness Web GUI answers an unauthenticated browser with 401 until the
 * process token signs it in. Opening the Harness origin therefore uses the
 * tokenized URL once, and the token is removed from the address bar right after
 * the login cookie exists, so the token never lands in the session log, the
 * panel, or a screenshot.
 * @module dsh-browser-cockpit/lib/targets
 */

import { normalizeUrl } from './browser.js'

/**
 * Build the resolver for this plugin's context.
 * @param {object} ctx - host plugin context.
 * @returns {(url: string) => { target: string, cleanAfterLoad: boolean }}
 */
export function createTargetResolver(ctx) {
  return (url) => {
    const normalized = normalizeUrl(url)
    const connection = ctx.get('connection')
    const webServer = ctx.get('webServer')
    if (connection === undefined || webServer === undefined) return { target: normalized, cleanAfterLoad: false }
    let origin
    try {
      origin = new URL(webServer.getOrigin()).origin
    } catch {
      return { target: normalized, cleanAfterLoad: false }
    }
    let requested
    try {
      requested = new URL(normalized)
    } catch {
      return { target: normalized, cleanAfterLoad: false }
    }
    if (requested.origin !== origin) return { target: normalized, cleanAfterLoad: false }
    try {
      return { target: connection.authenticatedUrl(normalized), cleanAfterLoad: true }
    } catch {
      return { target: normalized, cleanAfterLoad: false }
    }
  }
}

/**
 * Open one address, signing in to the Harness GUI when that is what it points at.
 * @param {import('./browser.js').BrowserSession} session - the controlled page.
 * @param {(url: string) => { target: string, cleanAfterLoad: boolean }} resolve - the target resolver.
 * @param {string} url - requested address.
 * @returns {Promise<object>} the page state after loading.
 */
export async function openTarget(session, resolve, url) {
  const { target, cleanAfterLoad } = resolve(url)
  await session.open(target)
  if (cleanAfterLoad) {
    try {
      await session.evaluate("history.replaceState(null, '', location.pathname)")
      await session.refreshIdentity()
    } catch {
      // The tokenized URL still works if the app refuses the rewrite.
    }
  }
  return session.getState()
}
