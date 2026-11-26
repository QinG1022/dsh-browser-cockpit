# 浏览器驾驶舱（Browser cockpit）

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

**给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 智能体用的实时浏览器驾驶舱。**
智能体驾驶一个真实的 Chrome，你在对话旁边看着同一个页面、以及它做的每一步。

[English](README.md) · [架构图](docs/architecture.svg)

## 为什么做

智能体读代码很在行，但看不到跑起来的界面。这个插件给它一个自己控制的 Chrome 页面：打开、读结构、点击、输入、切视口、截图；同时给你一个驾驶舱：右侧栏的实时画面、带缩略图的逐步操作记录、输入框上方「现在在做什么」的小胶囊。不用再来回截图、贴图。

## 功能

- **29 个浏览器工具**：打开、标签页、读页面、等待、处理对话框、点击、悬停、拖动、输入、批量填表、选择、上传、按键、滚动、执行脚本、读控制台、断言、网络、样式、模拟、性能、截图、切视口、关闭、高亮、请求模拟、Cookie、存储、下载。
- **调试深度**：请求列表/详情（凭据打码）、计算样式与匹配规则、单元素截图、设备/网络模拟，以及 LCP/CLS/近似 INP/长任务等轻量性能数据。
- **页面控制**：高亮元素给人看、模拟或失败网络请求、读写 Cookie 与本地/会话存储、收集下载、空闲时自动关闭浏览器。
- **稳定定位**：快照坐标、深度/节点上限，以及 `role=button[name="保存"]`、`text=保存`、`label=邮箱`、`testid=search` 定位；`browser_assert` 做确定性检查。
- **可执行的失败**：工具报错末尾带 `Next:` 建议——ref 过期就重新快照、匹配多个就收窄定位、导航被挡就检查 `allowedHosts`/`allowFileUrls`、超时就调超时或看控制台/网络。
- **输出有上限**：快照行数/节点数上限、`browser_eval` 默认 6k 字符、网络响应体截断、控制台/脚本结果带截断标记，避免大对象淹没对话。
- **实时画面**：右侧栏与对话并排，优先走 SSE 推流，失败时回退到 JPEG 轮询。
- **操作记录**：每一步的时间、耗时、结果、页面、新增报错，并附可放大的缩略图。
- **自动打开**：会话里第一次操作浏览器时右侧栏自动展开；关掉后由状态胶囊接管。
- **状态胶囊**：输入框上方显示「智能体正在：点击『保存』」或「刚刚：截图」，带缩略图和「查看画面」。
- **按会话隔离页面**：每个会话在同一个浏览器里拥有自己的页面；右侧栏和胶囊只看当前会话，其他会话的页面不会被当成实时画面。左侧面板保留完整历史并跟随当前页面。
- **真实输入**：点击和输入是浏览器级事件，React 状态、焦点、校验、悬浮表现和真人操作一致。
- **只在本机**：独立 Chrome 配置、回环地址上的面板路由、无遥测、无外部服务。

## 工作原理

![架构图](docs/architecture.svg)

Host 半边运行一个独立 Chrome，注册 `browser_*` 工具和回环 JSON 路由（`state`、`activity`、`frame.jpg`、`stream`、`thumb`、`action`）。Client 半边是一个小 React 面板，由一个共享数据源驱动：注册左侧栏入口、右侧栏标签、会话标题栏图标和输入框胶囊。工具截图会作为持久附件进入对话，所以智能体能在对话里直接看到图片。

## 环境要求

- DeepSeek Harness `0.2.2-rc.x`（提供本插件使用的 Client 插槽与右侧栏标签 API 的版本）。
- DSH Web 界面（右侧栏标签和胶囊依赖它）。
- Node.js 22+（Host 使用内置 WebSocket；DSH Desktop 自带 Node 24）。
- Chrome、Edge 或 Brave。

## 安装

1. 克隆本仓库：

   ```bash
   git clone https://github.com/QinG1022/dsh-browser-cockpit.git
   ```

2. 在 DSH 打开 **插件 → 添加插件 → 本地目录**，选择克隆下来的文件夹。  
   或者让智能体用目录绝对路径安装（`plugin_manager install_bundle`）。
