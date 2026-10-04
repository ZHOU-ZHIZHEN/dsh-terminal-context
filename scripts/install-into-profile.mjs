/**
 * 把 dsh-terminal-context 直接装进一个 DSH profile（绕过桌面应用的插件管理器）。
 *
 * 桌面应用的 `desktop` profile 被它独占（CLI 会拒绝：profile "desktop" is managed
 * exclusively by the Electron application），所以只能手工做应用本来会做的那两步：
 *   1. 在 profile 里 `pnpm add link:<插件目录>` —— 建立 node_modules 链接并写入 dependencies
 *   2. 把包名追加进 package.json 的 `dsh.profile.bundles`
 *
 * 安全措施：
 *   - 动手前备份 package.json 与 pnpm-lock.yaml（package.json.<时间戳>.bak）
 *   - 任何一步失败都自动回滚已做的改动
 *   - **默认只演练**（--dry-run），必须显式 --apply 才写盘
 *   - 应用正在运行时拒绝执行（避免它退出时用内存状态覆盖我们的写入）
 *
 * 用法：
 *   node install-into-profile.mjs --dry-run
 *   node install-into-profile.mjs --apply
 */

import { readFile, writeFile, copyFile, access, rm, lstat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

// 用 fileURLToPath 而不是读 `url.pathname`：后者在路径含空格或中文时会被
// 百分号编码（`%20`、`%E4%B8%AD`），拼出来的目录根本不存在。
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_NAME = 'dsh-terminal-context'
const PROFILE_DIR = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const DSH_DEPS = path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies')

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const dryRun = !apply

const log = (msg) => console.log(`${dryRun ? '[演练]' : '[执行]'} ${msg}`)
const fail = (msg) => {
  console.error(`\n错误：${msg}`)
  process.exit(1)
}

// ── 前置检查 ──────────────────────────────────────────────────────────────
if (!existsSync(PROFILE_DIR)) fail(`找不到 profile 目录：${PROFILE_DIR}`)
if (!existsSync(path.join(PLUGIN_DIR, 'package.json'))) fail(`找不到插件包：${PLUGIN_DIR}`)
if (!existsSync(path.join(DSH_DEPS, 'pnpm', 'bin', 'pnpm.mjs'))) fail(`找不到 DSH 自带的 pnpm：${DSH_DEPS}`)

// 应用在运行时它的内存状态可能在退出时覆盖我们的写入，所以必须先关掉它。
const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], {
  encoding: 'utf8',
  windowsHide: true,
}).stdout ?? ''
if (/DeepSeek Harness\.exe/i.test(running)) {
  fail('DeepSeek Harness 正在运行。请先完全退出桌面应用，再执行本脚本（避免它退出时覆盖 profile）。')
}

const profilePackagePath = path.join(PROFILE_DIR, 'package.json')
const originalText = await readFile(profilePackagePath, 'utf8')
const manifest = JSON.parse(originalText)

// ── 判断当前状态 ──────────────────────────────────────────────────────────
const bundles = manifest?.dsh?.profile?.bundles
if (!Array.isArray(bundles)) fail('profile 的 package.json 里没有 dsh.profile.bundles 数组')

const linkedPath = path.join(PROFILE_DIR, 'node_modules', PLUGIN_NAME)
const linkedBefore = existsSync(linkedPath)
const alreadyLinked = linkedBefore
const alreadyInBundles = bundles.includes(PLUGIN_NAME)

console.log(`插件目录   : ${PLUGIN_DIR}`)
console.log(`目标 profile: ${PROFILE_DIR}`)
console.log(`已建立链接  : ${alreadyLinked}`)
console.log(`已在 bundles: ${alreadyInBundles}`)
console.log(`依赖声明    : ${JSON.stringify(manifest.dependencies?.[PLUGIN_NAME] ?? null)}`)
console.log()

if (alreadyLinked && alreadyInBundles) {
  console.log('已经是装好的状态，无需操作。')
  process.exit(0)
}

// ── 执行 ──────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupPath = `${profilePackagePath}.${stamp}.bak`
const lockPath = path.join(PROFILE_DIR, 'pnpm-lock.yaml')
const lockBackupPath = `${lockPath}.${stamp}.bak`
let lockBackedUp = false

if (dryRun) {
  log(`会备份 package.json -> ${path.basename(backupPath)}`)
  if (existsSync(lockPath)) log(`会备份 pnpm-lock.yaml -> ${path.basename(lockBackupPath)}`)
  log(`会在 profile 里执行：pnpm add link:${PLUGIN_DIR}`)
  log(`会把 "${PLUGIN_NAME}" 追加到 dsh.profile.bundles`)
  log('演练结束。确认无误后加 --apply 真正执行。')
  process.exit(0)
}

