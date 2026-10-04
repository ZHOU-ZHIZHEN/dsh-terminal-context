# dsh-terminal-context

在 DSH 的**内置右侧栏终端**里划选一段输出，再点进当前对话的输入框。
输入框上方会浮出 **「添加到上下文」** 按钮，靠聊天区右侧，位置固定。
点一下，这段输出就变成当前对话输入框里的一个 **`@file` 引用 chip** —— 和你手敲 `@文件`
得到的完全一样：可点击预览，发送时展开成完整内容。

交互对齐 Cursor 的 `@Terminals` 和 Trae 的「添加到对话」，而不是"复制一大段文本粘贴过去"。
按钮不贴着选区：这个终端里拿不到可靠的选区屏幕坐标，固定位置不会乱跳，也不会压住输入框。

[English](README.md) | 中文

## 两种触发方式

1. **按钮** —— 在终端里划选，然后点进输入框（发消息本来就要点这里）。
   「添加到上下文」出现在输入框上方。点它。

   划选松开的那一拍，浏览器选区经常已经折叠，按钮往往要等这次点进输入框带来的
   `selectionchange` 才出现。取消终端选中、xterm 的灰色高亮消失之后，按钮立刻消失。
2. **快捷键** —— 终端里灰色高亮还在时，按 **`Ctrl+L`**（macOS 为 `Cmd+L`）。命令 id 是
   `dsh-terminal-context.add`，可在**「设置 → 快捷键」**里改键。

快捷键在**没有可用选区时不会认领这个键**，所以不会永久霸占 `Ctrl+L`。高亮层空了之后，
它也不会把几分钟前缓存的旧输出送进对话。但要注意：**选区有效时**它会被接管，
`Ctrl+L` 不再清屏——要清屏请敲 `clear`。

## 为什么落成文件而不是直接插入文本

终端输出动辄几百行。直接当纯文本塞进输入框会：把你的提问淹掉、每次重发都重复烧 token、
而且丢掉了来源（这是终端输出还是你手写的？）。

所以走**捕获文件 + 原生文件引用**：

1. 选中文本 → 写入 `<工作区>/.dsh/term-captures/terminal-<时间戳>.txt`（带简短来源头部）
2. 用 DSH 原生的结构化引用机制把它插成 chip
3. 发送时序列化成 `@.dsh/term-captures/terminal-….txt`，agent 直接 read 即可

输入框保持干净、引用可点击预览、旧捕获自动只保留最近 20 份。

落盘时会做一处**有意的清理**：**去掉每行行尾的空白，以及首尾的空行**。
xterm 会把每一行补齐到终端宽度（补空格），若原样保留就会带上几百个不可见字符 ——
可见文本不受影响，但这里的"原文一字不改"指的是**你看到的那段文本**，不是带填充的缓冲区。

## 安装

DSH **没有官方插件商店**，分发靠 npm、git 仓库或 tarball，应用自带的插件管理器三种都支持。

**从 npm 安装**（推荐——预构建产物，不需要构建脚本授权）：

```sh
dsh plugin --profile web add dsh-terminal-context
```

**从 GitHub 安装** —— 本仓库已内置构建好的客户端 bundle，所以**无需构建步骤、也不会触发
`allowBuilds` 授权**：

```sh
dsh plugin --profile web add github:ZHOU-ZHIZHEN/dsh-terminal-context
```

**Tarball** —— 用 `pnpm pack` 生成，然后
`dsh plugin --profile web add ./dsh-terminal-context-0.1.0.tgz`。

**桌面版** —— `desktop` profile 由 Electron 应用独占，CLI 会拒绝
（`profile "desktop" is managed exclusively by the Electron application`），
所以用应用自带入口：**左侧栏「插件」→ 添加插件**，填入本目录的绝对路径，然后**重启**。

> 注意：`设置 → 内置插件` 是**只读**的库存列表，管理入口在**侧栏**。

## 插入是怎么实现的（三层兜底）

往输入框插引用 chip 只有一个正规入口：会话作用域事件 `slash/input-insert-reference`。
它的 `span` 必须携带**当前** `draftRev`（宿主做修订号 CAS），且 `reference.source` 必须是
内核认得的源名——否则用户**根本发不出消息**。

难点在于拿到那个 span。`inputActions.captureInsertion()` 是插槽组件的标准 props，而裸
`apply(ctx)` 能否直接走 `conversation.input.for(scope)` 并不保证。所以三条都准备，按序尝试：

1. **插槽桥（首选）** —— 往已声明的**列表**插槽 `conversation.input.dock`
   （内核自带的 `todo` / `queue` 也在那里）注册一个**无界面组件**。它必定拿到标准 props
   `inputActions`，把当前会话的 `captureInsertion` / `insertText` 记进模块级桥。
2. **服务直连** —— `ctx.get('conversation').input.for(scope)`。
3. **纯文本降级** —— `@路径` 当普通文本送出，DSH 仍会做文件夹装饰。

**`bail()` 的返回值会被检查**：宿主的 `insertReference` 内部有修订号 CAS 与阶段检查，
返回 `false` 就是这次插入被拒，必须换通路，**绝不假装成功**。

任何一层失败只打一条 `[dsh-terminal-context]` 告警，不会中断 UI。

### 选区读取：两条路，精度不同

