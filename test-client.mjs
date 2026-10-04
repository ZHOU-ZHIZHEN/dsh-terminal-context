/**
 * dsh-terminal-context 客户端 bundle 的离线验证。
 *
 * 在 Node 里搭一个最小的假浏览器：假 window / document / 元素 / Node / fetch，
 * 以及**假的 __ModuleLoader__ 模块表**（只认基线模块）。然后：
 *   1. 载入 bundle，检查它是否按契约注册了正确的 id；
 *   2. 取出 factory 的返回值，检查插件对象形状；
 *   3. 调 apply(ctx) 验证启动不抛错、监听装上了、返回可用的清理函数；
 *   4. 伪造一次"终端里选中文本 + 点按钮"，验证整条链路：
 *      选中 → 按钮浮出 → click → fetch 到宿主路由 → 结构化 chip 事件发出。
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

let failures = 0
const ok = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}
const warn = console.warn
const warnings = []
console.warn = (...args) => {
  warnings.push(args.map(String).join(' '))
  warn(...args)
}
/** 插件自己的 console.log 诊断线索（不打印到测试输出，只收集）。 */
const consoleLogs = []
const log = console.log
console.log = (...args) => {
  const line = args.map(String).join(' ')
  if (line.includes('[dsh-terminal-context]')) {
    consoleLogs.push(line)
    return
  }
  log(...args)
}

// ── 假 DOM ────────────────────────────────────────────────────────────────
class FakeElement {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag.toUpperCase()
    this.nodeType = 1
    this.dataset = { ...attrs }
    this.children = children
    this.style = {}
    this.listeners = {}
    this.textContent = ''
    this.isConnected = true
  }
  get parentElement() {
    return this._parent ?? null
  }
  appendChild(child) {
    child._parent = this
    this.children.push(child)
    return child
  }
  remove() {
    this.isConnected = false
  }
  addEventListener(type, handler) {
    ;(this.listeners[type] ??= []).push(handler)
  }
  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((h) => h !== handler)
  }
  dispatch(type, event) {
    for (const handler of this.listeners[type] ?? []) handler(event)
  }
  setAttribute() {}
  focus() {
    this.focused = true
  }
  getBoundingClientRect() {
    return { width: 96, height: 26, top: 0, left: 0, right: 96, bottom: 26 }
  }
  querySelector(selector) {
    const found = (nodes) => {
      for (const node of nodes) {
        if (matches(node, selector)) return node
        const hit = found(node.children)
        if (hit !== null) return hit
      }
      return null
    }
    return found(this.children)
  }
  closest(selector) {
    let node = this
    while (node != null) {
      if (matches(node, selector)) return node
      node = node.parentElement
    }
    return null
  }
  contains(other) {
    let node = other
    while (node != null) {
      if (node === this) return true
      node = node.parentElement
    }
    return false
  }
}

/** 极简选择器匹配：足够覆盖本插件用到的属性选择器与标签选择器。 */
function matches(element, selector) {
  if (element === null || element === undefined) return false
  return selector.split(',').some((part) => {
    const token = part.trim()
    // 夹具显式声明的标记优先（含 `data-x: ''` 这种空值属性）。
    if (element._flags?.has(token) === true) return true
    const attr = /^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(token)
    if (attr !== null) {
      const key = attr[1]
      const expected = attr[2]
      if (!key.startsWith('data-')) return true
      const camel = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      return expected === undefined ? Object.hasOwn(element.dataset, camel) : element.dataset[camel] === expected
    }
    return element.tagName === token.toUpperCase()
  })
}

// xterm 根：选区必须落在它内部
const xterm = new FakeElement('div', {})
xterm._flags = new Set(['.xterm'])
const terminalSection = new FakeElement('section', {})
terminalSection._flags = new Set(['[data-sidebar-terminal]'])

const terminalTextNode = { nodeType: 3, parentElement: xterm, textContent: 'git status\nOn branch main' }

// 输入框与会话容器
const sessionDiv = new FakeElement('div', { conversationSession: 'session-test-1' })
sessionDiv._flags = new Set(['[data-conversation-session]'])
const composer = new FakeElement('div', {})
composer._flags = new Set(['[data-composer-input]'])
// 输入框的真实形态：位于页面**下方**、有一定宽度。
// 按钮现在固定停靠在它上方（`source: 'composer-dock'`），所以夹具必须给出
// 一个真实矩形，否则会走 `viewport-dock` 退路、测不到正常路径。
composer.getBoundingClientRect = () => ({ left: 380, top: 860, right: 1200, bottom: 960, width: 820, height: 100 })

// 手工接线（不经 appendChild，避免把每个元素都塞进 root.children 干扰遍历）。
xterm._parent = terminalSection
// 共享终端的**高亮层**：`anyTerminalHasHighlight()` 靠它判断"用户是否真的选着文本"，
// 所以这里必须能造出/清掉高亮。真实情形是 xterm 往 `.xterm-selection` 里放若干
// 按行定位的 div，取消选中时它们消失。
const xtermHighlightLayer = { children: [] }
xterm._flags.add('.xterm-selection')
/** 让共享终端"看起来有高亮"（若干按行定位的 div，宽度/高度都正常）。 */
const showHighlight = (pieces = 1) => {
  xtermHighlightLayer.children = Array.from({ length: pieces }, (_, i) => ({
    style: { top: `${i * 17}px`, left: '0px', width: '400px', height: '17px' },
  }))
}
/** 让高亮消失 —— 等价于用户取消选中。 */
const clearHighlight = () => {
  xtermHighlightLayer.children = []
}
showHighlight() // 默认"选着文本"，各节按需修改
// 注意装在 **terminalSection**（终端容器）上：`collectHighlightRects` 是从终端容器
// 往下查 `.xterm-selection` 的，装在里面的 `.xterm` 上不会被用到。
terminalSection.querySelectorAll = (selector) => {
  if (selector !== '.xterm-selection') return Object.assign([], { item: () => null })
  const found = xtermHighlightLayer.children.length > 0 ? [xtermHighlightLayer] : []
  return Object.assign(found, { item: (i) => found[i] ?? null })
}
terminalSection.children = [xterm]
composer._parent = sessionDiv
sessionDiv.children = [composer]

const root = new FakeElement('div', {})
root.children = [terminalSection, sessionDiv]

const documentStub = {
  head: new FakeElement('head', {}),
  body: new FakeElement('body', {}),
  documentElement: new FakeElement('html', {}),
  listeners: {},
  getElementById: () => null,
  createElement: (tag) => new FakeElement(tag, {}),
  querySelector: (selector) => root.querySelector(selector),
  querySelectorAll(selector) {
    const out = []
    const visit = (node) => {
      if (matches(node, selector)) out.push(node)
      for (const child of node.children ?? []) visit(child)
    }
    visit(root)
    // 真实 querySelectorAll 返回 NodeList：有 length、可迭代、带 item()。
    return Object.assign(out, { item: (index) => out[index] ?? null })
  },
  addEventListener(type, handler) {
    ;(this.listeners[type] ??= []).push(handler)
  },
  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((h) => h !== handler)
  },
  dispatch(type, event) {
    for (const handler of this.listeners[type] ?? []) handler(event)
  },
}