await copyFile(profilePackagePath, backupPath)
if (existsSync(lockPath)) {
  await copyFile(lockPath, lockBackupPath)
  lockBackedUp = true
}
log(`已备份 -> ${path.basename(backupPath)}${lockBackedUp ? ` 与 ${path.basename(lockBackupPath)}` : ''}`)

/**
 * 回滚：恢复 package.json 与锁文件，并删掉**本次操作建立的**链接。
 *
 * 只删我们建的那个，并且**先 lstat 确认它真的是链接/junction** 才删：
 * `rm(..., { recursive: true })` 对普通目录也会照删不误，所以不加这一步的话，
 * 万一 `linkedPath` 在此期间变成了真实目录（或指向别处），就会删掉不该删的东西。
 * 另外要求它本次操作前不存在（`linkedBefore === false`）。
 */
async function rollback(reason) {
  console.error(`\n失败，正在回滚：${reason}`)
  try {
    await copyFile(backupPath, profilePackagePath)
    if (lockBackedUp) await copyFile(lockBackupPath, lockPath)
    console.error(`已恢复 package.json${lockBackedUp ? ' 与 pnpm-lock.yaml' : ''}`)
  } catch (error) {
    console.error(`回滚时又出错（请手工恢复 ${backupPath}）：`, error)
  }
  // 链接清理单独兜底：链接没删掉不构成"回滚失败"，报告的仍是原始失败原因。
  if (!linkedBefore) {
    try {
      const info = await lstat(linkedPath) // 不存在会抛 ENOENT，正好跳过
      if (!info.isSymbolicLink()) {
        console.error(`跳过清理：${linkedPath} 不是链接（${info.isDirectory() ? '目录' : '文件'}），不删。`)
        process.exit(1)
      }
      await rm(linkedPath, { recursive: true, force: true })
      console.error(`已移除本次建立的链接：${linkedPath}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.error(`链接未能移除（可手工删除 ${linkedPath}）：`, error)
      }
    }
  }
  process.exit(1)
}

// 1) pnpm add link:<插件>
const pnpmResult = spawnSync(
  process.execPath,
  [path.join(DSH_DEPS, 'pnpm', 'bin', 'pnpm.mjs'), 'add', `link:${PLUGIN_DIR}`],
  {
    cwd: PROFILE_DIR,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PATH: `${path.join(DSH_DEPS, 'node', 'bin')}${path.delimiter}${process.env.PATH}` },
  },
)
if (pnpmResult.status !== 0) {
  console.error(pnpmResult.stdout ?? '')
  console.error(pnpmResult.stderr ?? '')
  await rollback(`pnpm add 退出码 ${pnpmResult.status}`)
}
log('pnpm add 完成')

// 2) 追加到 dsh.profile.bundles（pnpm 会重写 package.json，所以重新读一遍）
const afterPnpm = JSON.parse(await readFile(profilePackagePath, 'utf8'))
const list = afterPnpm?.dsh?.profile?.bundles
if (!Array.isArray(list)) await rollback('pnpm 之后 bundles 数组不见了')
if (!list.includes(PLUGIN_NAME)) {
  list.push(PLUGIN_NAME)
  await writeFile(profilePackagePath, `${JSON.stringify(afterPnpm, null, 2)}\n`, 'utf8')
  log(`已把 "${PLUGIN_NAME}" 追加到 dsh.profile.bundles`)
} else {
  log('bundles 里已经有了，跳过')
}

// ── 校验 ──────────────────────────────────────────────────────────────────
const final = JSON.parse(await readFile(profilePackagePath, 'utf8'))
const checks = [
  ['node_modules 链接存在', existsSync(path.join(PROFILE_DIR, 'node_modules', PLUGIN_NAME))],
  ['dependencies 已声明', typeof final.dependencies?.[PLUGIN_NAME] === 'string'],
  ['bundles 已包含插件', final.dsh.profile.bundles.includes(PLUGIN_NAME)],
  ['插件入口存在', existsSync(path.join(PLUGIN_DIR, 'lib', 'client.js'))],
]
console.log('\n校验：')
let allOk = true
for (const [label, pass] of checks) {
  console.log(`  ${pass ? 'OK  ' : 'FAIL'} ${label}`)
  if (!pass) allOk = false
}

console.log('\n最终 bundles：')
for (const name of final.dsh.profile.bundles) console.log(`  - ${name}`)

if (!allOk) {
  await rollback('校验未通过')
}

console.log(`\n完成。回滚命令（如需）：`)
console.log(`  copy "${backupPath}" "${profilePackagePath}"${lockBackedUp ? `\n  copy "${lockBackupPath}" "${lockPath}"` : ''}`)
console.log('\n下一步：启动 DeepSeek Harness，在侧栏终端里划选一段输出。')
