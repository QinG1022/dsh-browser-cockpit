/**
 * Browser control: one local Chrome page the agent and the human can drive
 * together, with a live panel entry in the left sidebar.
 *
 * Configuration accepted from the bundle row:
 * - `browserPath`: Chrome-family executable; defaults to the usual Chrome/Edge locations.
 * - `headless`: `false` to show the browser window; defaults to a headless page.
 * - `width` / `height`: initial viewport; defaults to 1440x900.
 * - `profileDir`: Chrome profile directory; defaults to ~/.dsh/browser-control/profile.
 * - `dialogBehavior`: `dismiss` (default), `accept`, or `manual` for JavaScript dialogs.
 * - `followNewTabs`: `false` disables switching to tabs opened by the current page.
 * - `idleTimeoutMs`: close the browser after this much inactivity; `0` disables (default 5 minutes).
 * - `downloadDir`: directory for page downloads; defaults to ~/.dsh/browser-control/downloads.
 * - `storageStateDir`: directory for exported storage-state files; defaults to ~/.dsh/browser-control/state.
 * - `secrets`: values to redact from tool output and activity details, as an array or `{ name: { value, domains? } }`.
 * - `allowedHosts`: extra HTTP hosts the browser may open, as a comma-separated string or array; loopback is always allowed.
 * - `allowFileUrls`: `true` permits `file://` navigation; defaults to false.
 * @module dsh-browser-cockpit
 */

import { ActivityLog } from './lib/activity.js'
import { BrowserSession } from './lib/browser.js'
import { registerPanelRoutes } from './lib/routes.js'
import { createTargetResolver } from './lib/targets.js'
import { registerBrowserTools } from './lib/tools.js'

export const inject = ['tools']

/**
 * Activate the plugin: one browser session, its tools, and its panel routes.
 * @param {object} ctx - the host plugin context.
 * @param {{ browserPath?: string, headless?: boolean, width?: number, height?: number, profileDir?: string, dialogBehavior?: 'dismiss' | 'accept' | 'manual', followNewTabs?: boolean, idleTimeoutMs?: number, downloadDir?: string, storageStateDir?: string, secrets?: unknown, allowedHosts?: string | string[], allowFileUrls?: boolean }} [config] - row configuration.
 */
export function apply(ctx, config = {}) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const session = new BrowserSession({
    browserPath: typeof settings.browserPath === 'string' ? settings.browserPath : undefined,
    headless: settings.headless !== false,
    width: typeof settings.width === 'number' ? settings.width : undefined,
    height: typeof settings.height === 'number' ? settings.height : undefined,
    profileDir: typeof settings.profileDir === 'string' ? settings.profileDir : undefined,
    dialogBehavior: typeof settings.dialogBehavior === 'string' ? settings.dialogBehavior : undefined,
    followNewTabs: settings.followNewTabs !== false,
    idleTimeoutMs: typeof settings.idleTimeoutMs === 'number' ? settings.idleTimeoutMs : undefined,
    downloadDir: typeof settings.downloadDir === 'string' ? settings.downloadDir : undefined,
    storageStateDir: typeof settings.storageStateDir === 'string' ? settings.storageStateDir : undefined,
    secrets: settings.secrets,
    allowedHosts: settings.allowedHosts,
    allowFileUrls: settings.allowFileUrls === true,
  })

  ctx.effect(() => () => {
    void session.dispose()
  }, 'browser-control: browser session')

  const resolveTarget = createTargetResolver(ctx)
  const activity = new ActivityLog()
  registerBrowserTools(ctx, session, resolveTarget, activity)

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => registerPanelRoutes(scope, session, resolveTarget, activity), 'browser-control: panel routes')
  })
}
