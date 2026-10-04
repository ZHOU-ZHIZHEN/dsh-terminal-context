/**
 * dsh-terminal-context — 宿主（Node）一半。
 *
 * 职责只有一件：**落盘**。浏览器侧拿不到 `node:fs`（DSH 的客户端模块表只提供
 * React / Cordis / UI 库这类基线模块，不含 Node 内置），所以捕获文本由客户端
 * POST 过来，这里写进会话工作区下的 `.dsh/term-captures/` 目录，再把工作区
 * 相对路径回给客户端，由客户端用 DSH 原生的 `@file` 引用插进输入框。
 *
 * 安全边界：
 *   - 目标目录固定为 `<会话工作区>/.dsh/term-captures/`，调用方无法指定路径；
 *   - 文件名由服务端用时间戳生成，调用方无法注入路径分隔符；
 *   - 写入前用 realpath 复检真实路径仍在该目录内（防符号链接逃逸）；
 *   - 任何解析失败都**拒绝写入**并报错，绝不猜一个目录往里写。
 */

export const name = 'dsh-terminal-context'

/** 需要宿主服务：Web 服务器（注册路由）与会话（解析工作区）。 */
export const inject = ['webServer', 'sessions']

/** 录制文件目录名（相对会话工作区）。
 *
 *  放在**点前缀隐藏目录**里，对齐 AI 工具的通行惯例（`.claude/`、`.cursor/` 都是
 *  这个形态）：编辑器文件树、`dir`、`ls` 默认都不显示它，工作区视觉上保持干净，
 *  而 `dir /a` / `Get-ChildItem -Force` 与插件自己仍能正常访问。
 *  嵌套一层是给以后别的插件产物留位置。
 */
const CAPTURE_DIR = '.dsh/term-captures'
/** 单次捕获的字符上限，与客户端保持一致。 */
const MAX_TEXT_CHARS = 200000
/** 请求体大小上限。 */
const MAX_BODY_BYTES = 4 << 20
/** 保留的录制文件数量上限。 */
const CAPTURE_KEEP = 20
/** 路由前缀。 */
const ROUTE_BASE = '/dsh-terminal-context'

export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/capture`,
      handler: captureHandler(ctx),
    }),
  )
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/sweep`,
      handler: sweepHandler(ctx),
    }),
  )
  // 诊断通道：桌面客户端打不开 DevTools，所以客户端把运行状态回传到这里，
  // 由宿主写进 $DSH_HOME/dsh-terminal-context-diag.json，便于没有控制台时定位问题。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/diag`,
      handler: diagHandler(),
    }),
  )
}

/** POST /dsh-terminal-context/diag — 把客户端上报的诊断记录落盘。 */
function diagHandler() {
  return async (req, res) => {
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'method-error', 'POST required')
      const payload = await readJsonBody(req)
      // 客户端送来的是 { event, detail, pluginVersion, at }；原样保留成一条记录，
      // 不要把它整个塞进 event 字段（那样事件名会变成一层对象）。
      const os = await import('node:os')
      const path = await import('node:path')
      const fs = await import('node:fs/promises')
      const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
      const file = path.join(home, 'dsh-terminal-context-diag.json')
      let log = []
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
        if (Array.isArray(parsed)) log = parsed
      } catch {
        log = []
      }
      log.push({
        receivedAt: new Date().toISOString(),
        event: typeof payload?.event === 'string' ? payload.event : '(unnamed)',
        detail: payload?.detail ?? null,
        pluginVersion: payload?.pluginVersion ?? null,
        clientAt: payload?.at ?? null,
      })
      // 只保留最近 200 条，避免无限增长。
      if (log.length > 200) log = log.slice(log.length - 200)
      await fs.writeFile(file, JSON.stringify(log, null, 2), 'utf8')
      writeJson(res, 200, { ok: true, value: { file, entries: log.length } })
    } catch (error) {
      writeRouteError(res, error)
    }
  }
}