/** 可切换的假选区。`node` 决定选区落在哪个终端里（各节可换）。 */
const selectionState = { text: '', collapsed: true, node: terminalTextNode, rect: null }
const range = {
  // 走 getter：这样各节换掉 selectionState.node 就能把选区挪到别的终端
  get commonAncestorContainer() {
    return selectionState.node
  },
  get startContainer() {
    return selectionState.node
  },
  get endContainer() {
    return selectionState.node
  },
  startOffset: 0,
  endOffset: 0,
  getClientRects: () => [],
  getBoundingClientRect: () => selectionState.rect ?? { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 },
}

const windowStub = {
  innerWidth: 1400,
  innerHeight: 900,
  listeners: {},
  addEventListener(type, handler) {
    ;(this.listeners[type] ??= []).push(handler)
  },
  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((h) => h !== handler)
  },
  getSelection: () => ({
    isCollapsed: selectionState.collapsed,
    rangeCount: selectionState.collapsed ? 0 : 1,
    toString: () => selectionState.text,
    getRangeAt: () => range,
    // 真实 Selection 一定有的锚点属性；早先缺这两个，导致插件里读属性抛异常
    // 被整段 try 吞掉、高亮兜底路径静默失效（夹具与实现的差距就是这么来的）。
    anchorNode: selectionState.collapsed ? null : selectionState.node,
    focusNode: selectionState.collapsed ? null : selectionState.node,
  }),
}

// ── 假模块表（基线模块 + 故意不含 node: 内置） ─────────────────────────────
const BASELINE = new Set(['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/cordis'])
const requireErrors = []

globalThis.window = windowStub
globalThis.document = documentStub
globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 }

/**
 * 假的 ClipboardEvent：真实浏览器里合成 copy 事件由 xterm 往 clipboardData
 * 填文本；这里让夹具在派发时带上我们准备的文本。构造器必须存在，否则插件的
 * `new ClipboardEvent('copy', …)` 会抛（真实浏览器当然有）。
 */
const clipboardPayload = { text: '' }
globalThis.ClipboardEvent = class ClipboardEvent extends Event {
  constructor(type, init = {}) {
    super(type, init)
    this.clipboardData = {
      getData: (kind) => (kind === 'text/plain' ? clipboardPayload.text : ''),
    }
  }
}
windowStub.ClipboardEvent = globalThis.ClipboardEvent

const fetchCalls = []
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, body: init?.body })
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      value: { relativePath: '.dsh/term-captures/terminal-20261003-121500.txt' },
    }),
  }
}

const registrations = []
globalThis.window.__ModuleLoader__ = {
  load({ id, factory }) {
    registrations.push({ id, factory })
  },
}

// ── 载入 bundle ───────────────────────────────────────────────────────────
const bundlePath = process.argv[2]
const source = await readFile(bundlePath, 'utf8')
const requireStub = (id) => {
  if (BASELINE.has(id)) return {}
  const error = new Error(`模块表里没有 "${id}"`)
  requireErrors.push(id)
  throw error
}
// 用 Function 求值：bundle 顶层就是一次 __ModuleLoader__.load 调用。
new Function('window', 'document', 'Node', 'require', source)(
  globalThis.window,
  globalThis.document,
  globalThis.Node,
  requireStub,
)

console.log('\n[1] bundle 契约')
ok('顶层只注册了一个模块', registrations.length === 1, `实际 ${registrations.length}`)
const entry = registrations[0]
ok('注册 id 与包名一致', entry?.id === 'dsh-terminal-context', String(entry?.id))
ok('factory 是函数', typeof entry?.factory === 'function')

console.log('\n[2] 插件对象与启动')
const exported = entry.factory(requireStub)
const plugin = exported.default
ok('factory 返回 { default: plugin }', plugin !== undefined, Object.keys(exported).join(','))
ok('插件有名字', plugin?.name === 'dsh-terminal-context', String(plugin?.name))
ok('插件有 apply', typeof plugin?.apply === 'function')
// 防回归：Cordis 靠 inject 等到服务就绪才加载插件。少了 shortcuts 就会在服务
// 注册之前执行 apply、拿到 undefined，快捷键静默失效（真发生过）。
ok('插件声明了 inject（等 slots/sessions/shortcuts 就绪）',
  Array.isArray(plugin?.inject) &&
    ['slots', 'sessions', 'shortcuts'].every((name) => plugin.inject.includes(name)),
  JSON.stringify(plugin?.inject))

const disposers = []
const emitted = []
/** 输入框 shell 的假实现：记录 captureInsertion / insertText 的调用。 */
const shellCalls = { captureInsertion: 0 }
const shell = {
  actions: {
    captureInsertion: () => {
      shellCalls.captureInsertion += 1
      return { start: 7, end: 7, draftRev: 42 }
    },
    insertText: (text, span) => {
      shellCalls.insertText = { text, span }
      return true
    },
  },
}
const conversationService = { input: { for: () => shell } }

/** 假的 slots 服务：记录注册，并交出组件以便按插槽标准 props 渲染。 */
const slotRegistrations = []
const renderedComponents = []
const slotsService = {
  inject(name, fn) {
    slotRegistrations.push({ name, kind: 'inject' })
    fn()
    return () => {}
  },
  register(options, component) {
    slotRegistrations.push({ name: options.name, id: options.id, options, kind: 'register' })
    renderedComponents.push(component)
    return () => {}
  },
}

/** 假的 shortcuts 服务：记录注册，交出 resolve 以便模拟按键仲裁。 */
const shortcutRegistrations = []
const shortcutsService = {
  register(definition) {
    shortcutRegistrations.push(definition)
    return () => {}
  },
}

const ctx = {
  /** 默认把 conversation 藏起来，逼插件走插槽桥那条路；需要时单独打开。 */
  __exposeConversation: false,
  /** 模拟宿主的修订号 CAS 结果：true = 插入被接受。 */
  __bailAccepts: true,
  effect(fn) {
    // 真实 cordis：effect 的回调立即执行以「登记」资源，返回的清理函数
    // 只在卸载时运行。夹具必须模拟这一点——立刻调用清理函数会把监听和
    // 按钮当场拆掉。
    disposers.push(fn())
    return () => {}
  },
  get(name) {
    if (name === 'slots') return slotsService
    if (name === 'shortcuts') return shortcutsService
    if (name === 'conversation') return this.__exposeConversation ? conversationService : undefined
    return undefined
  },
  sessions: {
    scope: (id) => (id === 'session-test-1' ? actx : undefined),
  },
}
const actx = {
  emit: (name, payload) => {
    emitted.push({ via: 'emit', name, payload })
  },
  /**
   * 真实 `bail` 会把处理器的返回值带回来（insertReference 的修订号 CAS 结果）。
   *
   * 关键：被拒时**不能**把事件推进 `emitted`。早先的假实现无论返回值都推，
   * 于是 [4c] 把 `__bailAccepts` 设成 false 之后，[4d] 的"快捷键也插入了引用 chip"
   * 在插件其实已经降级成纯文本时**仍然通过** —— 测试自己给自己放水。
   */
  bail: (self, name, payload) => {
    const accepted = ctx.__bailAccepts
    if (accepted) emitted.push({ via: 'bail', name, payload })
    else rejected.push({ name, payload })
    return accepted
  },
}
/** 被 CAS 拒掉的插入尝试（诊断用，不进 `emitted`）。 */
const rejected = []