3. 打开左侧栏的 **浏览器**，或让智能体打开一个地址。
4. 如果左侧栏没有出现入口，刷新一次 DSH 窗口。

```text
插件 → 添加插件 → 本地目录 → <本仓库>
```

包没有发布到 npm（`"private": true`），从目录安装即可。

## 快速开始

```bash
# 在你的项目里
pnpm dev          # 终端会打印地址，例如 http://localhost:5173
```

然后对智能体说：

> 打开终端打印的地址（例如 `http://localhost:5173`），看看登录页。提交按钮如果错位就修一下。

`3000`、`5173`、`8080` 都只是例子。驾驶舱接受任意 URL 和端口，并且会记住你上次打开的地址，所以项目跑在 5173 或 8080 也不用每次重输。

右侧栏会带着实时页面自动展开；智能体读页面结构、点击、输入，最后带着截图和控制台报错回来。你可以关掉右侧栏继续对话——输入框上方的胶囊会继续提示。

## 驾驶舱界面

| 位置 | 内容 |
|---|---|
| **左侧栏 → 浏览器** | 完整驾驶舱：地址栏、打开/刷新、视口预设、实时画面，以及完整操作记录。适合自己动手操作。 |
| **右侧栏 → 浏览器标签** | 对话旁的紧凑驾驶舱：上方是当前会话的实时页面，下方是当前会话的操作记录（带缩略图）。如果另一个会话正在使用可见页面，这里会显示安静的非活动状态，而不是误导性的实时画面。 |
| **会话标题栏图标** | 一键展开右侧栏标签。 |
| **输入框胶囊** | 右侧栏标签不可见时出现：「智能体正在：…」/「刚刚：…」、缩略图和「查看画面」。智能体开始操作时会自动展开右侧栏。 |

关掉右侧栏标签会被该会话记住，不会再次自动弹出，改由胶囊提示。手动打开（标题栏图标、「查看画面」或面板里的链接）会重新启用自动打开。

## 智能体工具

| 工具 | 用途 |
|---|---|
| `browser_open` | 打开地址并返回页面结构、可见文本和截图；首次调用会启动 Chrome，`waitUntil`、`timeoutMs` 控制导航等待。 |
| `browser_snapshot` | 重新读取页面：带控件状态的引用、可见文本、截图；`interactiveOnly` 返回紧凑操作列表，`boxes` 附带视口坐标，`depth`/`maxNodes` 限制树大小。 |
| `browser_click` | 按 ref/选择器点击元素，或用 x/y 点击视口坐标；支持左/右/中键和 1–3 次点击。 |
| `browser_hover` | 把鼠标移到元素上，展开菜单或提示。 |
| `browser_drag` | 用左键把一个元素拖到另一个元素。 |
| `browser_type` | 聚焦输入框、替换或追加内容，可选回车提交。用 `secret` 代替 `text` 可在允许的域名上输入配置好的密钥。 |
| `browser_fill_form` | 用 JSON 字段列表一次填写多个文本框。 |
| `browser_select` | 按值、可见标签或索引选择原生 `<select>` 选项。 |
| `browser_upload_file` | 用绝对路径给文件输入框设置文件。 |
| `browser_tabs` | 列出、打开、切换、关闭标签页。 |
| `browser_key` | 发送按键或组合键（`Enter`、`Tab`、`Control+A` 等）。 |
| `browser_wait_for` | 等待可见文本、选择器、URL 或网络空闲后再操作。 |
| `browser_handle_dialog` | 在 `dialogBehavior` 为 `manual` 时处理等待中的 alert/confirm/prompt。 |
| `browser_scroll` | 滚动页面，或把元素滚入视野。 |
| `browser_highlight` | 在元素外画一个带标签的覆盖层，让人看清智能体指的是哪里；`durationMs: 0` 会一直保留，`clear: true` 清除所有覆盖层。 |
| `browser_eval` | 在页面里执行 JavaScript 并返回 JSON 值。 |
| `browser_console` | 最近的控制台消息、未捕获异常和失败请求，带来源 URL、行、列和调用栈。 |
| `browser_assert` | 确定性检查：文本可见/隐藏、元素可见/隐藏、值、勾选、URL、标题或元素数量。返回 `PASS`/`FAIL` 和期望/实际值；条件不成立是正常结果，不当作工具错误。 |
| `browser_network` | 列出请求（状态、类型、耗时、大小、URL），查看单条请求的打码请求/响应头和有限长度的响应体。 |
| `browser_route` | 模拟、延迟或失败匹配的 HTTP 请求；列出和清除规则。 |
| `browser_cookies` | 列出、设置、删除当前页面或指定 URL 的 Cookie；命中配置密钥的值会打码。 |
| `browser_storage` | 列出、读取、设置、删除或清空本地/会话存储，或导出/导入私有 storage-state 文件（Cookie + localStorage）。 |
| `browser_download` | 列出页面触发的下载，等待完成并返回保存路径。 |
| `browser_styles` | 读取一个元素的计算样式和匹配的 CSS 规则，可按属性过滤。 |
| `browser_emulate` | 模拟配色方案、减少动效、移动/触摸、CPU 降速、离线/慢网、时区和地理位置；`clear` 恢复。 |
| `browser_performance` | 轻量读取 LCP、CLS、近似 INP、长任务、导航耗时、资源数和 Chrome 运行时指标。 |
| `browser_screenshot` | 截取视口、整页，或按 target/ref/selector 截取单个元素。 |
| `browser_resize` | 切换视口尺寸（320–3840 × 240–2160）。 |
| `browser_close` | 关闭浏览器；下次工具调用会重新启动。 |

