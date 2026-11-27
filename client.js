/**
 * Browser control panel: the left sidebar entry and its live page view.
 *
 * The panel is a plain React component registered into `sidebar.panellist`
 * (the icon) and `main` (the page). It talks to its own Host half over the
 * local panel routes, so it needs no generated Remote namespace and keeps
 * working across Harness restarts.
 */
window.__ModuleLoader__.load({
  id: 'dsh-browser-cockpit',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const NS = 'browserControl'
    const PANEL_ID = 'browser-control'
    const BROWSER_TAB_ID = 'dsh-browser-cockpit/tab'
    const BROWSER_TAB_KIND = 'browserControl'
    const BASE = '/plugin/browser-control/'
    const PRESETS = [
      { key: 'desktop', width: 1440, height: 900 },
      { key: 'laptop', width: 1280, height: 800 },
      { key: 'tablet', width: 820, height: 1180 },
      { key: 'phone', width: 390, height: 844 },
    ]
    const FRESH_MS = 4000

    /**
     * One shared state/activity feed for every surface (left panel, right tab,
     * composer strip). Mounting a second surface must not double the polling;
     * the last unmount stops the loops and a remount resumes them.
     */
    const FEED = {
      state: null,
      activity: [],
      current: null,
      offline: false,
      loaded: false,
      lastId: 0,
      refs: 0,
      active: false,
      generation: 0,
      listeners: new Set(),
    }

    function notifyFeed() {
      for (const listener of FEED.listeners) {
        try {
          listener()
        } catch {
          // A broken subscriber must not stop the others.
        }
      }
    }

    function laterFeed(generation, task, delay) {
      if (!FEED.active || generation !== FEED.generation) return
      setTimeout(task, delay)
    }

    function pollFeedState(generation) {
      if (!FEED.active || generation !== FEED.generation) return
      fetch(`${BASE}state`, { cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.json()
        })
        .then((next) => {
          if (!FEED.active || generation !== FEED.generation) return
          FEED.state = next
          FEED.offline = false
          notifyFeed()
        })
        .catch(() => {
          if (!FEED.active || generation !== FEED.generation) return
          FEED.offline = true
          if (FEED.state === null) FEED.state = { running: false, phase: 'stopped' }
          notifyFeed()
        })
        .finally(() => laterFeed(generation, () => pollFeedState(generation), 2500))
    }

    function pollFeedActivity(generation) {
      if (!FEED.active || generation !== FEED.generation) return
      fetch(`${BASE}activity?since=${FEED.lastId}`, { cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.json()
        })
        .then((payload) => {
          if (!FEED.active || generation !== FEED.generation) return
          FEED.current = payload.current ?? null
          if (typeof payload.lastId === 'number') {
            if (payload.lastId < FEED.lastId) {
              // A restarted Host restarts ids; rebaseline instead of treating its history as new actions.
              FEED.lastId = 0
              FEED.loaded = false
              FEED.activity = []
            } else {
              FEED.lastId = payload.lastId
            }
          }
          if (Array.isArray(payload.entries) && payload.entries.length > 0) {
            const merged = new Map(FEED.activity.map((entry) => [entry.id, entry]))
            for (const entry of payload.entries) merged.set(entry.id, entry)
            FEED.activity = [...merged.values()].sort((left, right) => right.id - left.id).slice(0, 60)
          }
          FEED.loaded = true
          notifyFeed()
        })
        .catch(() => {
          // Keep the previous feed; the next tick retries.
        })
        .finally(() => laterFeed(generation, () => pollFeedActivity(generation), 1200))
    }

    function beginFeed() {
      if (FEED.active) return
      FEED.active = true
      FEED.generation += 1
      const generation = FEED.generation
      pollFeedState(generation)
      pollFeedActivity(generation)
    }

    function endFeed() {
      FEED.refs = Math.max(0, FEED.refs - 1)
      if (FEED.refs > 0) return
      FEED.active = false
      FEED.generation += 1
    }

    function subscribeFeed(listener) {
      FEED.listeners.add(listener)
      FEED.refs += 1
      beginFeed()
      return () => {
        FEED.listeners.delete(listener)
        endFeed()
      }
    }

    /** Replace the shared state after a panel action so every surface updates at once. */
    function updateFeedState(next) {
      if (next === null || typeof next !== 'object') return
      FEED.state = next
      FEED.offline = false
      notifyFeed()
    }

    /**
     * Restart the shared polling loops now. Bumping the generation retires the
     * loops already in flight, so a manual retry never doubles them.
     */
    function refreshFeed() {
      if (!FEED.active) return
      FEED.offline = false
      FEED.generation += 1
      const generation = FEED.generation
      notifyFeed()
      pollFeedState(generation)
      pollFeedActivity(generation)
    }

    function useSharedFeed() {
      const [, setTick] = useState(0)
      useEffect(() => subscribeFeed(() => setTick((value) => value + 1)), [])
      return FEED
    }

    const EN = {
      panel: 'Browser',
      title: 'Browser cockpit',
      subtitle: 'Inspect a running local page in Chrome together with the agent. The live view below is exactly what the agent sees; type an address here or ask in the conversation.',
      'overview.title': 'Conversations with a browser',
      'overview.count': '{count} live',
      'overview.empty': 'No conversation has opened a browser yet. Open an address below, or ask the agent to open one.',
      'overview.noFrame': 'Waiting for a frame…',
      'overview.active': 'Active',
      'overview.inactive': 'Idle',
      'overview.focus': 'Show',
      'overview.close': 'Close',
      'overview.justNow': 'just now',
      'overview.seconds': '{count}s ago',
      'overview.minutes': '{count}m ago',
      'v16.summary': '{count} browsers · {running} running',
      'v16.new': 'New browser',
      'v16.back': 'All browsers',
      'v16.preview': 'Preview',
      'v16.live': 'Live view',
      'v16.liveHint': 'Live view switches the page the agent controls',
      'v16.openRight': 'Open in side panel',
      'v16.zoom': 'Zoom in',
      'v16.copyUrl': 'Copy address',
      'v16.closeSession': 'Close this conversation browser',
      'v16.confirmClose': 'Close this conversation browser? Its pages and login state will be closed.',
      'v16.confirmCloseShort': 'Confirm close',
      'v16.emptyTitle': 'No browser open',
      'v16.emptyBody': 'A browser appears here when the agent uses browser tools, or when you press +.',
      'v16.emptyCta': 'Open current conversation browser',
      'v16.log': 'Activity',
      'v16.logEmpty': 'No activity for this conversation yet.',
      'v16.errors': 'Errors',
      'v16.errorEmpty': 'No page errors.',
      'v16.readonly': 'Read-only preview',
      'v16.railShow': 'Show activity',
      'v16.railHide': 'Hide activity',
      'v16.menu': 'More',
      'v16.noSession': 'No conversation is available for a new browser yet.',
      'v16.newTitle': 'Open a browser for…',
      'v16.newEmpty': 'No live conversation is available.',
      'v16.hasBrowser': 'Browser open',
      'v16.noConversations': 'No live conversation is available to open a browser.',
      'v16.networkGroup': 'Network × {count}',
      'v16.close': 'Close',
      'v16.cancel': 'Cancel',
      'status.running': 'Running',
      'status.starting': 'Starting',
      'status.failed': 'Failed',
      'status.stopped': 'Not running',
      'status.offline': 'Disconnected',
      'action.open': 'Open',
      'action.opening': 'Opening…',
      'action.reload': 'Reload',
      'action.close': 'Close browser',
      'field.address': 'Project address',
      'url.placeholder': 'http://localhost:3000',
      'meta.title': 'Title',
      'meta.viewport': 'Viewport',
      'meta.errors': 'errors',
      'meta.headless': 'background window',
      'meta.visible': 'visible window',
      'preset.desktop': 'Desktop',
      'preset.laptop': 'Laptop',
      'preset.tablet': 'Tablet',
      'preset.phone': 'Phone',
      'preset.current': 'Current',
      'empty.title': 'The browser is not running yet',
      'empty.body': 'Enter the project address above and press Open, or ask the agent to open it from the conversation. The first launch takes a few seconds; the page then appears here and in the conversation.',
      'empty.hint': 'The agent uses the same browser: it can read the page, click, type, and collect console errors itself.',
      'empty.cta': 'Open address',
      'frame.waiting': 'Waiting for the first frame…',
      'stage.live': 'Live',
      'stage.paused': 'Paused',
      'stage.readonly': 'Live view (read-only)',
      'stage.opening': 'Opening…',
      'stage.working': 'Working…',
      'stage.starting': 'Starting the browser…',
      'stage.failedTitle': 'The browser could not start',
      'stage.offlineTitle': 'Lost the connection to Harness',
      'stage.offlineBody': 'The panel keeps retrying. Check that this page is still served by the running Harness.',
      'stage.retry': 'Retry',
      'notice.dismiss': 'Dismiss',
      'notice.failed': 'Action failed',
      'notice.urlRequired': 'Enter a project address first.',
      'error.refused': 'Could not open {url}: the connection was refused. Start the project first (for example pnpm dev) or check the port.',
      'error.dns': 'Could not open {url}: the host name was not found.',
      'error.emptyResponse': 'Could not open {url}: the server closed the connection without a response.',
      'error.timeout': 'The browser did not answer in time; try again.',
      'error.invalidUrl': 'That is not a valid address; include http:// or https:// if the port is not obvious.',
      'errors.title': 'Recent page errors',
      'activity.title': 'Activity',
      'activity.empty': 'No actions yet. Each step by the agent or you appears here after it runs.',
      'activity.now': 'Now: {label}',
      'activity.justNow': 'Just now: {label}',
      'activity.agent': 'Agent',
      'activity.you': 'You',
      'activity.errors': '+{count} errors',
      'activity.emptyPage': '—',
      'act.open': 'Open {url}',
      'act.read-page': 'Read the page',
      'act.click': 'Click “{target}”',
      'act.clickRef': 'Click {target}',
      'act.type': 'Type “{text}”',
      'act.typeInto': 'Type “{text}” into “{target}”',
      'act.key': 'Press {key}',
      'act.wait': 'Wait for {target}',
      'act.waitNetwork': 'network idle',
      'act.assert': 'Assert {condition}',
      'act.network': 'Network: {action}',
      'act.styles': 'Inspect element styles',
      'act.emulate': 'Emulate {what}',
      'act.performance': 'Read page performance',
      'act.highlight': 'Highlight {target}',
      'act.route': 'Network route: {action} {pattern}',
      'act.cookies': 'Cookies: {action}',
      'act.storage': 'Storage: {action}',
      'act.download': 'Download: {action}',
      'act.dialogAccept': 'Accept dialog',
      'act.dialogDismiss': 'Dismiss dialog',
      'act.hover': 'Hover {target}',
      'act.drag': 'Drag {from} → {to}',
      'act.fill-form': 'Fill {count} fields',
      'act.select': 'Select {target}',
      'act.upload': 'Upload {count} files',
      'act.tabs': 'Tabs: {action}',
      'act.scroll': 'Scroll {direction}',
      'act.eval': 'Run a page script',
      'act.read-console': 'Read the console',
      'act.screenshot': 'Screenshot',
      'act.resize': 'Resize to {width}×{height}',
      'act.close': 'Close the browser',
      'act.other': 'Browser action',
      'panel.openRight': 'Open in the right sidebar',
      'guide.description': 'Live view and activity beside the conversation.',
      'header.open': 'Browser live view',
      'tab.empty': 'The browser is not running yet. Open the Browser panel, or ask the agent to open a page.',
      'tab.inactive': 'Another conversation is using the page',
      'tab.inactive.body': 'This conversation gets its own page when the agent next uses the browser. Open the Browser panel to watch the active conversation.',
      'tab.openPanel': 'Open the Browser panel',
      'tab.waiting': 'Waiting for the first action…',
      'tab.foot': '{url} · {width}×{height}',
      'strip.now': 'Agent now: {label}',
      'strip.justNow': 'Just now: {label}',
      'strip.view': 'View',
    }

    const ZH = {
      panel: '浏览器',
      title: '浏览器驾驶舱',
      subtitle: '和智能体一起在本地 Chrome 里查看正在运行的页面。下面的实时画面就是智能体看到的画面；可以在上方输入地址，也可以直接在对话里让智能体打开。',
      'overview.title': '已打开浏览器的会话',
      'overview.count': '{count} 个',
      'overview.empty': '还没有会打开浏览器。可以在下方输入地址，或让智能体先打开一个页面。',
      'overview.noFrame': '正在等待画面…',
      'overview.active': '当前',
      'overview.inactive': '空闲',
      'overview.focus': '查看',
      'overview.close': '关闭',
      'overview.justNow': '刚刚',
      'overview.seconds': '{count} 秒前',
      'overview.minutes': '{count} 分钟前',
      'v16.summary': '{count} 个浏览器 · {running} 个运行中',
      'v16.new': '新建浏览器',
      'v16.back': '全部会话',
      'v16.preview': '预览',
      'v16.live': '实时查看',
      'v16.liveHint': '实时查看会切换智能体正在操作的页面',
      'v16.openRight': '在右栏打开',
      'v16.zoom': '放大',
      'v16.copyUrl': '复制地址',
      'v16.closeSession': '关闭此会话浏览器',
      'v16.confirmClose': '关闭这个会话的浏览器？该会话的页面和登录状态会一并关闭。',
      'v16.confirmCloseShort': '确认关闭',
      'v16.emptyTitle': '还没有浏览器',
      'v16.emptyBody': '智能体使用浏览器工具，或点击 + 新建后，会在这里出现。',
      'v16.emptyCta': '打开当前会话浏览器',
      'v16.log': '操作记录',
      'v16.logEmpty': '这个会话还没有操作记录。',
      'v16.errors': '错误',
      'v16.errorEmpty': '页面没有报错。',
      'v16.readonly': '只读预览',
      'v16.railShow': '显示操作记录',
      'v16.railHide': '收起操作记录',
      'v16.menu': '更多',
      'v16.noSession': '现在没有可用于新建浏览器的会话。',
      'v16.newTitle': '为哪个会话打开浏览器？',
      'v16.newEmpty': '没有可用的对话。',
      'v16.hasBrowser': '已打开',
      'v16.noConversations': '当前没有可以打开浏览器的对话。',
      'v16.networkGroup': '网络 × {count}',
      'v16.close': '关闭',
      'v16.cancel': '取消',
      'status.running': '运行中',
      'status.starting': '启动中',
      'status.failed': '启动失败',
      'status.stopped': '未启动',
      'status.offline': '连接中断',
      'action.open': '打开',
      'action.opening': '打开中…',
      'action.reload': '刷新',
      'action.close': '关闭浏览器',
      'field.address': '项目地址',
      'url.placeholder': 'http://localhost:3000',
      'meta.title': '标题',
      'meta.viewport': '视口',
      'meta.errors': '个错误',
      'meta.headless': '后台窗口',
      'meta.visible': '可见窗口',
      'preset.desktop': '桌面',
      'preset.laptop': '笔记本',
      'preset.tablet': '平板',
      'preset.phone': '手机',
      'preset.current': '当前',
      'empty.title': '浏览器还没启动',
      'empty.body': '在上方填入项目地址后点「打开」，或者切换到会话让智能体打开。首次启动需要几秒，画面会出现在这里和对话中。',
      'empty.hint': '智能体用的是同一个浏览器：它能自己读页面、点击、输入并收集控制台报错。',
      'empty.cta': '打开地址',
      'frame.waiting': '正在等待第一帧画面…',
      'stage.live': '实时',
      'stage.paused': '画面已暂停',
      'stage.readonly': '实时画面（只读）',
      'stage.opening': '正在打开…',
      'stage.working': '处理中…',
      'stage.starting': '正在启动浏览器…',
      'stage.failedTitle': '浏览器启动失败',
      'stage.offlineTitle': '与 Harness 的连接中断了',
      'stage.offlineBody': '面板会继续重试。请确认这个页面仍由运行中的 Harness 提供。',
      'stage.retry': '重试',
      'notice.dismiss': '知道了',
      'notice.failed': '操作失败',
      'notice.urlRequired': '请先填写项目地址。',
      'error.refused': '无法打开 {url}：连接被拒绝。请确认项目已启动（例如 pnpm dev）或端口正确。',
      'error.dns': '无法打开 {url}：找不到这个主机名。',
      'error.emptyResponse': '无法打开 {url}：服务器没有返回内容就断开了连接。',
      'error.timeout': '浏览器响应超时，请重试。',
      'error.invalidUrl': '这不是有效的地址；如果没有明显端口，请补上 http:// 或 https://。',
      'errors.title': '最近页面错误',
      'activity.title': '操作记录',
      'activity.empty': '还没有操作记录。智能体或你执行每一步后，都会出现在这里。',
      'activity.now': '正在：{label}',
      'activity.justNow': '刚刚：{label}',
      'activity.agent': '智能体',
      'activity.you': '你',
      'activity.errors': '+{count} 个错误',
      'activity.emptyPage': '—',
      'act.open': '打开 {url}',
      'act.read-page': '读取页面',
      'act.click': '点击「{target}」',
      'act.clickRef': '点击 {target}',
      'act.type': '输入「{text}」',
      'act.typeInto': '在「{target}」输入「{text}」',
      'act.key': '按键 {key}',
      'act.wait': '等待 {target}',
      'act.waitNetwork': '网络空闲',
      'act.assert': '检查 {condition}',
      'act.network': '网络：{action}',
      'act.styles': '检查元素样式',
      'act.emulate': '模拟 {what}',
      'act.performance': '读取页面性能',
      'act.highlight': '高亮 {target}',
      'act.route': '网络路由：{action} {pattern}',
      'act.cookies': 'Cookie：{action}',
      'act.storage': '存储：{action}',
      'act.download': '下载：{action}',
      'act.dialogAccept': '接受对话框',
      'act.dialogDismiss': '取消对话框',
      'act.hover': '悬停 {target}',
      'act.drag': '拖动 {from} → {to}',
      'act.fill-form': '填写 {count} 个字段',
      'act.select': '选择 {target}',
      'act.upload': '上传 {count} 个文件',
      'act.tabs': '标签页：{action}',
      'act.scroll': '滚动 {direction}',
      'act.eval': '执行页面脚本',
      'act.read-console': '读取控制台',
      'act.screenshot': '截图',
      'act.resize': '切换到 {width}×{height}',
      'act.close': '关闭浏览器',
      'act.other': '浏览器操作',
      'panel.openRight': '在右侧栏打开',
      'guide.description': '和对话并排显示实时画面与操作记录。',
      'header.open': '浏览器实时画面',
      'tab.empty': '浏览器还没启动。打开「浏览器」面板，或让智能体打开一个页面。',
      'tab.inactive': '另一个会话正在使用页面',
      'tab.inactive.body': '智能体下次操作浏览器时，本会话会获得自己的页面。打开「浏览器」面板可查看当前会话。',
      'tab.openPanel': '打开「浏览器」面板',
      'tab.waiting': '等待第一步操作…',
      'tab.foot': '{url} · {width}×{height}',
      'strip.now': '智能体正在：{label}',
      'strip.justNow': '刚刚：{label}',
      'strip.view': '查看画面',
    }

    const FALLBACK = typeof navigator !== 'undefined' && /^zh/iu.test(navigator.language ?? '') ? ZH : EN

    const CSS = `
.dsh-bc-page{height:100%;min-height:0;box-sizing:border-box;padding:24px 40px 28px;display:flex;flex-direction:column;gap:14px;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);}
@media (max-width:720px){.dsh-bc-page{padding:16px 16px 20px;gap:10px;}}
.dsh-bc-head{display:flex;flex-direction:column;gap:6px;flex:0 0 auto;min-width:0;}
.dsh-bc-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.dsh-bc-title{margin:0;font-size:20px;font-weight:600;line-height:1.3;}
.dsh-bc-sub{margin:0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-width:680px;}
.dsh-bc-overview{flex:0 0 auto;min-width:0;display:flex;flex-direction:column;gap:8px;}
.dsh-bc-overview-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;min-width:0;}
.dsh-bc-overview-title{margin:0;font-size:13px;font-weight:600;line-height:1.3;}
.dsh-bc-overview-count{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.dsh-bc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px;max-height:264px;overflow:auto;padding-bottom:2px;}
.dsh-bc-card{display:flex;flex-direction:column;gap:5px;min-width:0;padding:7px 8px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;text-align:left;font-family:inherit;color:inherit;}
.dsh-bc-card:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);}
.dsh-bc-card.is-active{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary) inset;}
.dsh-bc-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.dsh-bc-card-head{display:flex;align-items:center;gap:6px;min-width:0;}
.dsh-bc-card-title{font-size:12px;font-weight:600;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0;}
.dsh-bc-card-badge{font-size:10px;line-height:1;padding:3px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);flex:0 0 auto;white-space:nowrap;}
.dsh-bc-card-badge.is-active{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);}
.dsh-bc-card-frame{width:100%;height:96px;object-fit:cover;object-position:top left;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);display:block;}
.dsh-bc-card-placeholder{height:96px;display:flex;align-items:center;justify-content:center;border-radius:6px;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px;background:var(--dsw-alias-bg-layer-2);}
.dsh-bc-card-url{font-size:10.5px;line-height:1.4;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-bc-card-foot{display:flex;align-items:center;gap:6px;min-width:0;}
.dsh-bc-card-age{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:0 0 auto;}
.dsh-bc-card-actions{margin-left:auto;display:flex;gap:4px;flex:0 0 auto;}
.dsh-bc-card-btn{height:22px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:10.5px;font-family:inherit;cursor:pointer;white-space:nowrap;}
.dsh-bc-card-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}
.dsh-bc-card-btn:disabled{opacity:.5;cursor:default;}
.dsh-bc-overview-empty{padding:12px 14px;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;}
.dsh-bc-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:0 0 auto;}
.dsh-bc-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto;}
.dsh-bc-input{flex:1 1 260px;min-width:180px;height:32px;padding:0 12px;font-size:13px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);outline:none;box-sizing:border-box;font-family:inherit;}
.dsh-bc-input:focus{border-color:var(--dsw-alias-brand-primary);}
.dsh-bc-btn{height:32px;padding:0 14px;font-size:13px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;white-space:nowrap;}
.dsh-bc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);}
.dsh-bc-btn:disabled{opacity:.5;cursor:default;}
.dsh-bc-btn.is-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base);font-weight:500;}
.dsh-bc-btn.is-primary:hover:not(:disabled){opacity:.92;background:var(--dsw-alias-brand-primary);}
.dsh-bc-select{height:32px;padding:0 8px;font-size:12.5px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:inherit;cursor:pointer;}
.dsh-bc-select:disabled{opacity:.5;cursor:default;}
.dsh-bc-stage{position:relative;flex:1 1 auto;min-height:200px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);overflow:hidden;display:flex;align-items:center;justify-content:center;}
.dsh-bc-frame{max-width:100%;max-height:100%;display:block;object-fit:contain;background:var(--dsw-alias-bg-layer-1);}
.dsh-bc-readonly{position:absolute;right:10px;bottom:10px;padding:3px 8px;border-radius:6px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);z-index:2;}
.dsh-bc-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:0 0 auto;}
.dsh-bc-dot.is-running{background:var(--dsw-alias-state-success-primary);}
.dsh-bc-dot.is-starting{background:var(--dsw-alias-state-warn-primary);animation:dsh-bc-pulse 1s ease-in-out infinite;}
.dsh-bc-dot.is-failed{background:var(--dsw-alias-state-error-primary);}
@keyframes dsh-bc-pulse{50%{opacity:.35;}}
.dsh-bc-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:32px 28px;text-align:center;max-width:520px;}
.dsh-bc-empty-title{font-size:14px;font-weight:600;}
.dsh-bc-empty-body{font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);}
.dsh-bc-empty-hint{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);opacity:.85;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;margin-top:2px;}
.dsh-bc-glyph{color:var(--dsw-alias-state-idle-primary);opacity:.7;}
.dsh-bc-center{display:flex;flex-direction:column;align-items:center;gap:10px;padding:28px;text-align:center;max-width:520px;}
.dsh-bc-center-title{font-size:14px;font-weight:600;}
.dsh-bc-center-body{font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;}
.dsh-bc-failure{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;max-width:520px;display:flex;flex-direction:column;gap:8px;align-items:flex-start;background:var(--dsw-alias-bg-layer-1);}
.dsh-bc-failure .dsh-bc-center-body{color:var(--dsw-alias-state-error-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;}
.dsh-bc-veil{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:3;pointer-events:none;}
.dsh-bc-veil-pill{padding:6px 14px;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);font-size:12.5px;color:var(--dsw-alias-label-primary);}
.dsh-bc-body{display:flex;gap:14px;flex:1 1 auto;min-height:0;}
.dsh-bc-rail{flex:0 0 300px;min-width:0;display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;min-height:0;}
.dsh-bc-rail-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex:0 0 auto;min-width:0;}
.dsh-bc-rail-title{font-size:12.5px;font-weight:600;flex:0 0 auto;}
.dsh-bc-rail-live{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:62%;}
.dsh-bc-rail-list{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;}
.dsh-bc-rail-empty{font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);padding:6px 2px;}
.dsh-bc-act{padding:6px 2px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:3px;}
.dsh-bc-act:last-child{border-bottom:0;}
.dsh-bc-act-top{display:flex;align-items:center;gap:6px;min-width:0;}
.dsh-bc-act-time{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:0 0 auto;}
.dsh-bc-act-dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:0 0 auto;}
.dsh-bc-act-dot.is-error{background:var(--dsw-alias-state-error-primary);}
.dsh-bc-act-label{font-size:12px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0;}
.dsh-bc-act-dur{font-size:10.5px;color:var(--dsw-alias-label-secondary);flex:0 0 auto;font-variant-numeric:tabular-nums;}
.dsh-bc-act-sub{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-secondary);min-width:0;}
.dsh-bc-act-source{padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);font-size:10px;flex:0 0 auto;}
.dsh-bc-act-page{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px;}
.dsh-bc-act-errors{color:var(--dsw-alias-state-warn-primary);flex:0 0 auto;}
.dsh-bc-act-error{font-size:10.5px;line-height:1.45;color:var(--dsw-alias-state-error-primary);word-break:break-word;}
.dsh-bc-act-thumb{margin-top:2px;width:64px;height:38px;object-fit:cover;object-position:top left;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);cursor:zoom-in;background:var(--dsw-alias-bg-layer-2);}
.dsh-bc-act-preview{margin-top:4px;width:100%;max-height:260px;object-fit:contain;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);cursor:zoom-out;}
@media (max-width:960px){.dsh-bc-body{flex-direction:column;}.dsh-bc-rail{flex:0 0 auto;max-height:34%;}}
.dsh-bc-waiting{font-size:12.5px;color:var(--dsw-alias-label-secondary);}
.dsh-bc-meta{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);flex:0 0 auto;}
.dsh-bc-meta-item{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:100%;}
.dsh-bc-meta-item code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px;}
.dsh-bc-errors{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:4px;max-height:92px;overflow:auto;flex:0 0 auto;}
.dsh-bc-errors-title{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);}
.dsh-bc-error-line{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;word-break:break-word;}
.dsh-bc-notice{display:flex;align-items:flex-start;gap:10px;border-radius:10px;padding:9px 12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12.5px;line-height:1.5;flex:0 0 auto;}
.dsh-bc-notice button{margin-left:auto;border:0;background:none;color:inherit;font-size:12px;cursor:pointer;text-decoration:underline;padding:0;font-family:inherit;flex:0 0 auto;}
.dsh-bc-linkbtn{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1;cursor:pointer;padding:3px 6px;border-radius:6px;font-family:inherit;white-space:nowrap;flex:0 0 auto;}
.dsh-bc-linkbtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}
`

    const TAB_CSS = `
.dsh-bc-tab{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}
.dsh-bc-tab-stage{position:relative;flex:0 0 auto;height:36%;min-height:110px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);overflow:hidden;}
.dsh-bc-tab-frame{max-width:100%;max-height:100%;object-fit:contain;display:block;}
.dsh-bc-tab-empty{padding:18px 20px;text-align:center;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:10px;align-items:center;}
.dsh-bc-tab-badge{position:absolute;top:8px;left:8px;display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-secondary);z-index:2;}
.dsh-bc-tab-badge .dsh-bc-dot{width:6px;height:6px;}
.dsh-bc-tab-readonly{position:absolute;right:8px;bottom:8px;padding:2px 6px;border-radius:4px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);font-size:10px;color:var(--dsw-alias-label-secondary);z-index:2;}
.dsh-bc-tab-live{flex:0 0 auto;padding:8px 12px 7px;font-size:11.5px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-bc-tab-list{flex:1 1 auto;min-height:0;overflow:auto;padding:2px 8px;}
.dsh-bc-tab-row{display:flex;align-items:center;gap:6px;padding:5px 3px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11.5px;min-width:0;}
.dsh-bc-tab-row:last-child{border-bottom:0;}
.dsh-bc-tab-thumb{width:40px;height:24px;object-fit:cover;object-position:top left;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);cursor:zoom-in;flex:0 0 auto;background:var(--dsw-alias-bg-layer-2);}
.dsh-bc-tab-preview{display:block;width:calc(100% - 6px);max-height:240px;object-fit:contain;margin:2px 3px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);cursor:zoom-out;}
.dsh-bc-tab-row-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-bc-tab-empty-list{padding:12px 4px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);}
.dsh-bc-tab-foot{flex:0 0 auto;padding:6px 12px;font-size:10.5px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-bc-head-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:0 0 auto;}
.dsh-bc-head-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
`

    const STRIP_CSS = `
.dsh-bc-strip{display:flex;align-items:center;gap:7px;box-sizing:border-box;width:fit-content;max-width:min(100%,760px);margin:0 auto 6px;align-self:center;padding:3px 5px 3px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary);min-height:30px;}
.dsh-bc-strip-main{display:flex;align-items:center;gap:7px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:0;min-width:0;flex:0 1 auto;text-align:left;}
.dsh-bc-strip-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:520px;}
.dsh-bc-strip-thumb{width:44px;height:26px;object-fit:cover;object-position:top left;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);cursor:pointer;flex:0 0 auto;background:var(--dsw-alias-bg-layer-2);}
.dsh-bc-strip-view{border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;cursor:pointer;padding:3px 9px 3px 6px;border-radius:999px;flex:0 0 auto;white-space:nowrap;}
.dsh-bc-strip-view:hover{background:var(--dsw-alias-bg-layer-2);}
`

    const V16_CSS = `
.dsh-bc-page.dsh-bc-v16{padding:0;gap:0;background:var(--dsw-alias-bg-base);}
.dsh-bc16{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);overflow:hidden;}
.dsh-bc16-toolbar{height:48px;flex:0 0 48px;display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);min-width:0;}
.dsh-bc16-toolbar-main{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto;}
.dsh-bc16-toolbar-side{display:flex;align-items:center;gap:6px;flex:0 0 auto;position:relative;}
.dsh-bc16-new{position:relative;display:inline-flex;align-items:center;}
.dsh-bc16-newmenu{position:absolute;top:34px;right:0;z-index:24;width:min(280px,72vw);max-height:320px;overflow:auto;padding:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 30px rgba(0,0,0,.34);display:flex;flex-direction:column;gap:1px;}
.dsh-bc16-new-head{padding:6px 8px 7px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);}
.dsh-bc16-new-empty{padding:10px 8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);}
.dsh-bc16-new-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11.5px;text-align:left;cursor:pointer;}
.dsh-bc16-new-item:hover,.dsh-bc16-new-item:focus-visible{background:var(--dsw-alias-bg-layer-2);outline:none;}
.dsh-bc16-new-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-bc16-new-tag{flex:0 0 auto;padding:2px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;}
.dsh-bc16-icon{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:15px;line-height:1;padding:0;flex:0 0 auto;}
.dsh-bc16-icon:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.dsh-bc16-icon:focus-visible,.dsh-bc16-btn:focus-visible,.dsh-bc16-tile:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.dsh-bc16-icon:disabled{opacity:.45;cursor:default;}
.dsh-bc16-stat{display:flex;align-items:center;gap:7px;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-bc16-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px;}
.dsh-bc16-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-bc16-btn{height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap;}
.dsh-bc16-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);}
.dsh-bc16-btn:disabled{opacity:.45;cursor:default;}
.dsh-bc16-btn.is-live{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}
.dsh-bc16-body{flex:1 1 auto;min-height:0;display:flex;gap:14px;padding:16px 18px;overflow:hidden;}
.dsh-bc16-grid-wrap{flex:1 1 auto;min-width:0;min-height:0;overflow:auto;padding:2px 2px 10px;}
.dsh-bc16-grid{display:flex;flex-wrap:wrap;justify-content:center;align-content:flex-start;gap:14px;min-height:0;}
.dsh-bc16-tile{position:relative;flex:0 0 auto;aspect-ratio:1.61;min-width:170px;max-width:640px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:visible;background:var(--dsw-alias-bg-layer-1);cursor:pointer;isolation:isolate;padding:0;font-family:inherit;color:inherit;text-align:left;transition:border-color .15s ease,transform .15s ease;}
.dsh-bc16-tile:hover{border-color:var(--dsw-alias-border-l2);transform:translateY(-1px);}
.dsh-bc16-tile.is-active{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary) inset;}
.dsh-bc16-tile.is-menu{z-index:12;}
.dsh-bc16-tile-media{position:absolute;inset:0;overflow:hidden;border-radius:11px;background:var(--dsw-alias-bg-layer-2);}
.dsh-bc16-tile-frame{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top left;background:var(--dsw-alias-bg-layer-2);display:block;}
.dsh-bc16-tile-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,14,22,.42) 0%,rgba(10,14,22,.02) 32%,rgba(10,14,22,.02) 48%,rgba(10,14,22,.88) 100%);pointer-events:none;}
.dsh-bc16-tile-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:6px;padding:10px 11px;z-index:2;min-width:0;}
.dsh-bc16-tile-top .dsh-bc16-icon{color:#f3f5f9;background:rgba(10,14,22,.28);border-color:rgba(255,255,255,.14);width:24px;height:24px;font-size:14px;}
.dsh-bc16-tile-badge{font-size:10px;line-height:1;padding:4px 6px;border-radius:5px;background:rgba(10,14,22,.55);backdrop-filter:blur(6px);color:#f3f5f9;white-space:nowrap;flex:0 0 auto;}
.dsh-bc16-tile-badge.is-active{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);}
.dsh-bc16-tile-error{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 6px;border-radius:5px;background:rgba(120,28,34,.55);color:#ffd7d9;font-size:10px;flex:0 0 auto;border:0;font-family:inherit;cursor:pointer;}
.dsh-bc16-tile-bottom{position:absolute;left:0;right:0;bottom:0;padding:11px 12px 12px;z-index:2;color:#f7f8fb;min-width:0;}
.dsh-bc16-tile-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 1px 3px rgba(0,0,0,.5);}
.dsh-bc16-tile-url{font-size:10.5px;line-height:1.4;opacity:.78;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;}
.dsh-bc16-tile-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:11.5px;background:var(--dsw-alias-bg-layer-2);}
.dsh-bc16-menu{position:absolute;top:30px;right:8px;z-index:8;min-width:150px;padding:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px rgba(0,0,0,.3);display:flex;flex-direction:column;gap:1px;}
.dsh-bc16-menu button{display:block;width:100%;padding:7px 9px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11.5px;text-align:left;cursor:pointer;white-space:nowrap;}
.dsh-bc16-menu button:hover{background:var(--dsw-alias-bg-layer-2);}
.dsh-bc16-menu button.is-danger{color:var(--dsw-alias-state-error-primary);}
.dsh-bc16-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;color:var(--dsw-alias-label-secondary);padding:28px;}
.dsh-bc16-empty-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);}
.dsh-bc16-empty-body{font-size:12px;line-height:1.65;max-width:360px;}
.dsh-bc16-empty .dsh-bc16-btn{margin-top:4px;}
.dsh-bc16-stage{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;gap:8px;overflow:hidden;}
.dsh-bc16-canvas{position:relative;flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}
.dsh-bc16-canvas img{max-width:100%;max-height:100%;display:block;object-fit:contain;background:var(--dsw-alias-bg-layer-1);}
.dsh-bc16-canvas-center{padding:24px;text-align:center;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-width:420px;}
.dsh-bc16-live-chip{position:absolute;top:10px;left:10px;display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:6px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-primary);z-index:2;}
.dsh-bc16-foot{flex:0 0 auto;display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);min-width:0;}
.dsh-bc16-foot code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:320px;}
.dsh-bc16-rail{flex:0 0 300px;min-width:0;min-height:0;display:flex;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l1);padding-left:14px;overflow:hidden;}
.dsh-bc16-rail-head{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:1px 0 8px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);}
.dsh-bc16-rail-list{flex:1 1 auto;min-height:0;overflow:auto;padding-right:2px;}
.dsh-bc16-log{display:flex;gap:8px;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0;}
.dsh-bc16-log-thumb{width:84px;height:53px;flex:0 0 auto;border-radius:5px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}
.dsh-bc16-log-thumb img{width:100%;height:100%;display:block;object-fit:cover;object-position:top left;}
.dsh-bc16-log-body{min-width:0;display:flex;flex-direction:column;gap:2px;font-size:11px;line-height:1.4;}
.dsh-bc16-log-time{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);font-size:10px;}
.dsh-bc16-log-label{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-bc16-log-sub{color:var(--dsw-alias-label-secondary);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-bc16-log-icon{width:28px;height:28px;flex:0 0 auto;margin-top:3px;display:flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1;}
.dsh-bc16-log-age{padding:9px 0 4px;font-size:10px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);}
.dsh-bc16-log-error{color:var(--dsw-alias-state-error-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:1.45;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.dsh-bc16-errors{position:absolute;top:34px;right:0;z-index:20;width:min(380px,calc(100vw - 48px));max-height:340px;overflow:auto;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px rgba(0,0,0,.35);}
.dsh-bc16-error-line{padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:1.5;color:var(--dsw-alias-state-error-primary);word-break:break-word;}
.dsh-bc16-error-line:last-child{border-bottom:0;}
.dsh-bc16-error-session{font-size:10px;color:var(--dsw-alias-label-secondary);margin-bottom:2px;}
.dsh-bc16-error-empty{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:4px 0;}
.dsh-bc16-notice{flex:0 0 auto;margin:8px 18px 0;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:11.5px;display:flex;align-items:center;gap:8px;}
.dsh-bc16-notice button{margin-left:auto;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:2px 4px;}
@media (max-width:1100px){.dsh-bc16-rail{display:none;}.dsh-bc16-body{padding:12px;}}
@media (max-width:720px){.dsh-bc16-toolbar{padding:0 10px;gap:4px;}.dsh-bc16-title{max-width:180px;}.dsh-bc16-body{padding:8px;gap:8px;}.dsh-bc16-grid{gap:10px;}.dsh-bc16-tile{min-width:140px;}.dsh-bc16-foot{padding-bottom:2px;}}
@media (prefers-reduced-motion:reduce){.dsh-bc16-tile{transition:none;}.dsh-bc16-tile:hover{transform:none;}}
`

    /** Sidebar navigation glyph. */
    function BrowserPanelIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 20
      const active = props.active === true
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 20 20',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block', color: 'currentColor', opacity: active ? 1 : 0.88 },
      },
        h('rect', { x: 2.4, y: 3.4, width: 15.2, height: 13.2, rx: 2.6, stroke: 'currentColor', strokeWidth: 1.35 }),
        h('path', { d: 'M2.4 7.3h15.2', stroke: 'currentColor', strokeWidth: 1.35 }),
        h('circle', { cx: 4.9, cy: 5.4, r: 0.68, fill: 'currentColor' }),
        h('circle', { cx: 7.3, cy: 5.4, r: 0.68, fill: 'currentColor' }),
        h('path', { d: 'M8.2 9.5v6.4l1.6-1.6 1.1 2.4 1.5-.7-1.1-2.3 2.2-.3z', fill: 'currentColor', opacity: active ? 1 : 0.9 }),
      )
    }

    function EmptyGlyph() {
      return h('svg', { className: 'dsh-bc-glyph', width: 56, height: 56, viewBox: '0 0 56 56', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 7, y: 11, width: 42, height: 34, rx: 7, stroke: 'currentColor', strokeWidth: 2 }),
        h('path', { d: 'M7 20.5h42', stroke: 'currentColor', strokeWidth: 2 }),
        h('circle', { cx: 13, cy: 16, r: 1.6, fill: 'currentColor' }),
        h('circle', { cx: 18.5, cy: 16, r: 1.6, fill: 'currentColor' }),
        h('path', { d: 'M22 27h14M22 33h9', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
      )
    }

    /** Shorten one display string without breaking surrogate pairs. */
    function shorten(value, max) {
      const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
      return text.length <= max ? text : `${text.slice(0, max - 1)}…`
    }

    /** Clock label for one activity entry. */
    function formatClock(at) {
      try {
        return new Date(at).toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      } catch {
        return ''
      }
    }

    /** Compact duration label. */
    function formatDuration(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value < 0) return ''
      return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`
    }

    /** The localized one-line description of one activity entry. */
    function activityLabel(t, entry) {
      const kind = String(entry?.kind ?? 'other').replace(/^human-/u, '')
      const detail = entry?.detail ?? {}
      switch (kind) {
        case 'open':
          return t('act.open', { url: shorten(detail.url, 46) })
        case 'read-page':
          return t('act.read-page')
        case 'click':
          return typeof detail.targetLabel === 'string' && detail.targetLabel !== ''
            ? t('act.click', { target: shorten(detail.targetLabel, 26) })
            : t('act.clickRef', { target: shorten(detail.target, 22) || '—' })
        case 'type':
          return typeof detail.targetLabel === 'string' && detail.targetLabel !== ''
            ? t('act.typeInto', { text: shorten(detail.text, 18), target: shorten(detail.targetLabel, 18) })
            : t('act.type', { text: shorten(detail.text, 24) })
        case 'key':
          return t('act.key', { key: shorten(detail.key, 14) || '—' })
        case 'wait': {
          const parts = []
          if (typeof detail.text === 'string' && detail.text !== '') parts.push(`“${shorten(detail.text, 24)}”`)
          if (typeof detail.selector === 'string' && detail.selector !== '') parts.push(shorten(detail.selector, 24))
          if (typeof detail.target === 'string' && detail.target !== '') parts.push(shorten(detail.target, 24))
          if (typeof detail.url === 'string' && detail.url !== '') parts.push(shorten(detail.url, 24))
          if (detail.networkIdle === true) parts.push(t('act.waitNetwork'))
          return t('act.wait', { target: parts.join(' + ') || '—' })
        }
        case 'assert':
          return t('act.assert', { condition: shorten(detail.condition, 30) || '—' })
        case 'network':
          return t('act.network', { action: detail.action === 'detail' ? 'detail' : 'list' })
        case 'styles':
          return t('act.styles')
        case 'emulate': {
          const parts = []
          if (typeof detail.network === 'string' && detail.network !== '') parts.push(detail.network)
          if (typeof detail.colorScheme === 'string' && detail.colorScheme !== '') parts.push(detail.colorScheme)
          if (detail.mobile === true) parts.push('mobile')
          if (detail.clear === true) parts.push('clear')
          return t('act.emulate', { what: parts.join(' / ') || 'device' })
        }
        case 'performance':
          return t('act.performance')
        case 'highlight':
          return t('act.highlight', { target: shorten(detail.target, 24) || '—' })
        case 'route':
          return t('act.route', {
            action: detail.action ?? 'list',
            pattern: shorten(detail.urlPattern, 32) || '*',
          })
        case 'cookies':
          return t('act.cookies', { action: detail.action ?? 'list' })
        case 'storage':
          return t('act.storage', { action: `${detail.type ?? 'local'} ${detail.action ?? 'list'}` })
        case 'download':
          return t('act.download', { action: detail.action ?? 'list' })
        case 'hover':
          return t('act.hover', { target: shorten(detail.target, 24) || '—' })
        case 'drag':
          return t('act.drag', {
            from: shorten(detail.from, 16) || '—',
            to: shorten(detail.to, 16) || '—',
          })
        case 'fill-form':
          return t('act.fill-form', { count: detail.count ?? 0 })
        case 'select':
          return t('act.select', { target: shorten(detail.target, 20) || '—' })
        case 'upload':
          return t('act.upload', { count: detail.count ?? 0 })
        case 'tabs':
          return t('act.tabs', { action: detail.action ?? 'list' })
        case 'dialog':
          return detail.accept === true ? t('act.dialogAccept') : t('act.dialogDismiss')
        case 'scroll':
          return t('act.scroll', { direction: String(detail.direction ?? 'down') })
        case 'eval':
          return t('act.eval')
        case 'read-console':
          return t('act.read-console')
        case 'screenshot':
          return t('act.screenshot')
        case 'resize':
          return t('act.resize', { width: detail.width ?? '—', height: detail.height ?? '—' })
        case 'close':
          return t('act.close')
        default:
          return t('act.other')
      }
    }

    /** Render one activity timeline row. */
    function activityRow(t, entry, expandedId, onToggle) {
      const label = activityLabel(t, entry)
      const source = entry.source === 'human' ? t('activity.you') : t('activity.agent')
      const pageName = entry.page !== null && entry.page !== undefined && typeof entry.page === 'object'
        ? (entry.page.title !== '' ? entry.page.title : shorten(entry.page.url, 40))
        : ''
      const expanded = expandedId === entry.id
      return h('div', { className: 'dsh-bc-act', key: entry.id },
        h('div', { className: 'dsh-bc-act-top' },
          h('span', { className: 'dsh-bc-act-time' }, formatClock(entry.at)),
          h('span', { className: `dsh-bc-act-dot${entry.status === 'error' ? ' is-error' : ''}` }),
          h('span', { className: 'dsh-bc-act-label', title: label }, label),
          h('span', { className: 'dsh-bc-act-dur' }, formatDuration(entry.durationMs)),
        ),
        h('div', { className: 'dsh-bc-act-sub' },
          h('span', { className: 'dsh-bc-act-source' }, source),
          pageName === '' ? null : h('span', { className: 'dsh-bc-act-page', title: entry.page?.url ?? '' }, shorten(pageName, 34)),
          entry.errorDelta > 0 ? h('span', { className: 'dsh-bc-act-errors' }, t('activity.errors', { count: entry.errorDelta })) : null,
        ),
        entry.status === 'error' && typeof entry.error === 'string' && entry.error !== ''
          ? h('div', { className: 'dsh-bc-act-error' }, shorten(entry.error, 180))
          : null,
        entry.hasThumb === true
          ? h('img', {
              className: expanded ? 'dsh-bc-act-preview' : 'dsh-bc-act-thumb',
              src: `${BASE}thumb/${entry.id}`,
              alt: label,
              loading: 'lazy',
              onClick: () => onToggle(expanded ? null : entry.id),
            })
          : null,
      )
    }

    /** Translator shared by the newer surfaces. */
    function makeTranslator(props) {
      return (key, vars) => {
        let value = FALLBACK[key] ?? key
        if (typeof props.t === 'function') {
          const translated = props.t(key)
          if (typeof translated === 'string' && translated !== '' && translated !== key) value = translated
        }
        if (vars !== undefined) {
          for (const [name, replacement] of Object.entries(vars)) value = value.replace(`{${name}}`, String(replacement))
        }
        return value
      }
    }

    const TAB_DISMISS_PREFIX = 'dsh.browser-control.tab-dismissed.'
    const LAST_URL_KEY = 'dsh.browser-cockpit.last-url'

    /** The last page opened from the cockpit, so other ports do not need retyping. */
    function readLastUrl() {
      try {
        return localStorage.getItem(LAST_URL_KEY) ?? ''
      } catch {
        return ''
      }
    }

    function rememberLastUrl(url) {
      try {
        if (typeof url === 'string' && url !== '' && url !== 'about:blank') localStorage.setItem(LAST_URL_KEY, url)
      } catch {
        // Private-mode storage may refuse writes; the address simply is not remembered.
      }
    }

    /** How many live-tab bodies are currently on screen; one when the tab is visible. */
    let mountedBrowserTabs = 0

    /** Whether our live tab body is actually rendered beside the conversation. */
    function browserTabVisible() {
      if (mountedBrowserTabs === 0) return false
      try {
        const element = document.querySelector('.dsh-bc-tab')
        if (element === null) return false
        const rect = element.getBoundingClientRect()
        // A collapsed column can keep the body mounted but display:none or off-screen.
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth
      } catch {
        return mountedBrowserTabs > 0
      }
    }

    function tabDismissKey(sessionId) {
      return `${TAB_DISMISS_PREFIX}${String(sessionId)}`
    }

    /** Whether the user closed our tab for this Session and asked not to be re-opened. */
    function isTabDismissed(sessionId) {
      try {
        return sessionId !== undefined && localStorage.getItem(tabDismissKey(sessionId)) === '1'
      } catch {
        return false
      }
    }

    function dismissBrowserTab(sessionId) {
      try {
        if (sessionId !== undefined) localStorage.setItem(tabDismissKey(sessionId), '1')
      } catch {
        // Private-mode storage may refuse writes; dismissal then simply does not persist.
      }
    }

    function clearTabDismissed(sessionId) {
      try {
        if (sessionId !== undefined) localStorage.removeItem(tabDismissKey(sessionId))
      } catch {
        // See dismissBrowserTab.
      }
    }

    /** Open the live tab in the right sidebar, revealing the column. */
    function openBrowserTab(ctx, sessionId) {
      clearTabDismissed(sessionId)
      try {
        ctx.get('layout')?.openRightbar(true, false)
      } catch {
        // The layout service may be unavailable in a non-Web host.
      }
      try {
        ctx.get('sidebarRight')?.openTab(BROWSER_TAB_KIND)
      } catch {
        // Without an adopted Session the sidebar has nothing to open into.
      }
    }

    /**
     * Live JPEG frames: one SSE stream from the Host with a polling fallback.
     * Frames arrive as `event: frame`; `EventSource` reconnects on transient
     * errors, so a hard error closes it and switches to `/frame.jpg` polling.
     */
    function useLiveFrame(running) {
      const [frameUrl, setFrameUrl] = useState(null)
      const [frameAt, setFrameAt] = useState(0)
      useEffect(() => {
        if (!running) {
          setFrameUrl(null)
          setFrameAt(0)
          return undefined
        }
        let alive = true
        let source = null
        let timer
        let objectUrl = null
        const accept = (url) => {
          if (!alive) return
          setFrameUrl(url)
          setFrameAt(Date.now())
        }
        const poll = async () => {
          try {
            const response = await fetch(`${BASE}frame.jpg`, { cache: 'no-store' })
            if (response.ok) {
              const blob = await response.blob()
              if (alive) {
                const next = URL.createObjectURL(blob)
                const previous = objectUrl
                objectUrl = next
                accept(next)
                if (previous !== null) setTimeout(() => URL.revokeObjectURL(previous), 1200)
              }
            }
          } catch {
            // Keep the last frame; the freshness badge reports the gap.
          }
          if (alive) timer = setTimeout(poll, 1100)
        }
        if (typeof EventSource === 'function') {
          try {
            source = new EventSource(`${BASE}stream`)
            source.addEventListener('frame', (event) => {
              if (alive) accept(`data:image/jpeg;base64,${event.data}`)
            })
            source.addEventListener('error', () => {
              if (!alive) return
              source?.close()
              source = null
              void poll()
            })
          } catch {
            source = null
            void poll()
          }
        } else {
          void poll()
        }
        return () => {
          alive = false
          clearTimeout(timer)
          source?.close()
          if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
        }
      }, [running])
      return { frameUrl, frameAt }
    }

    /** All conversations that currently own a browser context, with live frames. */
    function useOverviewFeed() {
      const [overview, setOverview] = useState({ sessions: [], activeSessionId: null })
      const [frames, setFrames] = useState({})
      const [connected, setConnected] = useState(false)
      useEffect(() => {
        let alive = true
        let source = null
        let retry
        const acceptSessions = (next) => {
          if (!alive || next === null || typeof next !== 'object' || !Array.isArray(next.sessions)) return
          setOverview({ sessions: next.sessions.slice(0, 6), activeSessionId: next.activeSessionId ?? null })
        }
        const acceptFrame = (payload) => {
          if (!alive || typeof payload?.sessionId !== 'string' || typeof payload?.jpeg !== 'string') return
          const url = `data:image/jpeg;base64,${payload.jpeg}`
          setFrames((previous) => ({ ...previous, [payload.sessionId]: url }))
        }
        const refresh = async () => {
          try {
            const response = await fetch(`${BASE}overview`, { cache: 'no-store' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const next = await response.json()
            acceptSessions(next)
            for (const entry of next.sessions ?? []) {
              if (typeof entry.sessionId !== 'string') continue
              fetch(`${BASE}overview/frame.jpg?sessionId=${encodeURIComponent(entry.sessionId)}`, { cache: 'no-store' })
                .then((frame) => frame.ok ? frame.blob() : null)
                .then((blob) => {
                  if (!alive || blob === null) return
                  const reader = new FileReader()
                  reader.onload = () => {
                    if (!alive || typeof reader.result !== 'string') return
                    setFrames((previous) => ({ ...previous, [entry.sessionId]: reader.result }))
                  }
                  reader.readAsDataURL(blob)
                })
                .catch(() => {})
            }
          } catch {
            if (alive) setConnected(false)
          }
        }
        const start = () => {
          if (!alive) return
          try {
            source = new EventSource(`${BASE}overview/stream`)
            source.onopen = () => { if (alive) setConnected(true) }
            source.addEventListener('sessions', (event) => {
              try { acceptSessions(JSON.parse(event.data)) } catch { /* ignore a malformed frame */ }
            })
            source.addEventListener('frame', (event) => {
              try { acceptFrame(JSON.parse(event.data)) } catch { /* ignore a malformed frame */ }
            })
            source.addEventListener('error', () => {
              if (!alive) return
              setConnected(false)
              source?.close()
              source = null
              retry = setTimeout(() => { void refresh().finally(start) }, 3000)
            })
          } catch {
            source = null
            retry = setTimeout(() => { void refresh().finally(start) }, 3000)
          }
        }
        void refresh()
        start()
        const onOverview = (event) => {
          if (event instanceof CustomEvent) acceptSessions(event.detail)
        }
        window.addEventListener('dsh-bc-overview', onOverview)
        return () => {
          alive = false
          clearTimeout(retry)
          source?.close()
          window.removeEventListener('dsh-bc-overview', onOverview)
        }
      }, [])
      return { overview, frames, connected }
    }

    /** Read-only preview of one conversation's page, independent of the active tab. */
    function useSessionPreview(sessionId, enabled, width = 1280) {
      const [frameUrl, setFrameUrl] = useState(null)
      const [frameAt, setFrameAt] = useState(0)
      const [failed, setFailed] = useState(false)
      useEffect(() => {
        if (!enabled || typeof sessionId !== 'string' || sessionId === '') {
          setFrameUrl(null)
          setFrameAt(0)
          setFailed(false)
          return undefined
        }
        let alive = true
        let timer = null
        let current = null
        const tick = () => {
          if (!alive) return
          const url = `${BASE}session/frame.jpg?sessionId=${encodeURIComponent(sessionId)}&w=${width}&t=${Date.now()}`
          const image = new Image()
          current = image
          image.onload = () => {
            if (!alive || current !== image) return
            setFailed(false)
            setFrameUrl(url)
            setFrameAt(Date.now())
          }
          image.onerror = () => {
            if (!alive || current !== image) return
            if (frameUrl === null) setFailed(true)
          }
          image.src = url
        }
        tick()
        timer = setInterval(tick, 1500)
        return () => {
          alive = false
          if (timer !== null) clearInterval(timer)
          if (current !== null) {
            current.onload = null
            current.onerror = null
          }
        }
      }, [sessionId, enabled, width])
      return { frameUrl, frameAt, failed }
    }

    /** State, activity, and live frames for the compact right-sidebar tab. */
    function useBrowserTabFeed(sessionId) {
      const feed = useSharedFeed()
      const [now, setNow] = useState(Date.now())

      useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(id)
      }, [])

      const active = typeof sessionId === 'string' && feed.state?.activeSessionId === sessionId
      const running = active && feed.state?.running === true
      const live = useLiveFrame(running)
      return { state: feed.state, activity: feed.activity, current: feed.current, offline: feed.offline, active, ...live, now, running }
    }

    /** Compact live view and timeline shown in the right sidebar beside the conversation. */
    function BrowserTabBody(props) {
      const t = makeTranslator(props)
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : null
      const feed = useBrowserTabFeed(sessionId)
      const [expanded, setExpanded] = useState(null)
      useEffect(() => {
        mountedBrowserTabs += 1
        return () => {
          mountedBrowserTabs = Math.max(0, mountedBrowserTabs - 1)
        }
      }, [])
      const phase = feed.offline ? 'offline' : typeof feed.state?.phase === 'string' ? feed.state.phase : 'stopped'
      const statusClass = phase === 'running' ? 'is-running' : phase === 'starting' ? 'is-starting' : phase === 'failed' || phase === 'offline' ? 'is-failed' : ''
      const statusLabel = t(phase === 'running' ? 'status.running' : phase === 'starting' ? 'status.starting' : phase === 'failed' ? 'status.failed' : phase === 'offline' ? 'status.offline' : 'status.stopped')
      const frameAge = feed.frameAt === 0 ? Number.POSITIVE_INFINITY : feed.now - feed.frameAt
      const badgeText = !feed.active
        ? t('tab.inactive')
        : phase === 'running'
          ? `${statusLabel} · ${frameAge < FRESH_MS ? t('stage.live') : t('stage.paused')}`
          : statusLabel
      // Panel/CLI actions carry no session id; including them would leak one
      // conversation's activity into every tab and pill.
      const belongs = (entry) => typeof sessionId === 'string' && entry.sessionId === sessionId
      const relevant = feed.activity.filter(belongs)
      const currentHere = feed.current !== null && belongs(feed.current) ? feed.current : null
      const newest = relevant.length > 0 ? relevant[0] : null
      const liveLabel = currentHere !== null
        ? t('activity.now', { label: activityLabel(t, currentHere) })
        : newest !== null && feed.now - Number(newest.finishedAt ?? newest.at) < 6000
          ? t('activity.justNow', { label: activityLabel(t, newest) })
          : newest !== null
            ? activityLabel(t, newest)
            : t('tab.waiting')
      const url = feed.active && typeof feed.state?.url === 'string' && feed.state.url !== 'about:blank' ? feed.state.url : ''
      const viewport = feed.state === null ? '' : `${feed.state.width}×${feed.state.height}`

      return h('div', { className: 'dsh-bc-tab' },
        h('style', null, TAB_CSS),
        h('div', { className: 'dsh-bc-tab-stage' },
          feed.active
            ? feed.frameUrl !== null
              ? h('img', { className: 'dsh-bc-tab-frame', src: feed.frameUrl, alt: typeof feed.state?.title === 'string' ? feed.state.title : t('panel') })
              : h('div', { className: 'dsh-bc-tab-empty' },
                  h('span', null, t('tab.empty')),
                  h('button', { className: 'dsh-bc-btn', type: 'button', onClick: () => props.onOpenPanel?.() }, t('tab.openPanel')),
                )
            : h('div', { className: 'dsh-bc-tab-empty' },
                h('span', null, t('tab.inactive.body')),
                h('button', { className: 'dsh-bc-btn', type: 'button', onClick: () => props.onOpenPanel?.() }, t('tab.openPanel')),
              ),
          h('div', { className: 'dsh-bc-tab-badge', role: 'status', 'aria-live': 'polite' },
            h('span', { className: `dsh-bc-dot ${statusClass}`.trim() }),
            h('span', null, badgeText),
          ),
          feed.active && feed.frameUrl !== null ? h('div', { className: 'dsh-bc-tab-readonly' }, t('stage.readonly')) : null,
        ),
        h('div', { className: 'dsh-bc-tab-live', title: liveLabel }, liveLabel),
        h('div', { className: 'dsh-bc-tab-list' },
          relevant.length === 0
            ? h('div', { className: 'dsh-bc-tab-empty-list' }, t('activity.empty'))
            : relevant.slice(0, 30).map((entry) => {
                const label = activityLabel(t, entry)
                const isExpanded = expanded === entry.id
                return h(React.Fragment, { key: entry.id },
                  h('div', { className: 'dsh-bc-tab-row' },
                    h('span', { className: 'dsh-bc-act-time' }, formatClock(entry.at)),
                    h('span', { className: `dsh-bc-act-dot${entry.status === 'error' ? ' is-error' : ''}` }),
                    entry.hasThumb === true
                      ? h('img', {
                          className: 'dsh-bc-tab-thumb',
                          src: `${BASE}thumb/${entry.id}`,
                          alt: '',
                          loading: 'lazy',
                          onClick: () => setExpanded(isExpanded ? null : entry.id),
                        })
                      : null,
                    h('span', { className: 'dsh-bc-tab-row-label', title: label }, label),
                    h('span', { className: 'dsh-bc-act-dur' }, formatDuration(entry.durationMs)),
                  ),
                  isExpanded
                    ? h('img', {
                        className: 'dsh-bc-tab-preview',
                        src: `${BASE}thumb/${entry.id}`,
                        alt: label,
                        onClick: () => setExpanded(null),
                      })
                    : null,
                )
              }),
        ),
        h('div', { className: 'dsh-bc-tab-foot', title: url }, url === '' ? t('panel') : t('tab.foot', { url: shorten(url, 46), width: viewport.split('×')[0], height: viewport.split('×')[1] })),
      )
    }

    /** Session-header icon that reveals the live tab beside the conversation. */
    function BrowserHeaderButton(props) {
      const t = makeTranslator(props)
      return h(React.Fragment, null,
        h('style', null, TAB_CSS),
        h('button', {
          className: 'dsh-bc-head-btn',
          type: 'button',
          title: t('header.open'),
          'aria-label': t('header.open'),
          onClick: () => props.onOpen?.(),
        }, h(BrowserPanelIcon, { size: 18 })),
      )
    }

    /**
     * Slim status strip above the composer: shows the agent's current or last
     * browser action for this Session, reveals the live tab, and auto-opens that
     * tab on the first agent action unless the user closed it.
     */
    function BrowserStrip(props) {
      const t = makeTranslator(props)
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : null
      const feed = useSharedFeed()
      const activity = feed.activity
      const current = feed.current
      const [now, setNow] = useState(Date.now())
      const seenRef = useRef(0)
      const readyRef = useRef(false)
      const autoOpenedRef = useRef(false)

      useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(id)
      }, [])

      useEffect(() => {
        if (!feed.loaded) {
          readyRef.current = false
          seenRef.current = 0
          return
        }
        if (readyRef.current) return
        // The first complete read is history; only later actions may auto-open the tab.
        readyRef.current = true
        seenRef.current = feed.lastId
      }, [feed.loaded, feed.lastId])

      // Panel/CLI actions carry no session id; including them would leak one
      // conversation's activity into every tab and pill.
      const belongs = (entry) => typeof sessionId === 'string' && entry.sessionId === sessionId
      const currentHere = current !== null && belongs(current) ? current : null
      const relevant = activity.filter(belongs)
      const newest = relevant.length > 0 ? relevant[0] : null

      useEffect(() => {
        if (typeof props.autoOpen === 'boolean' && !props.autoOpen) return
        if (autoOpenedRef.current) return
        if (props.isTabOpen?.() === true) {
          autoOpenedRef.current = true
          return
        }
        if (props.isDismissed?.() === true) {
          autoOpenedRef.current = true
          return
        }
        if (current !== null && belongs(current) && current.source === 'agent') {
          autoOpenedRef.current = true
          props.onOpen?.()
          return
        }
        if (!readyRef.current) return
        const newestId = activity.length > 0 ? activity[0].id : 0
        const fresh = activity.filter((entry) => entry.id > seenRef.current && belongs(entry))
        seenRef.current = Math.max(seenRef.current, newestId)
        if (fresh.some((entry) => entry.source === 'agent')) {
          autoOpenedRef.current = true
          props.onOpen?.()
        }
      }, [activity, current, sessionId])

      const tabOpen = props.isTabOpen?.() === true
      if (tabOpen) return null
      const recent = newest !== null && now - Number(newest.finishedAt ?? newest.at) < 12000
      if (currentHere === null && !recent) return null
      const label = currentHere !== null
        ? t('strip.now', { label: activityLabel(t, currentHere) })
        : t('strip.justNow', { label: activityLabel(t, newest) })
      const thumb = relevant.slice(0, 6).find((entry) => entry.hasThumb === true) ?? null

      return h('div', { className: 'dsh-bc-strip' },
        h('style', null, STRIP_CSS),
        h('button', { className: 'dsh-bc-strip-main', type: 'button', title: label, onClick: () => props.onOpen?.() },
          h('span', { className: `dsh-bc-dot${currentHere !== null ? ' is-starting' : ''}`.trim() }),
          h('span', { className: 'dsh-bc-strip-label' }, label),
        ),
        thumb === null ? null : h('img', {
          className: 'dsh-bc-strip-thumb',
          src: `${BASE}thumb/${thumb.id}`,
          alt: '',
          onClick: () => props.onOpen?.(),
        }),
        h('button', { className: 'dsh-bc-strip-view', type: 'button', onClick: () => props.onOpen?.() }, t('strip.view')),
      )
    }

    /** The full-width panel opened by the left sidebar entry. */
    function BrowserPanel(props) {
      const t = (key, vars) => {
        let value = FALLBACK[key] ?? key
        if (typeof props.t === 'function') {
          const translated = props.t(key)
          if (typeof translated === 'string' && translated !== '' && translated !== key) value = translated
        }
        if (vars !== undefined) {
          for (const [name, replacement] of Object.entries(vars)) value = value.replace(`{${name}}`, String(replacement))
        }
        return value
      }
      const feed = useSharedFeed()
      const overviewFeed = useOverviewFeed()
      const { state, activity, current: currentAction, offline } = feed
      const [now, setNow] = useState(Date.now())
      const [address, setAddress] = useState(() => readLastUrl())
      const [busyAction, setBusyAction] = useState(null)
      const [overviewBusy, setOverviewBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [expanded, setExpanded] = useState(null)
      const addressEdited = useRef(false)

      useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(id)
      }, [])

      useEffect(() => {
        const url = state?.url
        if (typeof url !== 'string' || url === '' || url === 'about:blank' || addressEdited.current) return
        // Follow the page the agent navigated to, unless the human is editing the address.
        setAddress(url)
        rememberLastUrl(url)
      }, [state?.url])

      const running = state?.running === true
      const phase = offline ? 'offline' : typeof state?.phase === 'string' ? state.phase : 'stopped'
      const busy = busyAction !== null
      const { frameUrl, frameAt } = useLiveFrame(running)

      const describeFailure = (message) => {
        const detail = String(message ?? '')
        const target = address.trim() !== '' ? address.trim() : state?.url ?? ''
        if (/ERR_CONNECTION_REFUSED/iu.test(detail)) return t('error.refused', { url: target })
        if (/ERR_NAME_NOT_RESOLVED/iu.test(detail)) return t('error.dns', { url: target })
        if (/ERR_EMPTY_RESPONSE/iu.test(detail)) return t('error.emptyResponse', { url: target })
        if (/timed out/iu.test(detail)) return t('error.timeout')
        if (/not a URL|URL is empty|cannot open/iu.test(detail) && !/ERR_/u.test(detail)) return t('error.invalidUrl')
        return `${t('notice.failed')}: ${detail}`
      }

      const act = async (body) => {
        setBusyAction(body.action)
        setNotice(null)
        try {
          const response = await fetch(`${BASE}action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          updateFeedState(payload.state)
          if (typeof payload.state?.url === 'string' && payload.state.url !== '' && payload.state.url !== 'about:blank') {
            addressEdited.current = false
            setAddress(payload.state.url)
            rememberLastUrl(payload.state.url)
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          setNotice(describeFailure(detail))
        } finally {
          setBusyAction(null)
        }
      }

      const openAddress = () => {
        if (busy) return
        if (address.trim() === '') {
          setNotice(t('notice.urlRequired'))
          return
        }
        addressEdited.current = false
        void act({ action: 'open', url: address })
      }

      const overviewAct = async (action, sessionId) => {
        if (overviewBusy !== null) return
        setOverviewBusy(sessionId)
        setNotice(null)
        try {
          const response = await fetch(`${BASE}overview/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, sessionId }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          if (payload.overview !== undefined) {
            window.dispatchEvent(new CustomEvent('dsh-bc-overview', { detail: payload.overview }))
          }
          if (action === 'focus' && typeof props.onOpenRight === 'function') props.onOpenRight()
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
        } finally {
          setOverviewBusy(null)
        }
      }

      const submit = (event) => {
        event.preventDefault()
        openAddress()
      }

      const retry = () => {
        if (address.trim() !== '') void act({ action: 'open', url: address })
        else void act({ action: 'launch' })
      }

      const viewportLabel = state === null ? '' : `${state.width}×${state.height}`
      const presetValue = PRESETS.some((preset) => `${preset.width}x${preset.height}` === `${state?.width}x${state?.height}`)
        ? `${state?.width}x${state?.height}`
        : 'custom'
      const errors = Array.isArray(state?.recentErrors) ? state.recentErrors : []
      const pageTitle = typeof state?.title === 'string' && state.title !== '' && state.title !== 'about:blank' ? state.title : ''
      const statusClass = phase === 'running' ? 'is-running' : phase === 'starting' ? 'is-starting' : phase === 'failed' || phase === 'offline' ? 'is-failed' : ''
      const statusLabel = t(phase === 'running' ? 'status.running' : phase === 'starting' ? 'status.starting' : phase === 'failed' ? 'status.failed' : phase === 'offline' ? 'status.offline' : 'status.stopped')
      const frameAge = frameAt === 0 ? Number.POSITIVE_INFINITY : now - frameAt
      const fresh = frameAge < FRESH_MS
      const badgeText = phase === 'running'
        ? `${statusLabel} · ${fresh ? t('stage.live') : t('stage.paused')}`
        : statusLabel
      const showFrame = running && frameUrl !== null
      const windowLabel = state?.headless === false ? t('meta.visible') : t('meta.headless')
      const newestEntry = activity.length > 0 ? activity[0] : null
      const liveLabel = currentAction !== null
        ? t('activity.now', { label: activityLabel(t, currentAction) })
        : newestEntry !== null && now - Number(newestEntry.finishedAt ?? newestEntry.at) < 6000
          ? t('activity.justNow', { label: activityLabel(t, newestEntry) })
          : ''

      const stageCenter = (() => {
        if (phase === 'offline') {
          return h('div', { className: 'dsh-bc-center' },
            h('div', { className: 'dsh-bc-center-title' }, t('stage.offlineTitle')),
            h('div', { className: 'dsh-bc-center-body' }, t('stage.offlineBody')),
            h('button', { className: 'dsh-bc-btn', type: 'button', onClick: refreshFeed }, t('stage.retry')),
          )
        }
        if (phase === 'starting') {
          return h('div', { className: 'dsh-bc-center' },
            h('div', { className: 'dsh-bc-center-title' }, t('stage.starting')),
          )
        }
        if (phase === 'failed') {
          return h('div', { className: 'dsh-bc-failure' },
            h('div', { className: 'dsh-bc-center-title' }, t('stage.failedTitle')),
            state?.error ? h('div', { className: 'dsh-bc-center-body' }, String(state.error)) : null,
            h('button', { className: 'dsh-bc-btn is-primary', type: 'button', disabled: busy, onClick: retry }, t('stage.retry')),
          )
        }
        if (running) {
          return h('div', { className: 'dsh-bc-waiting' }, busyAction === 'open' ? t('stage.opening') : t('frame.waiting'))
        }
        return h('div', { className: 'dsh-bc-empty' },
          h(EmptyGlyph),
          h('div', { className: 'dsh-bc-empty-title' }, t('empty.title')),
          h('div', { className: 'dsh-bc-empty-body' }, t('empty.body')),
          h('button', { className: 'dsh-bc-btn is-primary', type: 'button', disabled: busy, onClick: openAddress }, t('empty.cta')),
          h('div', { className: 'dsh-bc-empty-hint' }, t('empty.hint')),
        )
      })()

      const ageLabel = (at) => {
        if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return ''
        const seconds = Math.max(0, Math.floor((now - at) / 1000))
        if (seconds < 5) return t('overview.justNow')
        if (seconds < 60) return t('overview.seconds', { count: seconds })
        return t('overview.minutes', { count: Math.floor(seconds / 60) })
      }
      const overviewSessions = overviewFeed.overview.sessions
      const overviewSection = h('section', { className: 'dsh-bc-overview', 'aria-label': t('overview.title') },
        h('div', { className: 'dsh-bc-overview-head' },
          h('h2', { className: 'dsh-bc-overview-title' }, t('overview.title')),
          h('span', { className: 'dsh-bc-overview-count' }, t('overview.count', { count: overviewSessions.length })),
        ),
        overviewSessions.length === 0
          ? h('div', { className: 'dsh-bc-overview-empty' }, t('overview.empty'))
          : h('div', { className: 'dsh-bc-grid' },
            overviewSessions.map((entry) => {
              const busy = overviewBusy === entry.sessionId
              const label = typeof entry.title === 'string' && entry.title !== '' ? entry.title : `Session ${entry.sessionId.slice(-6)}`
              const frame = overviewFeed.frames[entry.sessionId]
              return h('article', {
                key: entry.sessionId,
                className: `dsh-bc-card${entry.active ? ' is-active' : ''}`.trim(),
                role: 'button',
                tabIndex: 0,
                'aria-label': `${label} — ${entry.url || ''}`,
                onClick: () => void overviewAct('focus', entry.sessionId),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    void overviewAct('focus', entry.sessionId)
                  }
                },
              },
              h('div', { className: 'dsh-bc-card-head' },
                h('span', { className: `dsh-bc-dot ${entry.running ? 'is-running' : ''}`.trim() }),
                h('span', { className: 'dsh-bc-card-title', title: label }, label),
                h('span', { className: `dsh-bc-card-badge${entry.active ? ' is-active' : ''}`.trim() }, entry.active ? t('overview.active') : t('overview.inactive')),
              ),
              frame !== undefined
                ? h('img', { className: 'dsh-bc-card-frame', src: frame, alt: '', draggable: false })
                : h('div', { className: 'dsh-bc-card-placeholder' }, t('overview.noFrame')),
              h('div', { className: 'dsh-bc-card-url', title: entry.url || '' }, entry.url || 'about:blank'),
              h('div', { className: 'dsh-bc-card-foot' },
                h('span', { className: 'dsh-bc-card-age' }, ageLabel(entry.lastActivityAt ?? entry.createdAt)),
                h('div', { className: 'dsh-bc-card-actions' },
                  h('button', {
                    className: 'dsh-bc-card-btn',
                    type: 'button',
                    disabled: busy,
                    onClick: (event) => { event.stopPropagation(); void overviewAct('focus', entry.sessionId) },
                  }, t('overview.focus')),
                  h('button', {
                    className: 'dsh-bc-card-btn',
                    type: 'button',
                    disabled: busy,
                    onClick: (event) => { event.stopPropagation(); void overviewAct('close', entry.sessionId) },
                  }, t('overview.close')),
                ),
              ),
              )
            }),
          ),
      )

      return h('div', { className: 'dsh-bc-page' },
        h('style', null, CSS),
        h('div', { className: 'dsh-bc-head' },
          h('div', { className: 'dsh-bc-heading' },
            h('div', { className: 'dsh-bc-title-row' },
              h('h1', { className: 'dsh-bc-title' }, t('title')),
              h('div', { className: 'dsh-bc-status', role: 'status', 'aria-live': 'polite' },
                h('span', { className: `dsh-bc-dot ${statusClass}`.trim() }),
                h('span', null, badgeText),
              ),
              typeof props.onOpenRight === 'function'
                ? h('button', { className: 'dsh-bc-linkbtn', type: 'button', onClick: () => props.onOpenRight() }, t('panel.openRight'))
                : null,
            ),
            h('p', { className: 'dsh-bc-sub' }, t('subtitle')),
          ),
        ),
        notice === null ? null : h('div', { className: 'dsh-bc-notice', role: 'alert' },
          h('span', null, notice),
          h('button', { type: 'button', onClick: () => setNotice(null) }, t('notice.dismiss')),
        ),
        overviewSection,
        h('form', { className: 'dsh-bc-bar', onSubmit: submit },
          h('input', {
            className: 'dsh-bc-input',
            value: address,
            placeholder: t('url.placeholder'),
            spellCheck: false,
            autoComplete: 'off',
            inputMode: 'url',
            enterKeyHint: 'go',
            'aria-label': t('field.address'),
            onBlur: () => { addressEdited.current = false },
            onChange: (event) => {
              addressEdited.current = true
              setAddress(event.target.value)
            },
          }),
          h('button', { className: 'dsh-bc-btn is-primary', type: 'submit', disabled: busy }, busyAction === 'open' ? t('action.opening') : t('action.open')),
          h('button', {
            className: 'dsh-bc-btn',
            type: 'button',
            disabled: busy || !running,
            onClick: () => { void act({ action: 'reload' }) },
          }, t('action.reload')),
          h('select', {
            className: 'dsh-bc-select',
            value: presetValue,
            disabled: busy || !running,
            'aria-label': t('meta.viewport'),
            onChange: (event) => {
              const preset = PRESETS.find((entry) => `${entry.width}x${entry.height}` === event.target.value)
              if (preset !== undefined) void act({ action: 'resize', width: preset.width, height: preset.height })
            },
          },
            presetValue === 'custom' ? h('option', { value: 'custom' }, `${t('preset.current')} ${viewportLabel}`) : null,
            PRESETS.map((preset) => h('option', { key: `${preset.width}x${preset.height}`, value: `${preset.width}x${preset.height}` }, `${t(`preset.${preset.key}`)} · ${preset.width}×${preset.height}`)),
          ),
          h('button', {
            className: 'dsh-bc-btn',
            type: 'button',
            disabled: busy || !running,
            onClick: () => { void act({ action: 'close' }) },
          }, t('action.close')),
        ),
        h('div', { className: 'dsh-bc-body' },
          h('section', { className: 'dsh-bc-stage' },
            showFrame ? h('img', { className: 'dsh-bc-frame', src: frameUrl, alt: `${pageTitle || t('panel')} — ${viewportLabel}` }) : stageCenter,
            showFrame ? h('div', { className: 'dsh-bc-readonly' }, t('stage.readonly')) : null,
            showFrame && busy ? h('div', { className: 'dsh-bc-veil' },
              h('div', { className: 'dsh-bc-veil-pill' }, busyAction === 'open' ? t('stage.opening') : t('stage.working')),
            ) : null,
          ),
          h('aside', { className: 'dsh-bc-rail', 'aria-label': t('activity.title') },
            h('div', { className: 'dsh-bc-rail-head' },
              h('span', { className: 'dsh-bc-rail-title' }, t('activity.title')),
              liveLabel === '' ? null : h('span', { className: 'dsh-bc-rail-live', title: liveLabel }, liveLabel),
            ),
            h('div', { className: 'dsh-bc-rail-list' },
              activity.length === 0
                ? h('div', { className: 'dsh-bc-rail-empty' }, t('activity.empty'))
                : activity.map((entry) => activityRow(t, entry, expanded, setExpanded)),
            ),
          ),
        ),
        errors.length === 0 ? null : h('div', { className: 'dsh-bc-errors' },
          h('div', { className: 'dsh-bc-errors-title' }, t('errors.title')),
          errors.map((line, index) => h('div', { className: 'dsh-bc-error-line', key: index }, line)),
        ),
        h('div', { className: 'dsh-bc-meta' },
          h('span', { className: 'dsh-bc-meta-item' }, h('span', null, 'URL'), h('code', null, state?.url === '' || state?.url === undefined || state?.url === 'about:blank' ? '—' : state.url)),
          h('span', { className: 'dsh-bc-meta-item' }, h('span', null, t('meta.title')), h('code', null, pageTitle === '' ? '—' : pageTitle)),
          h('span', { className: 'dsh-bc-meta-item' }, h('span', null, t('meta.viewport')), h('span', null, viewportLabel === '' ? '—' : viewportLabel)),
          h('span', { className: 'dsh-bc-meta-item' }, h('span', null, windowLabel)),
          state !== null && (state.errorCount ?? 0) > 0
            ? h('span', { className: 'dsh-bc-meta-item' }, h('span', null, `${state.errorCount} ${t('meta.errors')}`))
            : null,
        ),
      )
    }

    function readPanelPreference(key, fallback) {
      try {
        const value = window.localStorage.getItem(key)
        return value === null ? fallback : value
      } catch {
        return fallback
      }
    }

    function writePanelPreference(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        // A host without storage keeps the in-memory state.
      }
    }

    /** v1.6 two-state cockpit: a browser grid, or one focused read-only preview. */
    function BrowserPanelV16(props) {
      const t = makeTranslator(props)
      const feed = useSharedFeed()
      const overviewFeed = useOverviewFeed()
      const { activity, current: currentAction, offline } = feed
      const [now, setNow] = useState(Date.now())
      const [view, setView] = useState(() => readPanelPreference('dsh.browser-cockpit.view', 'grid'))
      const [selectedId, setSelectedId] = useState(null)
      const [mode, setMode] = useState('preview')
      const [railPref, setRailPref] = useState(() => readPanelPreference('dsh.browser-cockpit.rail', 'open') !== 'closed')
      const [menuId, setMenuId] = useState(null)
      const [closeArmedId, setCloseArmedId] = useState(null)
      const [errorOpen, setErrorOpen] = useState(false)
      const [overviewBusy, setOverviewBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [panelWidth, setPanelWidth] = useState(0)
      const [conversations, setConversations] = useState([])
      const [conversationsLoaded, setConversationsLoaded] = useState(false)
      const [newOpen, setNewOpen] = useState(false)
      const pageRef = useRef(null)
      const newRef = useRef(null)

      const loadConversations = async () => {
        try {
          const response = await fetch(`${BASE}sessions`, { cache: 'no-store' })
          if (!response.ok) throw new Error(`sessions ${response.status}`)
          const payload = await response.json()
          const rows = Array.isArray(payload?.sessions) ? payload.sessions : []
          setConversations(rows)
          setConversationsLoaded(true)
          return rows
        } catch {
          setConversations([])
          setConversationsLoaded(true)
          return []
        }
      }

      useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(id)
      }, [])

      useEffect(() => {
        const node = pageRef.current
        if (node === null) return undefined
        const measure = () => setPanelWidth(node.getBoundingClientRect().width)
        measure()
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        return () => observer.disconnect()
      }, [])

      useEffect(() => {
        void loadConversations()
      }, [])

      useEffect(() => {
        if (menuId === null && !errorOpen && !newOpen) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          setMenuId(null)
          setErrorOpen(false)
          setNewOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [menuId, errorOpen, newOpen])

      useEffect(() => {
        if (!newOpen) return undefined
        const onPointerDown = (event) => {
          if (newRef.current !== null && newRef.current.contains(event.target)) return
          setNewOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        return () => document.removeEventListener('pointerdown', onPointerDown)
      }, [newOpen])

      useEffect(() => {
        if (menuId === null) setCloseArmedId(null)
      }, [menuId])

      const overviewSessions = overviewFeed.overview.sessions
        .slice(0, 6)
        .slice()
        .sort((left, right) => Number(right.active) - Number(left.active) || Number(right.lastActivityAt ?? 0) - Number(left.lastActivityAt ?? 0))
      const sessionsKey = overviewSessions.map((entry) => entry.sessionId).join('|')

      useEffect(() => {
        if (overviewSessions.length === 0) {
          if (selectedId !== null) setSelectedId(null)
          return
        }
        if (selectedId !== null && overviewSessions.some((entry) => entry.sessionId === selectedId)) return
        setSelectedId(overviewFeed.overview.activeSessionId ?? overviewSessions[0].sessionId)
      }, [sessionsKey, overviewFeed.overview.activeSessionId, selectedId])

      useEffect(() => {
        if (mode === 'live' && selectedId !== overviewFeed.overview.activeSessionId) setMode('preview')
      }, [mode, selectedId, overviewFeed.overview.activeSessionId])

      const activeId = overviewFeed.overview.activeSessionId
      const selected = overviewSessions.find((entry) => entry.sessionId === selectedId) ?? null
      const single = overviewSessions.length === 1 || (view === 'single' && selected !== null)
      const runningCount = overviewSessions.filter((entry) => entry.running === true).length
      const railOpen = single && panelWidth >= 1100 && railPref
      const selectedIsActive = selected !== null && selected.sessionId === activeId
      const live = useLiveFrame(single && mode === 'live' && selectedIsActive && feed.state?.running === true)
      const preview = useSessionPreview(selected?.sessionId ?? null, single && selected !== null, 1280)
      const displayFrame = mode === 'live' && live.frameUrl !== null ? live.frameUrl : preview.frameUrl
      const displayAt = mode === 'live' && live.frameUrl !== null ? live.frameAt : preview.frameAt
      const selectedActivity = selected === null
        ? []
        : activity.filter((entry) => entry.sessionId === selected.sessionId).slice(0, 40)
      const selectedCurrent = currentAction !== null && selected !== null && currentAction.sessionId === selected.sessionId
        ? currentAction
        : null
      const errorSessions = overviewSessions.filter((entry) => Number(entry.errorCount ?? 0) > 0)
      const totalErrors = errorSessions.reduce((sum, entry) => sum + Number(entry.errorCount ?? 0), 0)

      const ageLabel = (at) => {
        if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return ''
        const seconds = Math.max(0, Math.floor((now - at) / 1000))
        if (seconds < 5) return t('overview.justNow')
        if (seconds < 60) return t('overview.seconds', { count: seconds })
        return t('overview.minutes', { count: Math.floor(seconds / 60) })
      }

      const overviewAct = async (action, sessionId, options = {}) => {
        if (overviewBusy !== null) return null
        setOverviewBusy(sessionId)
        setNotice(null)
        try {
          const response = await fetch(`${BASE}overview/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, sessionId }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          if (payload.overview !== undefined) {
            window.dispatchEvent(new CustomEvent('dsh-bc-overview', { detail: payload.overview }))
          }
          if (options.select === true && typeof sessionId === 'string') {
            setSelectedId(sessionId)
            setView('single')
            setMode('preview')
          }
          return payload
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
          return null
        } finally {
          setOverviewBusy(null)
        }
      }

      const openSingle = (sessionId) => {
        if (sessionId === null || sessionId === undefined) return
        setSelectedId(sessionId)
        setView('single')
        setMode('preview')
        setMenuId(null)
        setErrorOpen(false)
      }

      const backToGrid = () => {
        setView('grid')
        setMode('preview')
        setMenuId(null)
        setErrorOpen(false)
      }

      const directTarget = props.sessionId ?? activeId
      const canStartNew = (directTarget !== null && directTarget !== undefined)
        || !conversationsLoaded
        || conversations.length > 0

      const openConversation = (sessionId) => {
        setNewOpen(false)
        setNotice(null)
        void overviewAct('open', sessionId, { select: true })
      }

      const newBrowser = async () => {
        setNotice(null)
        if (directTarget !== null && directTarget !== undefined) {
          openConversation(directTarget)
          return
        }
        const rows = await loadConversations()
        if (rows.length === 0) {
          setNotice(t('v16.noConversations'))
          return
        }
        if (rows.length === 1) {
          openConversation(rows[0].sessionId)
          return
        }
        setMenuId(null)
        setErrorOpen(false)
        setNewOpen(true)
      }

      const focusLive = async () => {
        if (selected === null) return
        const payload = await overviewAct('focus', selected.sessionId)
        if (payload !== null) {
          setSelectedId(selected.sessionId)
          setView('single')
          setMode('live')
        }
      }

      const openInRight = () => {
        setMenuId(null)
        if (typeof props.onOpenRight === 'function') props.onOpenRight()
      }

      const copyAddress = async (entry = selected) => {
        setMenuId(null)
        if (entry === null || typeof entry.url !== 'string' || entry.url === '') return
        try {
          await navigator.clipboard.writeText(entry.url)
        } catch {
          setNotice(entry.url)
        }
      }

      const closeSession = async (entry = selected) => {
        if (entry === null) return
        if (closeArmedId !== entry.sessionId) {
          setCloseArmedId(entry.sessionId)
          return
        }
        setCloseArmedId(null)
        setMenuId(null)
        await overviewAct('close', entry.sessionId)
        if (selectedId === entry.sessionId) {
          setMode('preview')
          setView('grid')
        }
      }

      const toggleRail = () => {
        if (panelWidth > 0 && panelWidth < 1100) return
        const next = !railPref
        setRailPref(next)
        writePanelPreference('dsh.browser-cockpit.rail', next ? 'open' : 'closed')
      }

      const statusDot = (entry) => h('span', {
        className: `dsh-bc-dot${entry?.running === true ? ' is-running' : entry?.phase === 'crashed' || entry?.phase === 'failed' ? ' is-failed' : ''}`.trim(),
        'aria-hidden': true,
      })

      const errorPanel = h('div', { className: 'dsh-bc16-errors', role: 'dialog', 'aria-label': t('v16.errors') },
        errorSessions.length === 0
          ? h('div', { className: 'dsh-bc16-error-empty' }, t('v16.errorEmpty'))
          : errorSessions.flatMap((entry) => (entry.recentErrors ?? []).map((line, index) => h('div', { className: 'dsh-bc16-error-line', key: `${entry.sessionId}-${index}` },
            h('div', { className: 'dsh-bc16-error-session' }, entry.title || entry.sessionId.slice(-6)),
            typeof line === 'string' ? line : String(line?.text ?? line),
          ))),
      )

      const groupedActivity = []
      for (const entry of selectedActivity) {
        const previous = groupedActivity[groupedActivity.length - 1]
        if (entry.kind === 'network') {
          if (previous?.kind === 'networkGroup'
            && previous.source === entry.source
            && previous.at - entry.at <= 15_000) {
            previous.count += 1
            previous.entries.push(entry)
            previous.at = Math.max(previous.at, entry.at)
          } else {
            groupedActivity.push({
              kind: 'networkGroup',
              count: 1,
              at: entry.at,
              source: entry.source,
              page: entry.page,
              entries: [entry],
              id: `network-${entry.id}`,
            })
          }
          continue
        }
        groupedActivity.push(entry)
      }
      const logIcon = (kind) => ({
        network: '⇄',
        console: '>',
        click: '▸',
        scroll: '↕',
        screenshot: '▣',
        assert: '✓',
        type: '⌨',
      }[kind] ?? '•')
      let lastLogAge = null

      const rail = railOpen
        ? h('aside', { className: 'dsh-bc16-rail', 'aria-label': t('v16.log') },
            h('div', { className: 'dsh-bc16-rail-head' },
              h('span', null, `${t('v16.log')} · ${selectedActivity.length}`),
              selectedCurrent === null ? null : h('span', { className: 'dsh-bc16-sub' }, t('activity.now', { label: activityLabel(t, selectedCurrent) })),
            ),
            h('div', { className: 'dsh-bc16-rail-list' },
              selectedActivity.length === 0
                ? h('div', { className: 'dsh-bc16-empty-body', style: { padding: '8px 0' } }, t('v16.logEmpty'))
                : groupedActivity.map((entry) => {
                    const age = ageLabel(entry.at)
                    const showAge = age !== '' && age !== lastLogAge
                    if (showAge) lastLogAge = age
                    const isGroup = entry.kind === 'networkGroup'
                    const label = isGroup
                      ? t('v16.networkGroup', { count: entry.count })
                      : activityLabel(t, entry)
                    const source = entry.source === 'human' ? t('activity.you') : t('activity.agent')
                    const pageName = entry.page !== null && entry.page !== undefined && typeof entry.page === 'object'
                      ? (entry.page.title !== '' ? entry.page.title : shorten(entry.page.url, 40))
                      : ''
                    const hasThumb = !isGroup && entry.hasThumb === true
                    return h('div', { key: entry.id, className: 'dsh-bc16-log-unit' },
                      showAge ? h('div', { className: 'dsh-bc16-log-age' }, age) : null,
                      h('div', { className: 'dsh-bc16-log' },
                        hasThumb
                          ? h('div', { className: 'dsh-bc16-log-thumb' }, h('img', { src: `${BASE}thumb/${entry.id}`, alt: label, loading: 'lazy' }))
                          : h('div', { className: 'dsh-bc16-log-icon', 'aria-hidden': true }, logIcon(isGroup ? 'network' : entry.kind)),
                        h('div', { className: 'dsh-bc16-log-body' },
                          h('div', { className: 'dsh-bc16-log-time' }, formatClock(entry.at)),
                          h('div', { className: 'dsh-bc16-log-label', title: label }, label),
                          h('div', { className: 'dsh-bc16-log-sub' }, pageName === '' ? source : `${source} · ${shorten(pageName, 26)}`),
                          entry.status === 'error' && typeof entry.error === 'string' && entry.error !== ''
                            ? h('div', { className: 'dsh-bc16-log-error' }, shorten(entry.error, 120))
                            : null,
                        ),
                      ),
                    )
                  }),
            ),
          )
        : null

      const tileWidth = (() => {
        let columns = overviewSessions.length <= 2 ? Math.max(1, overviewSessions.length) : overviewSessions.length <= 4 ? 2 : 3
        if (panelWidth > 0) {
          columns = Math.min(columns, panelWidth < 760 ? 1 : panelWidth < 1050 ? 2 : 3)
        }
        columns = Math.max(1, columns)
        return `calc((100% - ${(columns - 1) * 14}px) / ${columns})`
      })()

      const renderTile = (entry) => {
        const label = typeof entry.title === 'string' && entry.title !== '' ? entry.title : `Session ${entry.sessionId.slice(-6)}`
        const frame = overviewFeed.frames[entry.sessionId]
        const menu = menuId === entry.sessionId
        const errors = Number(entry.errorCount ?? 0)
        return h('div', {
          key: entry.sessionId,
          className: `dsh-bc16-tile${entry.active ? ' is-active' : ''}${menu ? ' is-menu' : ''}`.trim(),
          style: { width: tileWidth },
          role: 'button',
          tabIndex: 0,
          'aria-label': `${label} — ${entry.url || ''}`,
          onClick: () => openSingle(entry.sessionId),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              openSingle(entry.sessionId)
            }
          },
        },
        h('div', { className: 'dsh-bc16-tile-media' },
          frame !== undefined
            ? h('img', { className: 'dsh-bc16-tile-frame', src: frame, alt: '', draggable: false })
            : h('div', { className: 'dsh-bc16-tile-empty' }, t('overview.noFrame')),
          h('div', { className: 'dsh-bc16-tile-shade' }),
          h('div', { className: 'dsh-bc16-tile-top' },
            statusDot(entry),
            errors > 0
              ? h('button', {
                  className: 'dsh-bc16-tile-error',
                  type: 'button',
                  'aria-label': `${errors} ${t('v16.errors')}`,
                  onClick: (event) => { event.stopPropagation(); setSelectedId(entry.sessionId); setErrorOpen(true) },
                }, `⚠ ${errors}`)
              : null,
            h('span', { className: `dsh-bc16-tile-badge${entry.active ? ' is-active' : ''}`.trim() }, entry.active ? t('overview.active') : t('overview.inactive')),
            h('button', {
              className: 'dsh-bc16-icon',
              type: 'button',
              'aria-label': t('v16.menu'),
              'aria-expanded': menu,
              onClick: (event) => { event.stopPropagation(); setMenuId(menu ? null : entry.sessionId) },
            }, '⋯'),
          ),
          h('div', { className: 'dsh-bc16-tile-bottom' },
            h('div', { className: 'dsh-bc16-tile-title', title: label }, label),
            h('div', { className: 'dsh-bc16-tile-url', title: entry.url || '' }, entry.url || 'about:blank'),
          ),
        ),
        menu
          ? h('div', { className: 'dsh-bc16-menu', role: 'menu', onClick: (event) => event.stopPropagation() },
              h('button', { type: 'button', role: 'menuitem', onClick: () => openSingle(entry.sessionId) }, t('v16.zoom')),
              typeof props.onOpenRight === 'function'
                ? h('button', { type: 'button', role: 'menuitem', onClick: openInRight }, t('v16.openRight'))
                : null,
              h('button', { type: 'button', role: 'menuitem', onClick: () => void copyAddress(entry) }, t('v16.copyUrl')),
              h('button', { type: 'button', role: 'menuitem', className: 'is-danger', title: t('v16.confirmClose'), onClick: () => void closeSession(entry) }, closeArmedId === entry.sessionId ? t('v16.confirmCloseShort') : t('v16.closeSession')),
            )
          : null,
        )
      }

      const toolbar = h('div', { className: 'dsh-bc16-toolbar' },
        h('div', { className: 'dsh-bc16-toolbar-main' },
          single
            ? h('button', {
                className: 'dsh-bc16-icon',
                type: 'button',
                'aria-label': t('v16.back'),
                title: t('v16.back'),
                disabled: overviewSessions.length <= 1,
                onClick: backToGrid,
              }, '‹')
            : h('span', { className: 'dsh-bc16-icon', 'aria-hidden': true }, '▦'),
          single && selected !== null ? statusDot(selected) : null,
          single && selected !== null
            ? h('span', { className: 'dsh-bc16-title', title: selected.title || selected.url || '' }, selected.title || selected.url || t('v16.preview'))
            : null,
          h('span', { className: 'dsh-bc16-stat' },
            single && selected !== null
              ? `${t(mode === 'live' ? 'v16.live' : 'v16.preview')}${displayAt === 0 ? '' : ` · ${ageLabel(displayAt)}`}`
              : t('v16.summary', { count: overviewSessions.length, running: runningCount }),
          ),
        ),
        h('div', { className: 'dsh-bc16-toolbar-side' },
          single && mode === 'preview'
            ? h('button', {
                className: 'dsh-bc16-btn is-live',
                type: 'button',
                disabled: selected === null || overviewBusy !== null,
                title: t('v16.liveHint'),
                onClick: () => void focusLive(),
              }, t('v16.live'))
            : null,
          single && mode === 'live'
            ? h('button', { className: 'dsh-bc16-btn', type: 'button', onClick: () => setMode('preview') }, t('v16.preview'))
            : null,
          totalErrors > 0
            ? h('button', {
                className: 'dsh-bc16-btn',
                type: 'button',
                style: { color: 'var(--dsw-alias-state-error-primary)' },
                'aria-expanded': errorOpen,
                onClick: () => setErrorOpen((value) => !value),
              }, `⚠ ${totalErrors}`)
            : null,
          single
            ? h('button', {
                className: 'dsh-bc16-icon',
                type: 'button',
                disabled: panelWidth > 0 && panelWidth < 1100,
                'aria-label': railOpen ? t('v16.railHide') : t('v16.railShow'),
                'aria-pressed': railOpen,
                title: panelWidth > 0 && panelWidth < 1100 ? t('v16.railShow') : (railOpen ? t('v16.railHide') : t('v16.railShow')),
                onClick: toggleRail,
              }, '▤')
            : null,
          !single
            ? h('div', { className: 'dsh-bc16-new', ref: newRef },
                h('button', {
                  className: 'dsh-bc16-icon',
                  type: 'button',
                  'aria-label': t('v16.new'),
                  'aria-expanded': newOpen,
                  title: canStartNew ? t('v16.new') : t('v16.newEmpty'),
                  disabled: !canStartNew,
                  onClick: (event) => {
                    event.stopPropagation()
                    if (!canStartNew) return
                    setMenuId(null)
                    setErrorOpen(false)
                    if (newOpen) {
                      setNewOpen(false)
                      return
                    }
                    void newBrowser()
                  },
                }, '+'),
                newOpen
                  ? h('div', { className: 'dsh-bc16-newmenu', role: 'menu', onClick: (event) => event.stopPropagation() },
                      h('div', { className: 'dsh-bc16-new-head' }, t('v16.newTitle')),
                      conversations.length === 0
                        ? h('div', { className: 'dsh-bc16-new-empty' }, t('v16.newEmpty'))
                        : conversations.map((row) => h('button', {
                            key: row.sessionId,
                            type: 'button',
                            role: 'menuitem',
                            className: 'dsh-bc16-new-item',
                            onClick: () => openConversation(row.sessionId),
                          },
                            h('span', { className: 'dsh-bc16-new-title', title: row.title }, row.title),
                            row.hasBrowser
                              ? h('span', { className: 'dsh-bc16-new-tag' }, t('v16.hasBrowser'))
                              : null,
                          )),
                    )
                  : null,
              )
            : null,
          single
            ? h('button', {
                className: 'dsh-bc16-icon',
                type: 'button',
                'aria-label': t('v16.menu'),
                'aria-expanded': menuId === 'panel',
                onClick: () => setMenuId(menuId === 'panel' ? null : 'panel'),
              }, '⋯')
            : null,
          single && menuId === 'panel'
            ? h('div', { className: 'dsh-bc16-menu', role: 'menu' },
                typeof props.onOpenRight === 'function'
                  ? h('button', { type: 'button', role: 'menuitem', onClick: openInRight }, t('v16.openRight'))
                  : null,
                h('button', { type: 'button', role: 'menuitem', onClick: () => void copyAddress(selected) }, t('v16.copyUrl')),
                h('button', { type: 'button', role: 'menuitem', className: 'is-danger', title: t('v16.confirmClose'), onClick: () => void closeSession(selected) }, closeArmedId === selected?.sessionId ? t('v16.confirmCloseShort') : t('v16.closeSession')),
              )
            : null,
          errorOpen ? errorPanel : null,
        ),
      )

      const empty = h('div', { className: 'dsh-bc16-empty' },
        h('div', { className: 'dsh-bc16-empty-title' }, t('v16.emptyTitle')),
        h('div', { className: 'dsh-bc16-empty-body' }, t('v16.emptyBody')),
        h('button', {
          className: 'dsh-bc16-btn is-live',
          type: 'button',
          disabled: !canStartNew,
          title: canStartNew ? t('v16.new') : t('v16.newEmpty'),
          onClick: () => void newBrowser(),
        }, t('v16.emptyCta')),
      )

      const body = overviewSessions.length === 0
        ? h('div', { className: 'dsh-bc16-body' }, empty)
        : single && selected !== null
          ? h('div', { className: 'dsh-bc16-body' },
              h('div', { className: 'dsh-bc16-stage' },
                h('div', { className: 'dsh-bc16-canvas' },
                  displayFrame !== null
                    ? h('img', {
                        src: displayFrame,
                        alt: `${selected.title || selected.url || t('v16.preview')}`,
                        draggable: false,
                      })
                    : h('div', { className: 'dsh-bc16-canvas-center' },
                        preview.failed ? t('v16.errorEmpty') : selected.phase === 'stopped' ? t('status.stopped') : t('overview.noFrame'),
                      ),
                  h('div', { className: 'dsh-bc16-live-chip' }, mode === 'live' ? t('v16.live') : t('v16.preview')),
                ),
                h('div', { className: 'dsh-bc16-foot' },
                  h('span', null, 'URL ', h('code', null, selected.url || 'about:blank')),
                  h('span', null, t('meta.title'), ' ', h('code', null, selected.title || '—')),
                  h('span', null, `${selected.width ?? 0}×${selected.height ?? 0}`),
                  h('span', null, t('v16.readonly')),
                ),
              ),
              rail,
            )
          : h('div', { className: 'dsh-bc16-body' },
              h('div', { className: 'dsh-bc16-grid-wrap' },
                h('div', { className: 'dsh-bc16-grid' }, overviewSessions.map(renderTile)),
              ),
            )

      return h('div', { className: 'dsh-bc-page dsh-bc-v16', ref: pageRef },
        h('style', null, CSS + V16_CSS),
        h('div', { className: 'dsh-bc16' },
          toolbar,
          notice === null ? null : h('div', { className: 'dsh-bc16-notice', role: 'alert' },
            h('span', null, notice),
            h('button', { type: 'button', 'aria-label': t('notice.dismiss'), onClick: () => setNotice(null) }, '×'),
          ),
          body,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'browser-control: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 5,
          locale: NS,
          label: () => t('panel'),
        }, BrowserPanelIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: (sessionId) => ({ sessionId, onOpenRight: () => openBrowserTab(ctx, sessionId) }),
        }, BrowserPanelV16))

        ctx.inject(['sidebarRightTabs', 'sidebarRight', 'layout'], (scope) => {
          scope.effect(() => scope.sidebarRightTabs.register({
            id: BROWSER_TAB_ID,
            kind: BROWSER_TAB_KIND,
            title: () => t('panel'),
            guide: [{
              id: 'browser-control',
              order: 10,
              title: () => t('panel'),
              description: () => t('guide.description'),
              icon: BrowserPanelIcon,
            }],
          }), 'browser-control: tab type')
          scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: BROWSER_TAB_ID,
            locale: NS,
            inject: (sessionId) => ({
              sessionId,
              onOpenPanel: () => {
                try {
                  scope.layout.selectPanel(PANEL_ID)
                } catch {
                  // A host without the main panel ignores the jump.
                }
              },
            }),
          }, BrowserTabBody))
          scope.slots.inject('conversation.session.header.utilities', () => scope.slots.register({
            name: 'conversation.session.header.utilities',
            id: 'browser-control',
            order: -6,
            locale: NS,
            inject: (sessionId) => ({ onOpen: () => openBrowserTab(ctx, sessionId) }),
          }, BrowserHeaderButton))
          scope.effect(() => {
            try {
              return scope.sidebarRight.registerCloseHandler(BROWSER_TAB_KIND, (sessionId) => {
                dismissBrowserTab(sessionId)
              })
            } catch {
              return () => {}
            }
          }, 'browser-control: tab dismissal')
          scope.slots.inject('conversation.input.dock', () => scope.slots.register({
            name: 'conversation.input.dock',
            id: 'browser-control',
            order: 10,
            locale: NS,
            inject: (sessionId) => ({
              sessionId,
              onOpen: () => openBrowserTab(ctx, sessionId),
              isTabOpen: () => browserTabVisible(),
              isDismissed: () => isTabDismissed(sessionId),
            }),
          }, BrowserStrip))
        })
      },
    }
  },
})