plugin.apply(ctx)
ok('启动未抛错', true)
ok('注册了三个 effect（插槽桥 + 选区监听 + 快捷键）', disposers.length === 3, `实际 ${disposers.length}`)
ok('向 conversation.input.dock 注册了桥组件',
  slotRegistrations.some((r) => r.kind === 'register' && r.name === 'conversation.input.dock'),
  JSON.stringify(slotRegistrations))
ok('注册前先 inject 该插槽',
  slotRegistrations.some((r) => r.kind === 'inject' && r.name === 'conversation.input.dock'),
  JSON.stringify(slotRegistrations))
ok('挂上了 selectionchange 监听',
  (documentStub.listeners.selectionchange ?? []).length === 1,
  String((documentStub.listeners.selectionchange ?? []).length))
ok('按钮已插入 body', documentStub.body.children.length === 1, String(documentStub.body.children.length))

console.log('\n[2b] 插槽桥：渲染桥组件以捕获 inputActions')
const bridgeComponent = renderedComponents[0]
ok('拿到了桥组件', typeof bridgeComponent === 'function')
/** 插槽下发的 inputActions（属于当前会话）。 */
const bridgeInsertText = []
const bridgeActions = {
  captureInsertion: () => ({ start: 3, end: 3, draftRev: 99 }),
  insertText: (text, span) => {
    bridgeInsertText.push({ text, span })
    return true
  },
}
ok('桥组件渲染返回 null（无界面）',
  bridgeComponent({ sessionId: 'session-test-1', inputActions: bridgeActions }) === null)
ok('桥组件在缺少 inputActions 时不报错',
  bridgeComponent({ sessionId: 'session-test-1' }) === null)

const bridgeRegistration = slotRegistrations.find((r) => r.kind === 'register')
ok('注册声明了 inject(sessionId)（官方写法，保证是当前会话）',
  typeof bridgeRegistration?.options?.inject === 'function',
  JSON.stringify(bridgeRegistration?.options))
ok('inject 返回 { sessionId }',
  JSON.stringify(bridgeRegistration?.options?.inject('session-abc')) === '{"sessionId":"session-abc"}',
  JSON.stringify(bridgeRegistration?.options?.inject('session-abc')))

console.log('\n[3] 无选区时不显示按钮')
documentStub.dispatch('selectionchange')
const button = documentStub.body.children[0]
ok('初始态按钮隐藏', button.style.display === 'none', String(button.style.display))
// 启动时会调一次 sweep 路由做清理，所以这里断言「没有发起捕获」而不是「没有 fetch」。
ok('未发起捕获请求',
  !fetchCalls.some((call) => call.url === '/dsh-terminal-context/capture'),
  fetchCalls.map((c) => c.url).join(','))
ok('启动时调用了 sweep 清理', fetchCalls.some((call) => call.url === '/dsh-terminal-context/sweep'),
  fetchCalls.map((c) => c.url).join(','))

console.log('\n[4] 完整链路：选中终端文本 → 按钮 → 插入引用')
selectionState.text = 'PS D:\\Code> git status\r\nOn branch main\r\nnothing to commit   '
selectionState.collapsed = false
selectionState.rect = { width: 0, height: 12, top: 100, left: 800, right: 900, bottom: 112 }
documentStub.dispatch('selectionchange')
ok('按钮浮出', button.style.display === 'block', String(button.style.display))
ok('按钮定位为 fixed 坐标',
  /^\d+px$/.test(button.style.left) && /^\d+px$/.test(button.style.top),
  `${button.style.left} / ${button.style.top}`)

selectionState.collapsed = true // 模拟点击时选区被清掉，插件应使用缓存的选区
button.dispatch('click', { preventDefault() {}, stopPropagation() {} })
await new Promise((resolve) => setTimeout(resolve, 30))

ok('向宿主路由发起了捕获请求',
  fetchCalls.some((call) => call.url === '/dsh-terminal-context/capture'),
  fetchCalls.map((c) => c.url).join(','))

const captureCall = fetchCalls.find((call) => call.url === '/dsh-terminal-context/capture')
const sentBody = JSON.parse(captureCall?.body ?? '{}')
ok('请求带上了会话 id', sentBody.sessionId === 'session-test-1', JSON.stringify(sentBody).slice(0, 120))
ok('请求带上了捕获文本', typeof sentBody.text === 'string' && sentBody.text.includes('git status'),
  JSON.stringify(sentBody.text ?? '').slice(0, 80))
ok('文本尾部空白已清理', sentBody.text?.includes('nothing to commit\n') === true,
  JSON.stringify(sentBody.text ?? '').slice(-40))

const chip = emitted.find((event) => event.name === 'slash/input-insert-reference')
ok('发出了结构化引用事件', chip !== undefined, emitted.map((e) => e.name).join(','))
ok('走的是作用域派发 bail（官方写法）', chip?.via === 'bail', String(chip?.via))
ok('span 来自插槽桥的 inputActions（draftRev=99）',
  chip?.payload?.span?.draftRev === 99,
  JSON.stringify(chip?.payload?.span))
ok('引用指向捕获文件',
  chip?.payload?.reference?.ref === '@.dsh/term-captures/terminal-20261003-121500.txt',
  JSON.stringify(chip?.payload?.reference))
ok('chip 标签是文件名', chip?.payload?.reference?.label === 'terminal-20261003-121500.txt',
  String(chip?.payload?.reference?.label))
ok('chip 的 source 必须是 reference（否则提交会被拒）',
  chip?.payload?.reference?.source === 'reference',
  String(chip?.payload?.reference?.source))
ok('span 是光标坐标（start === end）',
  chip?.payload?.span?.start === chip?.payload?.span?.end,
  JSON.stringify(chip?.payload?.span))

console.log('\n[4b] 保底通路：桥不可用时退回 conversation 服务')
// 清掉桥的会话绑定（模拟"插槽没渲染 / 会话对不上"），把 conversation 服务放出来。
bridgeComponent({ sessionId: 'session-other', inputActions: bridgeActions })
ctx.__exposeConversation = true
const before4b = emitted.length
selectionState.text = 'npm run build\n> tsc -p tsconfig.build.json\nerror TS2304'
selectionState.collapsed = false
documentStub.dispatch('selectionchange')
button.dispatch('click', { preventDefault() {}, stopPropagation() {} })
await new Promise((resolve) => setTimeout(resolve, 30))
const chip4b = emitted.slice(before4b).find((event) => event.name === 'slash/input-insert-reference')
ok('桥不可用时仍然发出了引用事件', chip4b !== undefined, String(chip4b))
ok('退回后用的是 conversation 服务的 span（draftRev=42）',
  chip4b?.payload?.span?.draftRev === 42,
  JSON.stringify(chip4b?.payload?.span))