## 配置

可以在插件的 bundle 行上设置（同名的行覆盖会替换整个 `config`）：

```yaml
- id: browser-cockpit
  name: 'dsh-browser-cockpit'
  config:
    browserPath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'
    headless: false      # 显示 Chrome 窗口
    width: 1440
    height: 900
    profileDir: 'C:\Users\you\.dsh\browser-control\profile'
    idleTimeoutMs: 300000
    downloadDir: 'C:\Users\you\.dsh\browser-control\downloads'
    storageStateDir: 'C:\Users\you\.dsh\browser-control\state'
    allowedHosts: 'localhost,127.0.0.1,dev.example.com'
    allowFileUrls: false
    secrets:
      apiToken:
        value: 'sk-your-test-token'
        domains: ['localhost', '127.0.0.1']
```

| 选项 | 默认值 | 说明 |
|---|---|---|
| `browserPath` | 自动查找 | Chrome/Edge/Brave 可执行文件。 |
| `headless` | `true` | `false` 时显示浏览器窗口。 |
| `width`、`height` | `1440`、`900` | 初始视口。 |
| `profileDir` | `~/.dsh/browser-control/profile` | 持久化的 Chrome 配置目录。 |
| `dialogBehavior` | `dismiss` | JavaScript alert/confirm/prompt 的处理方式：`dismiss`、`accept` 或 `manual`；`beforeunload` 始终接受。 |
| `followNewTabs` | `true` | 是否跟随当前页面打开的新标签页。 |
| `idleTimeoutMs` | `300000` | 无操作多久后关闭浏览器；`0` 表示不自动关闭。范围 0–24 小时。 |
| `downloadDir` | `~/.dsh/browser-control/downloads` | 页面下载的保存目录。 |
| `storageStateDir` | `~/.dsh/browser-control/state` | `browser_storage export` 写入私有 JSON 状态文件的目录。 |
| `allowedHosts` | 仅回环 | 额外允许访问的 HTTP 主机，逗号分隔或数组；支持 `*.example.com`。回环地址始终允许。 |
| `allowFileUrls` | `false` | 是否允许 `file://` 导航。除非工作流需要本地文件，否则保持关闭。 |
| `secrets` | `[]` | 字符串或 `{ value, domains? }` 记录。值会在工具文本、操作详情、控制台/网络输出、Cookie 和存储中替换为 `[redacted]`；带 `domains` 时 `browser_type` 只允许在这些主机输入。 |

