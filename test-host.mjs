/**
 * dsh-terminal-context 宿主一半的离线验证。
 *
 * 用一个假的 ctx（webServer + sessions）+ 假的 req/res 调真实路由处理器，
 * 验证：路由注册形状、工作区解析、落盘内容、返回的相对路径、错误分支。
 */
import { pathToFileURL } from 'node:url'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const HOST_MODULE = process.argv[2]
const mod = await import(pathToFileURL(HOST_MODULE).href)

let failures = 0
const ok = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// ── 假宿主 ────────────────────────────────────────────────────────────────
const workspace = await mkdtemp(path.join(tmpdir(), 'dsh-tc-test-'))
const sessionId = 'session-test-1'
const routes = []

const ctx = {
  effect(fn) {
    const disposer = fn()
    return () => disposer?.()
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  sessions: {
    get(id) {
      return id === sessionId ? { header: { cwd: workspace } } : undefined
    },
  },
}

console.log('\n[1] 模块形状')
ok('导出 name', mod.name === 'dsh-terminal-context', String(mod.name))
ok('导出 apply 函数', typeof mod.apply === 'function')
ok('inject 声明了 webServer 与 sessions',
  Array.isArray(mod.inject) && mod.inject.includes('webServer') && mod.inject.includes('sessions'),
  JSON.stringify(mod.inject))

console.log('\n[2] 路由注册')
mod.apply(ctx)
ok('注册了三个路由', routes.length === 3, `实际 ${routes.length}`)
ok('三个路由都是 exact',
  routes.every((r) => r.kind === 'exact'),
  routes.map((r) => r.kind).join(','))
ok('capture 路由路径正确',
  routes.some((r) => r.path === '/dsh-terminal-context/capture'),
  routes.map((r) => r.path).join(','))
ok('sweep 路由路径正确',
  routes.some((r) => r.path === '/dsh-terminal-context/sweep'),
  routes.map((r) => r.path).join(','))
ok('diag 路由路径正确（无 DevTools 时的诊断通道）',
  routes.some((r) => r.path === '/dsh-terminal-context/diag'),
  routes.map((r) => r.path).join(','))

// ── 假 req/res ────────────────────────────────────────────────────────────
const makeReq = (method, body) => ({
  method,
  async *[Symbol.asyncIterator]() {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
  },
})
const makeRes = () => {
  const captured = { status: 0, headers: null, body: '' }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(payload) {
      captured.body = payload ?? ''
    },
  }
}

const captureRoute = routes.find((r) => r.path.endsWith('/capture'))
const sweepRoute = routes.find((r) => r.path.endsWith('/sweep'))

console.log('\n[3] capture：正常落盘')
const sample = 'PS D:\\Code> git status\r\nOn branch main\r\nnothing to commit   \r\n'
const res1 = makeRes()
await captureRoute.handler(makeReq('POST', { sessionId, text: sample, stamp: '20261003-121500' }), res1)
const body1 = JSON.parse(res1.captured.body)
ok('HTTP 200', res1.captured.status === 200, String(res1.captured.status))
ok('ok:true 信封', body1.ok === true, res1.captured.body.slice(0, 200))
ok('返回工作区相对路径',
  body1.value?.relativePath === '.dsh/term-captures/terminal-20261003-121500.txt',
  String(body1.value?.relativePath))
ok('回显工作区根', body1.value?.workspaceRoot === workspace, String(body1.value?.workspaceRoot))

const written = await readFile(body1.value.absolutePath, 'utf8')
ok('文件内容与提交文本一致', written === sample, JSON.stringify(written.slice(0, 80)))
ok('文件落在工作区内的捕获目录',
  path.dirname(body1.value.absolutePath) === path.join(workspace, '.dsh', 'term-captures'),
  path.dirname(body1.value.absolutePath))

console.log('\n[4] capture：错误分支')
const res2 = makeRes()
await captureRoute.handler(makeReq('POST', { sessionId: 'nope', text: 'x', stamp: '1' }), res2)
const body2 = JSON.parse(res2.captured.body)
ok('未知会话 → 404 not-found',
  res2.captured.status === 404 && body2.error?.code === 'not-found',
  `${res2.captured.status} ${res2.captured.body.slice(0, 140)}`)

const res3 = makeRes()
await captureRoute.handler(makeReq('POST', { sessionId, stamp: '1' }), res3)
ok('缺 text → 400 bad-request',
  res3.captured.status === 400 && JSON.parse(res3.captured.body).error?.code === 'bad-request',
  String(res3.captured.status))

const res4 = makeRes()
await captureRoute.handler(makeReq('GET'), res4)
ok('GET → 405 method-error',
  res4.captured.status === 405 && JSON.parse(res4.captured.body).error?.code === 'method-error',
  String(res4.captured.status))

const res5 = makeRes()
await captureRoute.handler(makeReq('POST', { sessionId, text: 'x', stamp: '../../evil' }), res5)
const body5 = JSON.parse(res5.captured.body)
ok('非法时间戳被整体拒绝（不产生路径穿越）',
  res5.captured.status === 400 && body5.error?.code === 'bad-request',
  `${res5.captured.status} ${res5.captured.body.slice(0, 160)}`)

const res6 = makeRes()
await captureRoute.handler(makeReq('POST', { sessionId, text: 'x', stamp: '20-26_abc' }), res6)
const body6 = JSON.parse(res6.captured.body)
ok('合法字符被保留、非法字符被剥离',
  res6.captured.status === 200 && /terminal-20-26([~-][0-9a-z]+)?\.txt$/.test(body6.value.relativePath),
  res6.captured.body.slice(0, 160))