console.log('\n[4c] CAS 被拒时降级为纯文本提及（不假装成功）')
ctx.__bailAccepts = false
bridgeComponent({ sessionId: 'session-test-1', inputActions: bridgeActions })
const before4c = emitted.length
const beforeInsert = bridgeInsertText.length
selectionState.text = 'pnpm test\n  3 passing'
selectionState.collapsed = false
documentStub.dispatch('selectionchange')
button.dispatch('click', { preventDefault() {}, stopPropagation() {} })
await new Promise((resolve) => setTimeout(resolve, 30))
const chip4c = emitted.slice(before4c).filter((event) => event.name === 'slash/input-insert-reference')
// 假 bail 现在"说实话"：被拒就不进 emitted，所以这里应当**没有**成功的 chip。
ok('结构化插入被拒（没有产生 chip 事件）', chip4c.length === 0, `实际 ${chip4c.length}`)
ok('被拒的尝试记在 rejected 里（证明真的试过结构插入）',
  rejected.filter((r) => r.name === 'slash/input-insert-reference').length >= 1,
  String(rejected.length))
ok('降级调用了 inputActions.insertText', bridgeInsertText.length > beforeInsert,
  `insertText 调用 ${bridgeInsertText.length - beforeInsert} 次`)
ok('降级插入的是 @相对路径 纯文本',
  bridgeInsertText.at(-1)?.text?.startsWith('@.dsh/term-captures/') === true,
  JSON.stringify(bridgeInsertText.at(-1)?.text))
ok('降级路径有告警（可在控制台看到）',
  warnings.some((line) => line.includes('回退为纯文本提及')),
  warnings.at(-1) ?? '(无告警)')

console.log('\n[4d] Ctrl+L 快捷键')
// 复位 [4c] 留下的状态：`__bailAccepts = false` 会让后面所有"插入成功"的断言假通过。
ctx.__bailAccepts = true
const shortcut = shortcutRegistrations[0]
/**
 * 内核只认这三种状态（dsh-client-shortcuts 的派发链）：
 *   `pass`    → 不认领，事件继续传递
 *   `blocked` → 明确吞掉并说明原因
 *   `handled` → 认领并调用 run()
 * 返回其他值会被当成"已认领"然后调 `run()`——对象里没有 run 就抛异常，
 * 而且异常发生在击键路径里会被吞掉，表现为"按了完全没反应"。
 * 这条断言存在的唯一目的就是不让那个 bug 复活。
 */
const KERNEL_STATUSES = new Set(['pass', 'blocked', 'handled'])
const assertResolveShape = (label, result) => {
  ok(`${label}：status 是内核认可的值`,
    KERNEL_STATUSES.has(result?.status),
    `实际 ${JSON.stringify(result?.status)}`)
  ok(`${label}：handled 必须带 run()`,
    result?.status !== 'handled' || typeof result?.run === 'function',
    typeof result?.run)
}
ok('注册了一个快捷键命令', shortcutRegistrations.length === 1, `实际 ${shortcutRegistrations.length}`)
ok('命令 id 带插件前缀', shortcut?.id === 'dsh-terminal-context.add', String(shortcut?.id))
ok('有可显示的中文标签',
  typeof shortcut?.label === 'function' && shortcut.label().includes('终端'),
  typeof shortcut?.label === 'function' ? shortcut.label() : String(shortcut?.label))
ok('默认键位是 primary+KeyL（Windows 上即 Ctrl+L）',
  shortcut?.defaults?.['desktop:windows']?.code === 'KeyL' &&
    JSON.stringify(shortcut.defaults['desktop:windows'].modifiers) === '["primary"]',
  JSON.stringify(shortcut?.defaults?.['desktop:windows']))
ok('五个设备 profile 声明了默认键位',
  ['desktop:macos', 'desktop:windows', 'desktop:linux', 'web:macos', 'web:windows']
    .every((p) => shortcut?.defaults?.[p] !== undefined),
  Object.keys(shortcut?.defaults ?? {}).join(','))
/**
 * **必须**恰好五个：不得声明 `web:linux`。
 *
 * 内核 `ShortcutRegistry.register()` 是**原子**的 —— 它遍历全部 6 个 runtime×platform，
 * 任一条默认键位过不了 `isWebBindingAllowed` 就抛 `Unsupported Web shortcut`，
 * **整条命令注册失败**，按键落回终端（症状：Ctrl+L 又开始清屏）。
 * 而 linux 走的是硬编码白名单（只有 Slash+primary、Comma+shift、Period+shift），
 * `KeyL` 怎么组合都过不去。这条断言专门防止有人（包括我）又一次"补齐六个"。
 */
ok('不得声明 web:linux（声明它会让整条命令注册失败）',
  shortcut?.defaults?.['web:linux'] === undefined,
  JSON.stringify(shortcut?.defaults?.['web:linux']))
ok('设备 profile 恰好五个',
  Object.keys(shortcut?.defaults ?? {}).length === 5,
  Object.keys(shortcut?.defaults ?? {}).join(','))

/**
 * 把内核的键位校验规则**抄进测试**，逐条校验我们声明的每个默认键位。
 *
 * 只断言"数量是五"挡不住"换一个同样不合法的键位"；照着内核规则算一遍才能
 * 在任何键位改动上提前报错。规则原文来自 `dsh-client-shortcuts/lib/client.js`：
 *   - `normalizeBinding`：code 必须匹配 /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4]))$/
 *   - `isWebBindingAllowed`：web 下 windows/macos 放行"2 键含 primary+alt/shift"
 *     或"≥3 键"；**linux 只认 Slash+primary、Comma+shift、Period+shift**
 *   - `bindingIssue`：不能只由 shift 构成；保留键不得用 primary+KeyC/V/X/Z/Y/Q/H
 */
const KERNEL_CODE_RE = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4]))$/
const WEB_ALLOWED_FOR_LINUX = [
  ['Slash', ['primary']],
  ['Comma', ['primary', 'shift']],
  ['Period', ['primary', 'shift']],
]
const kernelAllowsWebBinding = (code, modifiers, platform) => {
  if (!KERNEL_CODE_RE.test(code)) return false
  const primary = platform === 'macos' ? 'meta' : 'control'
  const mods = modifiers.map((m) => (m === 'primary' ? primary : m))
  if (modifiers.length === 0 || modifiers.every((m) => m === 'shift')) return false
  if (platform === 'windows' || platform === 'macos') {
    if (mods.length >= 3) return true
    if (mods.length === 2 && mods.includes(primary) && (mods.includes('alt') || mods.includes('shift'))) return true
  }
  // 白名单比对必须用**展开后**的修饰键：内核是先 normalizeBinding 展开 `primary`，
  // 再拿结果比白名单的。这里若拿字面量 'primary' 去比，连 Slash+primary 都会被误判。
  return WEB_ALLOWED_FOR_LINUX.some(
    ([c, m]) =>
      c === code &&
      m.map((value) => (value === 'primary' ? primary : value)).join() === mods.join(),
  )
}
for (const [profile, binding] of Object.entries(shortcut?.defaults ?? {})) {
  const [runtime, platform] = profile.split(':')
  const okCode = KERNEL_CODE_RE.test(binding.code)
  const okWeb = runtime !== 'web' || kernelAllowsWebBinding(binding.code, binding.modifiers, platform)
  ok(`内核规则允许 ${profile}（${binding.code} + ${binding.modifiers.join('+')}）`,
    okCode && okWeb,
    `codeOk=${okCode} webOk=${okWeb}`)
}
ok('浏览器里用 primary+alt 避免抢走地址栏快捷键',
  JSON.stringify(shortcut?.defaults?.['web:windows']?.modifiers) === '["primary","alt"]',
  JSON.stringify(shortcut?.defaults?.['web:windows']?.modifiers))