环境变量回退：`DSH_BROWSER_PATH`、`DSH_BROWSER_PROFILE`。

## 安全与隐私

- 受控 Chrome 使用**独立配置目录**，不读取你日常浏览器的 Cookie；该目录会持久保存，因此你在其中登录过的站点重启后仍然有效。
- 面板路由只由本地 Harness Web 服务提供（`127.0.0.1`）。非回环 `Host` 和跨源 `Sec-Fetch-Site` 请求会直接返回 403；`POST action` 还要求同源 JSON 请求。不要把 Harness 端口暴露到网络。
- 打开 Harness 自身地址时，插件会用进程 token 让受控 Chrome 登录一次，然后从地址栏移除 token；token 不会写进操作记录。
- 智能体可以在受控页面里执行任意 JavaScript（`browser_eval`）。导航限制在回环或 `allowedHosts` 中的 HTTP(S) 地址；`file://` 默认拒绝，只有 `allowFileUrls: true` 才允许。只把它用在你打算检查的页面上。
- 网络请求头中的 `authorization`、`cookie`、`set-cookie`、`proxy-authorization` 和 API key/token 类字段会打码；响应体只在请求时读取，并限制长度。其余请求数据仍来自你打开的页面，按敏感信息对待。
- `secrets` 里的值会在控制台输出、网络 URL/响应体、Cookie、存储、工具结果和操作详情中替换为 `[redacted]`。请把你在意的测试 token 加进去；这是字面替换，不是格式识别。配置了 `domains` 的密钥只能在这些主机上用 `browser_type` 输入。
- Cookie 和存储属于受控 Chrome 的配置目录。`browser_cookies`/`browser_storage` 能读写智能体打开的任意页面，所以只让它访问你信任的站点。
- `browser_storage export` 会写出包含原始 Cookie 和 localStorage 的私有 JSON 文件；工具只返回路径和数量，不返回值。只导入自己创建的文件，用完及时删除。
- `browser_route` 的模拟在进程内完成：拦截受控页面的 HTTP(S) 请求，但不做代理，模拟数据不离开本机。下载会写到 `downloadDir`。
- 无遥测；除了你让它打开的页面，不会发起外部请求。
- 操作记录和缩略图保存在 Host 内存里（60 条、30 张缩略图），Host 插件重载或应用重启后清空。磁盘截图位于系统临时目录（`dsh-browser-control`），只保留最近 40 张；下载文件会留在 `downloadDir`，直到你手动删除。

## 已知限制

- 整个进程共用一个 Chrome；每个会话映射到自己的页面/标签，Cookie 共享。非当前活动的页面不会在右侧栏显示实时画面，也不能推流，直到该会话再次操作浏览器。
- 默认跟随当前页面打开的新标签页；`followNewTabs: false` 可关闭。
- 同源 iframe 和开放 shadow DOM 内的元素会进入快照并支持定位；跨域/OOPIF iframe 和 closed shadow root 无法检查。
- 网络记录按当前页面保存在内存中，最多 300 条；响应体按需读取，二进制体会按文本解码，可能有损。
- 请求模拟在启用期间作用于受控浏览器（含子资源），不是系统代理，不影响其他应用；规则跨标签页保留，但重启后不保存。
- Cookie 和存储默认作用于当前源（也可指定 URL）；两者都存在独立配置目录里，不能替代真实的登录/会话测试。storage-state 导出包含 Cookie 和当前源的 localStorage。
- 下载通过 Chrome 的下载事件收集；被取消的下载会留下记录但没有文件。路径使用页面建议的文件名，重名可能覆盖较早的文件。
- 空闲清理会在 `idleTimeoutMs` 内没有工具调用后关闭浏览器；下次调用会重新启动。需要长时间挂着时设为 `0`。
- `secrets` 打码是本会话内的字面、全局替换；测试 token 一旦泄露，仍应轮换，不能只依赖打码。
- 快照引用只在生成它的快照内有效；导航或 DOM 大幅变化后要重新快照。`role=`、`text=`、`label=`、`testid=` 定位比引用更耐小改动。
- `browser_assert` 会轮询到超时（默认 3 秒）；条件不成立时返回 `FAIL`，不抛异常。
- CSS 检查覆盖元素的计算样式和匹配规则，不进入 closed shadow DOM 或伪元素内部。
- 性能数字来自浏览器，属于近似值；INP 需要真实交互，LCP 需要加载，页面稳定后再读。
- 拖拽使用鼠标按键事件；原生 HTML5 drag-and-drop 可能不会触发 drag 事件。
- Chrome 原生 `<select>` 弹层和系统对话框不在页面里，无法驱动。JavaScript alert/confirm/prompt 已处理：默认取消，`dialogBehavior: accept` 接受，`manual` 时用 `browser_handle_dialog` 回答。
- 右侧栏标签只在对话视图显示；切到其他主面板时右栏隐藏（回来后会恢复）。
- 操作记录是整个进程共享的：左侧面板显示全部并跟随当前页面，右侧栏和胶囊只显示归属当前会话的操作；面板/命令行触发的操作没有会话归属，只出现在左侧面板。
- 右侧栏标签每个会话自动打开一次；被你关掉的会话不会再自动弹出。
- 智能体看到的截图长边上限 1600px，活动缩略图 480px。
- DevTools socket 断开但 Chrome 还在时，下次工具调用会重连同一个页面；页面崩溃则换新的 `about:blank`。