console.log('\n[4b] 同一秒内多次捕获必须各写一个文件（不得互相覆盖）')
// 曾经的 bug：文件名只精确到秒 + writeFile 覆盖写 → 连点两次只剩后一份内容，
// 两个 chip 却指向同一路径。这里连发三次**完全相同的 stamp**，要求三个不同文件、
// 各自内容都在。
const sameStamp = '20261003-235959'
const sameSecondResults = []
for (const body of ['first body', 'second body', 'third body']) {
  const res = makeRes()
  await captureRoute.handler(makeReq('POST', { sessionId, text: body, stamp: sameStamp }), res)
  sameSecondResults.push({ status: res.captured.status, body: JSON.parse(res.captured.body) })
}
ok('三次同 stamp 请求都成功',
  sameSecondResults.every((r) => r.status === 200),
  sameSecondResults.map((r) => r.status).join(','))
const paths = sameSecondResults.map((r) => r.body.value?.relativePath)
ok('三次得到三个不同的相对路径',
  new Set(paths).size === 3,
  paths.join(' | '))
const contents = await Promise.all(
  sameSecondResults.map((r) => readFile(r.body.value.absolutePath, 'utf8')),
)
ok('三份内容都在，没有互相覆盖',
  contents[0] === 'first body' && contents[1] === 'second body' && contents[2] === 'third body',
  JSON.stringify(contents))
ok('后缀按可达顺序递增（无后缀首选，冲突后用 ~1、~2）',
  paths[0].endsWith(`${sameStamp}.txt`) &&
    paths[1].endsWith(`${sameStamp}~1.txt`) &&
    paths[2].endsWith(`${sameStamp}~2.txt`),
  paths.join(' | '))
/**
 * **后缀必须用 `~` 而不是 `-`**：sweep 按文件名字典序判断新旧，而 `'-'`(45) 排在
 * `'.'`(46) 之前，于是 `-1` 会被当成比无后缀那份更旧 —— 同一秒连点超过保留上限时，
 * 后捕获的那份反而先被删。这条断言把"字典序 == 写入顺序"钉住。
 */
ok('字典序等于写入顺序（sweep 据此判新旧，错了就会删掉最新的）',
  [...paths].sort().join() === paths.join(),
  `sorted=${[...paths].sort().join(' | ')}  written=${paths.join(' | ')}`)

console.log('\n[5] sweep：保留上限')
const dir = path.join(workspace, '.dsh', 'term-captures')
await mkdir(dir, { recursive: true })
for (let i = 0; i < 25; i += 1) {
  const res = makeRes()
  await captureRoute.handler(
    makeReq('POST', { sessionId, text: `sample ${i}`, stamp: `20260101-0000${String(i).padStart(2, '0')}` }),
    res,
  )
}
const resSweep = makeRes()
await sweepRoute.handler(makeReq('POST', { sessionId }), resSweep)
const sweepBody = JSON.parse(resSweep.captured.body)
const remaining = (await readFile(path.join(dir, 'terminal-20260101-000000.txt'), 'utf8').catch(() => null))
ok('sweep 返回 200', resSweep.captured.status === 200, String(resSweep.captured.status))
ok('sweep 报告删除数量', typeof sweepBody.value?.removed === 'number', resSweep.captured.body.slice(0, 120))
ok('最早的文件已被清理', remaining === null, '最早的捕获文件仍然存在')

console.log('\n[6] diag：客户端诊断上报（无 DevTools 时的可见通道）')
const diagRoute = routes.find((r) => r.path.endsWith('/diag'))
const diagHome = await mkdtemp(path.join(tmpdir(), 'dsh-tc-home-'))
process.env.DSH_HOME = diagHome
const resDiag = makeRes()
await diagRoute.handler(
  makeReq('POST', {
    event: 'selection-ok',
    detail: { chars: 42, lines: 3, via: 'range' },
    pluginVersion: '0.1.0',
    at: new Date().toISOString(),
  }),
  resDiag,
)
const diagBody = JSON.parse(resDiag.captured.body)
ok('diag 返回 200', resDiag.captured.status === 200, String(resDiag.captured.status))
const diagFile = path.join(diagHome, 'dsh-terminal-context-diag.json')
const diagLog = JSON.parse(await readFile(diagFile, 'utf8').catch(() => 'null'))
ok('诊断记录已落盘', Array.isArray(diagLog) && diagLog.length === 1, JSON.stringify(diagLog)?.slice(0, 160))
ok('记录了事件名与详情',
  diagLog?.[0]?.event === 'selection-ok' && diagLog?.[0]?.detail?.via === 'range',
  JSON.stringify(diagLog?.[0])?.slice(0, 200))
ok('事件名是字符串而不是被套了一层对象',
  typeof diagLog?.[0]?.event === 'string',
  typeof diagLog?.[0]?.event)
ok('保留了客户端的版本与时间戳',
  diagLog?.[0]?.pluginVersion === '0.1.0' && typeof diagLog?.[0]?.clientAt === 'string',
  JSON.stringify(diagLog?.[0])?.slice(0, 200))
ok('返回里带上了文件路径', typeof diagBody.value?.file === 'string', String(diagBody.value?.file))

const resDiag2 = makeRes()
await diagRoute.handler(makeReq('GET'), resDiag2)
ok('diag 的 GET → 405',
  resDiag2.captured.status === 405,
  String(resDiag2.captured.status))

await rm(diagHome, { recursive: true, force: true })
await rm(workspace, { recursive: true, force: true })

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`)
process.exit(failures === 0 ? 0 : 1)