ok('声明了生效区域 page + editable',
  Array.isArray(shortcut?.regions) && shortcut.regions.includes('page') && shortcut.regions.includes('editable'),
  JSON.stringify(shortcut?.regions))

// ── 按钮竞态：mouseup 会先把 pending 清掉，按钮不能因此失效 ────────────────
// 真实事件顺序（mouseup 的监听注册在**捕获阶段**）：
//   选中 → mouseup（此时 DOM 选区常已折叠 → onSelectionChange 把 pending 置 null 并藏按钮）
//        → 按钮 click（旧实现只看 pending，于是拿到空值直接 return，表现为"点了没反应"）
// 现在按钮走与快捷键同一条三条兜底链，所以这里模拟"pending 已空 + DOM 读不出"，
// 只能靠登记表救场 —— 这条断言就是那次修复的锁。
console.log('\n[4g] 按钮竞态：pending 被 mouseup 清空后仍应能插入')
ctx.__bailAccepts = true
clipboardPayload.text = ''
// 先在终端里选中一次，让登记表记下它
selectionState.text = 'PS D:\\Code> npm test\n  82 passing'
selectionState.collapsed = false
selectionState.node = terminalTextNode
documentStub.dispatch('selectionchange')
// 再模拟"松开鼠标那一刻选区已折叠"：DOM 读不出、pending 被置空
selectionState.collapsed = true
selectionState.text = ''
documentStub.dispatch('mouseup')
const beforeRace = fetchCalls.length
const beforeRaceChips = emitted.length
button.dispatch('click', { preventDefault() {}, stopPropagation() {} })
await new Promise((resolve) => setTimeout(resolve, 30))
ok('mouseup 清空 pending 后，按钮仍发起了捕获请求',
  fetchCalls.length > beforeRace &&
    fetchCalls.filter((c) => c.url === '/dsh-terminal-context/capture').length > 0,
  `fetch 次数 ${fetchCalls.length - beforeRace}`)
const raceChip = emitted.slice(beforeRaceChips).find((e) => e.name === 'slash/input-insert-reference')
ok('按钮仍插入了引用 chip（靠登记表兜底）', raceChip !== undefined, String(raceChip))
const raceCapture = fetchCalls.filter((c) => c.url === '/dsh-terminal-context/capture').at(-1)
ok('送去的正是之前登记的那段选区',
  JSON.parse(raceCapture?.body ?? '{}').text?.includes('82 passing') === true,
  JSON.stringify(JSON.parse(raceCapture?.body ?? '{}').text ?? '').slice(0, 100))

console.log('\n[4h] 读不到选区时，按钮是否保留')
// 曾经的 bug：读失败就无条件 `hideButton()`。而"鼠标松开时选区已折叠"是常态，
// 于是高亮还原与复制探针都失败时，按钮在松开那一下就消失 —— 登记表里的文本
// 只有快捷键能用，用户看到的是"我明明选中了，按钮却不见了"。
//
// 兜底判据经过两轮修正，现在是：**新鲜度**（`FALLBACK_FRESH_MS` 内）+ 终端仍在 DOM。
//   · 第一版要求"这次鼠标在终端里"，但 `selectionchange` **不带事件** →
//     真实序列（mouseup 之后紧跟一次空选区 selectionchange）里按钮照样被藏掉。
//   · 第二版改用时间窗口，于是不带事件的那条路也能留住按钮（见下面的 (4)）。
const rememberFresh = () => {
  selectionState.text = 'PS D:\\Code> npm run build\n  3 errors'
  selectionState.collapsed = false
  selectionState.node = terminalTextNode
  documentStub.dispatch('selectionchange')
}
const collapseSelection = () => {
  // 模拟"松开鼠标那一刻 DOM 选区已折叠、读不出文本"
  selectionState.collapsed = true
  selectionState.text = ''
}
const mouseTarget = (insideTerminal) =>
  insideTerminal
    ? { closest: (sel) => (sel === '[data-sidebar-terminal]' ? terminalSection : null) }
    : { closest: () => null }

// (1) 鼠标在终端里松开、DOM 读不出，但登记表有内容 → 按钮应保留
rememberFresh()
collapseSelection()
documentStub.dispatch('mouseup', { target: mouseTarget(true) })
ok('在终端里松开 + 读不到选区 + 登记表有内容 → 按钮保留（不再消失）',
  button.style.display === 'block',
  `display=${button.style.display}`)

// (2) 刚在终端里松开鼠标、又**什么都读不出来** → 走宽限期，**不要**藏按钮。
//     浏览器随后补发的那次 `selectionchange` 往往能读出内容并把按钮放好；
//     过早藏掉正是"选中了却没显示、得去点聊天框才冒出来"的直接原因。
collapseSelection()
terminalSection.isConnected = false
shortcut.resolve({})
terminalSection.isConnected = true
clipboardPayload.text = ''
documentStub.dispatch('mouseup', { target: mouseTarget(true) })
ok('刚松开鼠标 + 读不出内容 → 走宽限期，按钮不藏（等紧随的 selectionchange）',
  button.style.display === 'block',
  `display=${button.style.display}`)

// (3) 早已松开鼠标（宽限期已过）、且确实没有可用选区 → 这时才该藏按钮
plugin.__test.resetMouseupGrace()
collapseSelection()
clipboardPayload.text = ''
documentStub.dispatch('selectionchange')
ok('宽限期过后 + 确实无可用选区 → 按钮藏起来',
  button.style.display === 'none',
  `display=${button.style.display}`)

// (4) 在终端**外**松开 → 不该动按钮状态（否则在页面别处点一下就闪没了）。
//     先由终端内的有效选区把按钮显示出来，再在终端外松开，断言按钮仍在。
rememberFresh()
documentStub.dispatch('selectionchange')
ok('（前置）终端内选中后按钮可见', button.style.display === 'block', `display=${button.style.display}`)
collapseSelection()
documentStub.dispatch('mouseup', { target: mouseTarget(false) })
ok('终端外的 mouseup 不改变按钮状态',
  button.style.display === 'block',
  `display=${button.style.display}`)

/**
 * (4) **真实序列**：`mouseup` 之后浏览器还会补一次 `selectionchange`，而它**不带事件**。
 *
 * 这条缝之前一直在：兜底要求"这次鼠标在终端里"，而 `selectionchange` 没有鼠标事件，
 * 于是它照样把按钮藏掉 —— 用户看到"选中 → 按钮出现 → 一松手就没了"。
 * 现在兜底看的是**新鲜度**（`FALLBACK_FRESH_MS` 内）+ 终端仍在 DOM 里，
 * 所以这条不带事件的路径也能留住按钮。
 */
rememberFresh()
collapseSelection()
documentStub.dispatch('mouseup', { target: mouseTarget(true) })
ok('（前置）mouseup 后按钮可见', button.style.display === 'block', `display=${button.style.display}`)
documentStub.dispatch('selectionchange') // ← 不带事件，模拟浏览器的后续通知
ok('紧跟其后的空选区 selectionchange 不再把按钮藏掉（这是修掉的那条缝）',
  button.style.display === 'block',
  `display=${button.style.display}`)