| 路径 | 何时使用 | 精度 |
|---|---|---|
| xterm 原生选区 | DOM 选区仍可读时 | **精确** |
| 高亮层还原 | 选区已折叠时 | **按行取，宁可多给** |

实测：鼠标松开那一刻，浏览器选区往往**已经折叠**（`collapsed: true`、零矩形），
于是 `window.getSelection().toString()` 和合成 `copy` 探针**都是空的**——而 xterm 的灰色
高亮还画着，因为那是它自己绘制的独立层。所以还原路径去读 `.xterm-selection` 的
绝对定位高亮矩形，判断**覆盖了哪些行**，然后整行取文本。

⚠️ **有意保留的取舍：边界行可能多带一两行。**
早期版本实现过"末行按列裁"以追求精确，但那需要把像素宽度换算成字符列，实测**会切掉用户
真正想要的文本**（把 `ls -la` 的末行切成半个词、并丢掉末尾若干行），直接违背"原文一字
不改"的根本承诺。现在的原则是 **宁多勿少**——多给的行一眼能删，少给要重新选一次。

## 结构

| 文件 | 作用 |
|---|---|
| `lib/client.js` | 浏览器半，**构建产物格式**（`window.__ModuleLoader__.load`）：选区监听、输入框上方的按钮、快捷键、插槽桥、引用 chip |
| `lib/index.js` | 宿主半（Node）：HTTP 路由（`capture` / `sweep` / `diag`）与工作区 realpath jail |
| `cordis.patch.yml` | bundle 层，把本插件的行插进 profile |
| `test-host.mjs` | 宿主半离线验证（假 ctx + 假 req/res） |
| `test-client.mjs` | 客户端半离线验证（假模块表 + 假 DOM） |

## 验证

```sh
node test-host.mjs lib/index.js     # 路由、落盘、错误分支、保留清理
node test-client.mjs lib/client.js  # bundle 契约、启动、完整点击链路
```

## 已知边界

- **按钮固定在输入框上方，不跟选区走。** 高亮矩形、行坐标和鼠标位置都试过，在这个
  终端里会把按钮推到终端右缘、屏幕外，或压在输入框上。划选完成的那一拍经常读不到文本，
  按钮多半在点进输入框时才出现。
- **三条 HTTP 路由不校验调用方。** `/capture`、`/sweep`、`/diag` 通过 DSH 自带的
  `webServer` 注册，插件里没有任何一步检查"谁在请求"：能连到这个端口的人就可以往某个会话
  工作区写捕获文件（agent 随后可能读到它）、触发一次保留清理、或追加诊断记录。
  本机实测：用 Node 脚本发一个**不带任何凭据**的 `fetch` 就能打到处理函数
  （返回 `405` 而不是 `401`）。

  这个端口能否被应用自己的页面之外访问，取决于宿主而非本插件，而我无法验证
  （这台机器上没有独立的 `webServer` 实现可测）。所以：**请让 DSH 的 Web 端口只绑回环，
  不要暴露到局域网或公网。** 在插件里自造一个 token 只会带来虚假的安全感 ——
  能打到这条路由的东西，同样能从同一个页面里读到那个 token。

- **诊断日志是整读整写。** `/diag` 会整体重写
  `$DSH_HOME/dsh-terminal-context-diag.json`，只留最近 200 条，单次请求体上限 4 MB。
  并发上报因此可能丢记录。它是调试辅助，不是审计日志。
- **只认内置侧栏终端**（`[data-sidebar-terminal]`）。`dsh-better-sidebar` 的终端页是同一个
  —— v0.19.0 起它把终端交还给了 DSH 原生的 `ui-sidebar-terminal` —— 所以两者都覆盖。
  本插件**不依赖 `dsh-better-sidebar`**，只读 DOM 标记；这也是它能免疫该插件在 v0.21.1
  删掉的那批终端 API 的原因。
- **不是"自动进上下文"** —— 仍然需要你选一下、点一下。DSH 的侧栏终端在设计上就不把输出写进
  agent 的对话记录（`dsh-api-terminal-controller`：*Terminal output stays outside the Agent
  transcript*），所以不存在全自动通路。
- 依赖内部事件 `slash/input-insert-reference`（不随包发布类型声明）。它变了插件会失效——
  症状是按钮点了没反应，诊断日志里有 `[dsh-terminal-context]` 告警。
- **捕获落点与占用**：`<工作区>/.dsh/term-captures/`，自动保留最近 20 份（按文件名时间戳删
  最旧的）。点前缀目录在编辑器文件树、`dir`、`ls` 里默认不显示；实测每份约 0.4–6 KB，
  满额也就几十 KB。手动查看/清理：`Get-ChildItem -Force .dsh\term-captures`。
  若工作区变成 git 仓库，忽略 `.dsh/` 即可。

## 诊断

打包后的桌面客户端**打不开 DevTools**（F12 在源码里有绑定，但那段带"可移除"注释，
打包版实测无效）。所以客户端把状态回传给宿主路由，由宿主追加写入：

```
$DSH_HOME/dsh-terminal-context-diag.json
```

每条带一句 `verdict`，例如 `ok via=highlight chars=542` 或
`no-selection (miss=empty-text, live=0, probe=0, rects=3)`，另附原始阶段快照。
启动类事件只上报一次且不占配额，所以反复的 `client-loaded` 不会把真正需要的那条挤掉。

## 许可证

MIT