## 开发

```text
index.js            Host 插件：一个 BrowserSession、工具、路由
client.js           Client 插件：侧栏入口、面板、右侧栏标签、标题栏图标、状态胶囊
lib/browser.js      CDP 页面：启动、导航、快照、点击、输入、截图
lib/locators.js     定位串解析与页面内 role/text 匹配
lib/cdp.js          最小 WebSocket CDP 传输（Node 内置 WebSocket）
lib/tools.js        工具定义与活动埋点
lib/routes.js       回环面板路由（state、frame、stream、activity、thumb、action）
lib/activity.js     内存操作日志与缩略图
lib/targets.js      URL 规范化和 Harness 一次性登录
docs/               架构图
```

- 无构建步骤、无 npm 依赖。
- `npm run check` 检查 Host/Client/`lib/` 全部模块语法。
- `npm test` 检查 29 个工具 schema 和错误建议规则；GitHub Actions 在 Node 22 上运行这两项。
- `node dev-check/tools-schema.mjs` 可单独运行。
- 独立冒烟脚本放在开发时的本地临时目录，不提交到仓库；它们会用无头 Chrome 打开临时测试页，覆盖导航、快照、定位、断言、网络/样式/模拟/性能、高亮/请求模拟/Cookie/存储/下载/空闲清理、表单、标签页、对话框、iframe、会话隔离、重连和崩溃恢复。
- 改 **Host** 文件后需要卸载再重装 bundle（否则 Loader 会沿用旧的模块代次）；改 **Client** 文件后刷新 DSH 窗口；插件元数据变动需要重启应用。

## 排查

| 现象 | 处理 |
|---|---|
| `no Chrome or Edge executable was found` | 安装 Chrome/Edge，或配置 `browserPath`。 |
| `the browser exited immediately` | 上次异常退出遗留的受控 Chrome 占用了 profile。新版会尝试接管并保留原页面；仍失败时，关闭使用该 profile 的 Chrome，或换 `profileDir`。 |
| `timed out waiting for the browser debugging port` | 关掉使用该配置目录的遗留 Chrome 窗口。 |
| 安装后侧栏没有入口 | 刷新一次 DSH 窗口。 |
| 右侧栏标签不自动打开 | 这个会话里你关过它（设计如此）；用标题栏图标或胶囊「查看画面」。 |
| 打开 Harness 地址是空白或 401 | 从驾驶舱面板重新打开；插件会自动登录。 |

## 贡献

欢迎提 [issue](https://github.com/QinG1022/dsh-browser-cockpit/issues) 或 PR。请保持插件只在本机运行（无遥测、无外部请求）、把可见文案同时加到 `client.js` 的中英文字典里，并在验证时避免截取任何人的私有 DSH 界面。

## 许可

[MIT](LICENSE)

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