// (5) 落点 = **固定停靠在输入框上方**（不再跟着选区走）。
//
// 这里试过五套"跟着选区走"的算法，全部失败：高亮矩形包围盒（中间行铺满→贴最右端）、
// 高亮相对坐标+行容器原点（坐标系不共享原点→推出可视区域）、行元素真实矩形
// （行铺满整行→与选了多少字无关）、鼠标位置（pointerdown 挂整文档→点哪跳哪）、
// 层元素矩形。最后一条的现场证据最有说服力：`collectHighlightRects` 能按行读到多段
// 高亮（每段 div 宽度正常），但 `.xterm-selection` 容器**高度为 0**（子元素全按行绝对
// 定位），于是层矩形判定不可用、落点退回视口角落 —— 正好压住输入框
// （用户原话："跟着到了聊天框，在我的打字这边右下角"）。
// 结论：这个环境里拿不到可靠的"选区在哪"几何，改用固定位置。
selectionState.collapsed = false
selectionState.text = 'PS D:\\Code> git log\n  3 commits'
selectionState.node = terminalTextNode
selectionState.rect = { width: 0, height: 12, top: 300, left: 820, right: 900, bottom: 312 }
documentStub.dispatch('selectionchange')
// 预期：输入框矩形 right=1200 / top=860，按钮 96×26
//       left = 1200 - 96 - 8 = 1096，top = 860 - 26 - 10 = 824
const dockLeft = button.style.left
const dockTop = button.style.top
ok('按钮固定停靠在输入框上方右侧（1096, 824）',
  dockLeft === '1096px' && dockTop === '824px',
  `left=${dockLeft} top=${dockTop}`)

// 换一个选区矩形 → 位置**不应变化**。固定落点的意义就在这里：
// 用户永远知道去哪儿点，且不会压住任何东西。
selectionState.rect = { width: 0, height: 12, top: 120, left: 100, right: 300, bottom: 132 }
documentStub.dispatch('selectionchange')
ok('选区位置变化不影响落点（永远同一个地方）',
  button.style.left === dockLeft && button.style.top === dockTop,
  `之前 ${dockLeft}/${dockTop} → 现在 ${button.style.left}/${button.style.top}`)

// 松手 + 紧随的空选区 selectionchange：位置仍不变
collapseSelection()
documentStub.dispatch('mouseup', { target: mouseTarget(true) })
documentStub.dispatch('selectionchange')
ok('松手与紧随的 selectionchange 都不改变落点（不会乱跳）',
  button.style.left === dockLeft && button.style.top === dockTop,
  `left=${button.style.left} top=${button.style.top}`)

// 落点不随"页面别处的点击"变化 —— 用户明确报过"点哪里跳哪里"
documentStub.dispatch('click', { clientX: 100, clientY: 100 })
documentStub.dispatch('mouseup', { target: mouseTarget(false), clientX: 100, clientY: 100 })
documentStub.dispatch('click', { clientX: 1300, clientY: 700 })
ok('页面别处的点击不改变落点（修掉"点哪里跳哪里"）',
  button.style.left === dockLeft && button.style.top === dockTop,
  `left=${button.style.left} top=${button.style.top}`)

console.log('\n[4j] 取消选中后按钮必须立刻消失')
// 真实症状：取消选中后按钮赖着不走，**非得点一次聊天框**才消失。
// 原因是"读不到文本就用 5 分钟有效的复制探针缓存兜底"，而取消选中时那个缓存还在，
// 于是按钮一直被兜住；只有点别处触发一次事件才被清掉。
// 正确判据：**高亮层里还有东西吗** —— 取消选中时 xterm 的高亮 div 会消失。
showHighlight()
rememberFresh()
// 先种一份探针缓存。取消选中的事件还没发出时，缓存和登记表都还在。
clipboardPayload.text = 'STALE-PROBE-TOKEN\nshould not be reused'
const staleCopy = new globalThis.ClipboardEvent('copy', { bubbles: false, cancelable: true })
Object.defineProperty(staleCopy, 'target', { value: xterm, configurable: true })
documentStub.dispatch('copy', staleCopy)
ok('（前置）选着文本时按钮可见', button.style.display === 'block', `display=${button.style.display}`)
// 高亮先消失，但还没派发 selectionchange：缓存仍在。快捷键不能拿它认领按键。
clearHighlight()
collapseSelection()
const whileCacheRemains = shortcut.resolve({})
assertResolveShape('高亮已消失但缓存还在时', whileCacheRemains)
ok('高亮消失后快捷键不认领（不把 5 分钟内的旧探针送进对话）',
  whileCacheRemains?.status === 'pass',
  JSON.stringify(whileCacheRemains))
clipboardPayload.text = ''
plugin.__test.resetMouseupGrace() // 排除宽限期的干扰，只看判据本身
documentStub.dispatch('selectionchange')
ok('取消选中（高亮消失）后按钮立刻藏起来，不需要点聊天框',
  button.style.display === 'none',
  `display=${button.style.display}`)
// 高亮层再出现、但没有新的选区文本。若登记表或探针没清掉，按钮会被旧文本兜回来。
showHighlight()
collapseSelection()
plugin.__test.resetMouseupGrace()
documentStub.dispatch('selectionchange')
ok('缓存已清掉：只有空高亮时按钮不再出现',
  button.style.display === 'none',
  `display=${button.style.display}`)
const afterClear = shortcut.resolve({})
assertResolveShape('缓存清掉之后', afterClear)
ok('缓存已清掉：快捷键也不再认领旧文本',
  afterClear?.status === 'pass',
  JSON.stringify(afterClear))
showHighlight() // 还原，供后续用例