/** POST /dsh-terminal-context/capture — 写入一份终端捕获。 */
function captureHandler(ctx) {
  return async (req, res) => {
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'method-error', 'POST required')
      const payload = await readJsonBody(req)
      const sessionId = requireString(payload, 'sessionId')
      const text = requireString(payload, 'text')

      const cwd = resolveWorkspace(ctx, sessionId)
      const dir = await ensureCaptureDir(cwd)

      const fs = await import('node:fs/promises')
      // 文件名必须**每次调用都唯一**。客户端送来的 stamp 只精确到秒，
      // 同一秒内连点两次按钮（或连按两次快捷键）会得到同名文件，而
      // `writeFile` 默认是覆盖写 —— 后一次的正文会盖掉前一次，
      // 两个 chip 却指向同一路径（真发生过）。
      //
      // 做法：以客户端 stamp 为前缀（可排序、可读），宿主再加 base36 计数器后缀，
      // 并用 `wx`（O_CREAT|O_EXCL）原子地写入：-0 首选，EEXIST 就试 -1、-2……
      const stamp = sanitizeStamp(requireString(payload, 'stamp'))
      const body = text.slice(0, MAX_TEXT_CHARS)
      const { name, target } = await writeUniqueCapture(dir, stamp, body, fs)

      void sweep(cwd, fs)

      writeJson(res, 200, {
        ok: true,
        value: {
          absolutePath: target,
          relativePath: `${CAPTURE_DIR}/${name}`,
          workspaceRoot: cwd,
          bytes: Buffer.byteLength(body, 'utf8'),
        },
      })
    } catch (error) {
      writeRouteError(res, error)
    }
  }
}

/**
 * 用一个没被占用的名字写入捕获内容。
 *
 * 用 `wx` 标志原子地"创建并写入"：文件已存在就换下一个后缀重试，
 * 所以既不覆盖别人的文件，也不会有两次写入之间的竞态窗口。
 *
 * **后缀必须用 `~`，不能用 `-`**：清理逻辑按文件名字典序判断新旧
 * （`terminal-<stamp>.txt` 与 `terminal-<stamp>~1.txt`）。
 * `'-'`(45) 排在 `'.'`(46) **之前**，所以 `-1` 会被当成比无后缀那份更旧 ——
 * 同一秒内连点超过保留上限时，**后捕获的那份反而先被删掉**。
 * `'~'`(126) 排在 `'.'` 之后，字典序就等于写入顺序。实测踩过。
 *
 * @returns {Promise<{ name: string, target: string }>} 实际使用的文件名与绝对路径
 * @throws HttpError(500) 连续 1000 个候选都被占用时（不该发生）
 */
async function writeUniqueCapture(dir, stamp, body, fs) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0 ? '' : `~${attempt.toString(36)}`
    const name = `terminal-${stamp}${suffix}.txt`
    const target = await joinInside(dir, name)
    try {
      await fs.writeFile(target, body, { encoding: 'utf8', flag: 'wx' })
      return { name, target }
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      throw error
    }
  }
  throw new HttpError(500, 'internal', '无法为捕获文件分配唯一名字')
}

/** POST /dsh-terminal-context/sweep — 清理超额的历史捕获。 */
function sweepHandler(ctx) {
  return async (req, res) => {
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'method-error', 'POST required')
      const payload = await readJsonBody(req)
      const sessionId = requireString(payload, 'sessionId')
      const fs = await import('node:fs/promises')
      const removed = await sweep(resolveWorkspace(ctx, sessionId), fs)
      writeJson(res, 200, { ok: true, value: { removed } })
    } catch (error) {
      writeRouteError(res, error)
    }
  }
}

// ── 工作区解析 ────────────────────────────────────────────────────────────

/**
 * 会话工作区根目录。权威来源是会话头（`ctx.sessions.get(id).header.cwd`）。
 * 解析不出来时抛错——宁可不写，也不往猜测的目录里落文件。
 */
function resolveWorkspace(ctx, sessionId) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) {
    throw new HttpError(404, 'not-found', `找不到会话 ${sessionId}`)
  }
  const candidates = [
    session.header?.cwd,
    session.header?.workspace?.root,
    session.meta?.cwd,
  ]
  const cwd = candidates.find((value) => typeof value === 'string' && value !== '')
  if (cwd === undefined) {
    throw new HttpError(
      500,
      'no-workspace',
      `会话 ${sessionId} 没有可用的工作区目录（header 字段：${Object.keys(session.header ?? {}).join(', ') || '空'}）`,
    )
  }
  return cwd
}