console.log('\n[4i] 高亮还原路径的按钮落点（真实终端里的常态）')
// **这条路径此前完全没有夹具覆盖**：夹具里的终端没有高亮几何，所以
// `readHighlightedText` 永远返回空，`[4h]` 走的都是"DOM 可读"或"登记表兜底"。
// 而真实终端里恰恰相反 —— 松开鼠标时 `toString()` 已空、高亮还在，走的就是这条。
//
// 曾经它只返回 `anchor`、不返回 `point`，于是登记表把坐标记成 null，
// 再走兜底时按钮只能退回整个终端矩形的右下角（看起来像贴到面板角落）。
const HL_ROW_H = 17
const hlPieceLow = { style: { top: `${HL_ROW_H}px`, left: '120px', width: '60px', height: `${HL_ROW_H}px` } }
const hlPieceHigh = { style: { top: '0px', left: '0px', width: '400px', height: `${HL_ROW_H}px` } }
const hlLayerEl = { children: [hlPieceHigh, hlPieceLow] }
// 行元素必须给出**真实的 client rect**：落点现在是按行元素算的。
// 第 2 行的矩形刻意与"高亮相对坐标 + 行容器原点"算出来的值不同 —— 那正是导致
// 按钮被推到屏幕外的坐标系错配。若实现退回旧算法，下面的断言会失败。
const hlRowEls = [
  {
    offsetTop: 0,
    offsetHeight: HL_ROW_H,
    textContent: 'first row',
    getBoundingClientRect: () => ({ left: 40, top: 300, right: 700, bottom: 317, width: 660, height: 17 }),
  },
  {
    offsetTop: HL_ROW_H,
    offsetHeight: HL_ROW_H,
    textContent: 'second row',
    getBoundingClientRect: () => ({ left: 40, top: 317, right: 688, bottom: 334, width: 648, height: 17 }),
  },
]
const hlRowsEl = {
  children: hlRowEls,
  // 高亮矩形的 `left` 相对行容器的**内边距框**，所以横向换算要用到 offsetLeft。
  offsetLeft: 0,
  getBoundingClientRect: () => ({ left: 40, top: 300, right: 700, bottom: 334, width: 660, height: 34 }),
}
/** 带高亮几何的终端。刻意不做进共享夹具：只有本节需要它。 */
const hlTerminal = {
  nodeType: 1,
  tagName: 'SECTION',
  isConnected: true,
  querySelector: (sel) => {
    if (sel === '.xterm-rows') return hlRowsEl
    if (sel === '.xterm-selection') return hlLayerEl
    return null
  },
  querySelectorAll: (sel) =>
    sel === '.xterm-selection'
      ? Object.assign([hlLayerEl], { item: (i) => [hlLayerEl][i] ?? null })
      : [],
  closest: () => null,
  getBoundingClientRect: () => ({ left: 40, top: 300, right: 700, bottom: 640, width: 660, height: 340 }),
}
// `.xterm-selection` 层的矩形 —— DOM 选区折叠后，落点就靠它。
// 给一个**与终端明显不同**的位置，这样"用了这一层"和"用了写死坐标"能区分开。
hlLayerEl.getBoundingClientRect = () => ({ left: 200, top: 400, right: 520, bottom: 460, width: 320, height: 60 })
// 让插件在页面上"看到"两个终端，且**只有** hlTerminal 画着高亮
const realQuerySelectorAll = documentStub.querySelectorAll.bind(documentStub)
documentStub.querySelectorAll = (sel) => {
  const base = realQuerySelectorAll(sel)
  if (sel !== '[data-sidebar-terminal]') return base
  return Object.assign([hlTerminal, ...base], { item: (i) => [hlTerminal, ...base][i] ?? null })
}
const hlMouseTarget = { closest: (sel) => (sel === '[data-sidebar-terminal]' ? hlTerminal : null) }

// 走真实序列：DOM 选区已折叠、读不出文本 → 高亮还原接管。
// 这一节要验证的是**内容仍能被还原出来**（高亮几何参与的是"读哪些行"，
// 而不是落点）。落点自本轮起固定停靠输入框上方，不再消费任何选区几何。
selectionState.collapsed = true
selectionState.text = ''
selectionState.node = { nodeType: 3, parentElement: hlTerminal, textContent: '' }
clipboardPayload.text = ''
documentStub.dispatch('mouseup', { target: hlMouseTarget })
ok('DOM 选区为空时，落点仍固定在输入框上方（不依赖任何选区几何）',
  button.style.left === '1096px' && button.style.top === '824px',
  `left=${button.style.left} top=${button.style.top}`)

// 紧接着的空选区 selectionchange 走登记表兜底 —— 位置必须**保持不变**
const afterHl = button.style.left
documentStub.dispatch('selectionchange')
ok('紧随的空选区 selectionchange 不让按钮跳走',
  button.style.left === afterHl,
  `之前 ${afterHl} → 现在 ${button.style.left}`)
ok('按钮仍在视口可见区域内',
  Number.parseFloat(button.style.left) >= 0 &&
    Number.parseFloat(button.style.left) < windowStub.innerWidth &&
    Number.parseFloat(button.style.top) >= 0 &&
    Number.parseFloat(button.style.top) < windowStub.innerHeight,
  `left=${button.style.left} top=${button.style.top}（视口 ${windowStub.innerWidth}x${windowStub.innerHeight}）`)

// ── 隔离清理（不做的话后面的用例会被本节污染）─────────────────────────────
// 本节把 `selectionState.node` 指向了 hlTerminal，并在**共享登记表**里留下一条
// 更新的条目；后续用例的 `newestSelection` 会取到它，于是断言全错。
// 三步还原：文档查询 → 选区指向 → 把 hlTerminal 从登记表里剪掉。
documentStub.querySelectorAll = realQuerySelectorAll
selectionState.node = terminalTextNode
selectionState.collapsed = true
selectionState.text = ''
clipboardPayload.text = ''
hlTerminal.isConnected = false
shortcut.resolve({}) // 读一遍 → 剪掉失效登记
hlTerminal.isConnected = true

// 先在终端里"选中"一次（走真实事件路径，登记进表），再模拟按键
selectionState.text = 'error TS2304: Cannot find name foo\n  1 error'
selectionState.collapsed = false
documentStub.dispatch('selectionchange')
const resolved = shortcut.resolve({})
assertResolveShape('有选区时', resolved)
ok('有选区时 resolve 返回 handled', resolved?.status === 'handled', JSON.stringify(resolved))
ok('handled 结果带 run()', typeof resolved?.run === 'function')

const beforeShortcut = fetchCalls.length
const beforeChips = emitted.length
resolved.run()
await new Promise((resolve) => setTimeout(resolve, 30))
ok('快捷键触发了捕获请求',
  fetchCalls.length > beforeShortcut && fetchCalls.some((c) => c.url === '/dsh-terminal-context/capture'),
  fetchCalls.map((c) => c.url).join(','))
const shortcutChip = emitted.slice(beforeChips).find((e) => e.name === 'slash/input-insert-reference')
ok('快捷键也插入了引用 chip', shortcutChip !== undefined, String(shortcutChip))
ok('chip 指向捕获文件',
  shortcutChip?.payload?.reference?.ref?.startsWith('@.dsh/term-captures/') === true,
  String(shortcutChip?.payload?.reference?.ref))
const lastCapture = fetchCalls.filter((c) => c.url === '/dsh-terminal-context/capture').at(-1)
ok('快捷键送去的是上次选中的文本',
  JSON.parse(lastCapture?.body ?? '{}').text?.includes('TS2304') === true,
  JSON.stringify(JSON.parse(lastCapture?.body ?? '{}').text ?? '').slice(0, 80))

// 终端标签页被关掉（元素脱离文档）后，登记会在下次读取时被剪掉。
// 但**按键这一拍 DOM 里可能仍有实时选区**，所以插件会回退到直接读 DOM——
// 这正是"选中后按 Ctrl+L 毫无反应"那个 bug 的修复点：只信登记表会漏掉这种情况。
//
// 注意：登记表的键是**终端容器** `section[data-sidebar-terminal]`（closestTerminal
// 返回的就是它），不是里面的 `.xterm`，所以要断开的是 terminalSection。
terminalSection.isConnected = false
selectionState.text = 'Build succeeded\n  12 tests passed'
selectionState.collapsed = false
const viaLiveFallback = shortcut.resolve({})
assertResolveShape('登记失效但 DOM 有选区时', viaLiveFallback)
ok('登记表失效时回退到实时 DOM 选区并认领按键',
  viaLiveFallback?.status === 'handled',
  JSON.stringify(viaLiveFallback))

// 两者都没有 → 必须让键（返回 pass，不带 run）
selectionState.collapsed = true
selectionState.text = ''
const nothing = shortcut.resolve({})
assertResolveShape('既无登记也无实时选区时', nothing)
ok('完全没有选区时返回 pass（把键还给终端）',
  nothing?.status === 'pass',
  JSON.stringify(nothing))
ok('pass 结果不带 run（内核不会调用它）',
  nothing?.run === undefined,
  typeof nothing?.run)
terminalSection.isConnected = true

// ── xterm 复制探针兜底（本次修复的核心） ──────────────────────────────────
// 场景：DOM 选区退化到 .xterm-helpers 读不出文本（实测现象），
// 但 xterm 自己在 copy 事件里知道选了什么。插件应旁听并缓存它。
console.log('\n[4e] xterm 复制探针兜底')
selectionState.collapsed = true
selectionState.text = ''
clipboardPayload.text = 'Get-ChildItem -Recurse\n Mode  Name\n ----  ----\n'
const copyEvent = new globalThis.ClipboardEvent('copy', { bubbles: false, cancelable: true })
// Event.target 在真实浏览器里是只读的（派发时由 DOM 填），夹具需显式覆盖它。
Object.defineProperty(copyEvent, 'target', { value: xterm, configurable: true })
documentStub.dispatch('copy', copyEvent)
const afterCopy = shortcut.resolve({})
assertResolveShape('复制探针拿到文本时', afterCopy)
ok('探针文本被当作有效选区，快捷键认领按键',
  afterCopy?.status === 'handled',
  JSON.stringify(afterCopy))

console.log('\n[4f] xterm 高亮叠加层还原（几何还原部分无法在 Node 夹具中验证）')
// 真实形态：`.xterm-rows` 里每行一个 div；高亮画在 `.xterm-selection` 的绝对定位
// div 上。实测鼠标松开时浏览器选区已折叠（collapsed:true、rectCount:0），
// 于是插件改用高亮矩形 + 行文本还原。
//
// ⚠️ 诚实说明：**几何还原那一半没法在这里验证**。FakeElement 的
// `getBoundingClientRect` 在构造函数里就被固定成默认值，`offsetTop/offsetHeight`
// 也不是真实布局值，所以"像素 → 行/列"的换算在夹具里得不到有意义的输入。
// 我试过三种夹具写法都卡在这点上，最终决定不再伪装覆盖。
// 能在这里可靠验证的是：**折叠选区不会让插件误判**（返回 pass 而不是崩溃或瞎认领），
// 以及几何还原函数本身已在独立探针中人工验证过（能还原两行、能按列裁末行）。
const hlSection = new FakeElement('section', {})
hlSection._flags = new Set(['[data-sidebar-terminal]'])
const hlXterm = new FakeElement('div', {})
hlXterm._flags = new Set(['.xterm'])
const hlRowsHost = new FakeElement('div', {})
hlRowsHost._flags = new Set(['.xterm-rows'])
const hlLayer = new FakeElement('div', {})
hlLayer._flags = new Set(['.xterm-selection'])
hlXterm.children = [hlRowsHost, hlLayer]
hlXterm._parent = hlSection
hlSection.children = [hlXterm]
const hlAnchor = { nodeType: 3, parentElement: hlXterm, textContent: '' }

// 清掉前面用例留下的登记表，确保这次读的是"折叠选区 + 无登记"的最坏情况
terminalSection.isConnected = false
shortcut.resolve({}) // 读一遍 → 剪掉旧登记
terminalSection.isConnected = true
clipboardPayload.text = ''
selectionState.collapsed = false
selectionState.text = ''
selectionState.node = hlAnchor
documentStub.dispatch('selectionchange')
const viaHighlight = shortcut.resolve({})
assertResolveShape('折叠选区 + 高亮层存在时', viaHighlight)
ok('折叠选区不会让插件崩溃或误认领（几何读不出时应返回 pass）',
  viaHighlight?.status === 'pass',
  JSON.stringify(viaHighlight))

if (viaHighlight?.status === 'handled') {
  const beforeHighlight = fetchCalls.length
  viaHighlight.run()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const captured = fetchCalls.filter((c) => c.url === '/dsh-terminal-context/capture').at(-1)
  const capturedText = JSON.parse(captured?.body ?? '{}').text ?? ''
  ok('捕获请求数增加', fetchCalls.length > beforeHighlight, String(fetchCalls.length))
  ok('还原出的文本包含第一行内容',
    capturedText.includes('Get-ChildItem'),
    JSON.stringify(capturedText).slice(-140))
  ok('还原出的文本包含第二行内容',
    capturedText.includes('12 tests passed'),
    JSON.stringify(capturedText).slice(-140))
}

console.log('\n[5] 清理')
// 真实卸载会跑掉所有 effect 的清理函数，所以这里全跑一遍而不是挑某一个。
for (const dispose of disposers) dispose()
ok('清理后移除 selectionchange 监听',
  (documentStub.listeners.selectionchange ?? []).length === 0,
  String((documentStub.listeners.selectionchange ?? []).length))
ok('清理后按钮已从页面移除', button.isConnected === false, String(button.isConnected))

console.log('\n[6] 依赖纪律')
ok('没有向模块表索取 Node 内置模块',
  requireErrors.length === 0,
  requireErrors.join(','))
// 4c 场景会**故意**产生一条降级告警，所以这里比对基线而不是断言零告警。
const unexpected = warnings.filter(
  (line) => !line.includes('回退为纯文本提及') && !line.includes('slots 服务不可用'),
)
ok('除故意触发的降级告警外，没有其他告警',
  unexpected.length === 0,
  unexpected.join(' | ') || `(共 ${warnings.length} 条告警，均为预期)`)
ok('启动时打印了可诊断的加载日志',
  consoleLogs.some((line) => line.includes('客户端已加载')),
  consoleLogs.join(' | ') || '(无日志)')

console.log('\n[7] 清单声明合法性（对齐 dsh-client-modules 的校验器）')
// 校验器原文（dsh-client-modules/lib/index.js）：
//   platform 必须是 string；inject / external 必须是字符串数组（可省略）；
//   immediately 必须是 boolean（可省略）。
const manifestPath = new URL('./package.json', import.meta.url)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const decl = manifest?.dsh?.client
ok('dsh.client.platform 是非空字符串',
  typeof decl?.platform === 'string' && decl.platform !== '',
  JSON.stringify(decl?.platform))
const stringArray = (value) =>
  value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== ''))
ok('dsh.client.inject 是字符串数组（或省略）', stringArray(decl?.inject), JSON.stringify(decl?.inject))
ok('dsh.client.external 是字符串数组（或省略）', stringArray(decl?.external), JSON.stringify(decl?.external))
ok('dsh.client.immediately 是 boolean（或省略）',
  decl?.immediately === undefined || typeof decl.immediately === 'boolean',
  JSON.stringify(decl?.immediately))
ok('声明了 dsh.manifestVersion = 1', manifest?.dsh?.manifestVersion === 1,
  JSON.stringify(manifest?.dsh?.manifestVersion))
ok('dsh.bundle.patch 指向存在的补丁文件',
  typeof manifest?.dsh?.bundle?.patch === 'string' &&
    existsSync(new URL(`./${manifest.dsh.bundle.patch.replace(/^\.\//, '')}`, import.meta.url)),
  JSON.stringify(manifest?.dsh?.bundle?.patch))
ok('name 与 bundle 注册 id 一致（契约要求）', manifest?.name === entry?.id,
  `${manifest?.name} vs ${entry?.id}`)

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`)
process.exit(failures === 0 ? 0 : 1)