/** 确保捕获目录存在，并用 realpath 复检它确实落在工作区内。 */
async function ensureCaptureDir(cwd) {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const dir = path.join(cwd, CAPTURE_DIR)
  await fs.mkdir(dir, { recursive: true })
  const [realCwd, realDir] = await Promise.all([fs.realpath(cwd), fs.realpath(dir)])
  if (!isInside(realCwd, realDir)) {
    throw new HttpError(403, 'forbidden', '捕获目录解析后落在工作区之外，已拒绝写入')
  }
  return realDir
}

/** 在目录内拼一个文件名（名字由服务端生成，不接受调用方路径）。 */
async function joinInside(dir, name) {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new HttpError(400, 'bad-request', '非法的文件名')
  }
  const path = await import('node:path')
  return path.join(dir, name)
}

/** 清理并校验时间戳，只允许数字与连字符。 */
function sanitizeStamp(stamp) {
  const cleaned = stamp.replace(/[^0-9-]/g, '')
  if (cleaned === '') throw new HttpError(400, 'bad-request', '非法的 stamp')
  return cleaned
}

/** `child` 是否等于 `parent` 或位于其下（大小写按平台语义比较）。 */
function isInside(parent, child) {
  const strip = (value) => value.replace(/[\\/]+$/, '')
  const normalize = (value) =>
    process.platform === 'win32' ? strip(value).toLowerCase() : strip(value)
  const normalizedParent = normalize(parent)
  const normalizedChild = normalize(child)
  const next = normalizedChild.slice(normalizedParent.length, normalizedParent.length + 1)
  return (
    normalizedChild === normalizedParent ||
    (normalizedChild.startsWith(normalizedParent) && (next === '\\' || next === '/'))
  )
}

/**
 * 只保留最近 CAPTURE_KEEP 份捕获，返回删除数量。
 *
 * 删除前**必须**走与写入相同的 realpath 约束：`ensureCaptureDir` 会解析符号链接并
 * 拒绝落在工作区之外的目录，但这里如果不解析，`.dsh/term-captures` 一旦是指向别处的
 * 链接，就会删掉**链接目标**里所有 `terminal-*` 文件（真会咬人）。
 * 所以：目录先 realpath，再复检仍在工作区内；不在就整体放弃清理。
 */
async function sweep(cwd, fs) {
  try {
    const path = await import('node:path')
    const dir = path.join(cwd, CAPTURE_DIR)
    const [realCwd, realDir] = await Promise.all([fs.realpath(cwd), fs.realpath(dir)])
    if (!isInside(realCwd, realDir)) return 0

    const names = (await fs.readdir(realDir)).filter((name) => name.startsWith('terminal-')).sort()
    if (names.length <= CAPTURE_KEEP) return 0
    const stale = names.slice(0, names.length - CAPTURE_KEEP)
    await Promise.all(
      // 先确认是普通文件（不跟随链接去删目标），再删。
      stale.map(async (name) => {
        const target = path.join(realDir, name)
        try {
          const info = await fs.lstat(target)
          if (!info.isFile()) return
          await fs.rm(target, { force: true })
        } catch {
          // 单个文件失败不影响其余清理。
        }
      }),
    )
    return stale.length
  } catch {
    return 0
  }
}

// ── HTTP 小工具 ───────────────────────────────────────────────────────────

/** 带 HTTP 状态码的路由错误。 */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** 读取并解析 JSON 请求体（有大小上限）。 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new HttpError(413, 'too-large', '请求体过大')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'bad-request', '请求体不是合法 JSON')
  }
}

/** 取一个必填字符串字段。 */
function requireString(payload, key) {
  const value = payload?.[key]
  if (typeof value !== 'string' || value === '') {
    throw new HttpError(400, 'bad-request', `缺少或非法字段 "${key}"`)
  }
  return value
}

/** 写 JSON 响应。 */
function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 统一的失败响应。 */
function writeRouteError(res, error) {
  const status = error instanceof HttpError ? error.status : 500
  const code = error instanceof HttpError ? error.code : 'internal'
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'internal') console.warn('[dsh-terminal-context] 路由失败：', error)
  writeJson(res, status, { ok: false, error: { code, message } })
}
