# dsh-terminal-context

在 DSH 内置的右侧栏终端里划选一段输出，再点进当前对话的输入框。「添加到上下文」会出现在输入框上方，靠聊天区右侧，位置固定。点这个按钮，选中的输出会变成输入框里的一个 `@file` 引用。这种引用和手敲 `@文件` 得到的是同一种：可以点开预览，发送时展开成完整内容。

按钮不跟选区走。在这个终端里，高亮层的屏幕坐标不可靠。按选区摆放时，按钮会被推到终端右缘、屏幕外，或压在输入框上。固定位置避开这些情况。

[English](README.md) | 中文

## 怎么用

1. 在侧栏终端里划选输出。
2. 点进输入框。发消息本来就要点这里。划选松开时，浏览器选区经常已经折叠，按钮多半要等这次点击带来的 `selectionchange` 才出现。
3. 点输入框上方的「添加到上下文」。

终端里的灰色高亮还在时，也可以按 **`Ctrl+L`**（macOS 为 `Cmd+L`）。命令 id 是 `dsh-terminal-context.add`，可以在**「设置 → 快捷键」**里改键。

没有可用选区时，这个快捷键不认领 `Ctrl+L`，终端原有的清屏仍然有效。灰色高亮消失之后，快捷键也不会把几分钟前缓存的旧输出送进对话。高亮还在时，插件会接过 `Ctrl+L`，终端不再用这个键清屏。清屏请输入 `clear`。

取消选中、xterm 的灰色高亮消失之后，按钮立刻消失。

## 为什么写成文件

终端输出常常有几百行。把原文直接贴进输入框，提问会被大段输出盖住，每次重发都要再消耗一次 token，而且看不出这段文字来自终端还是手写。

插件把选中文本写成工作区里的文件，再插入 DSH 自己的文件引用：

1. 选中文本写入 `<工作区>/.dsh/term-captures/terminal-<时间戳>.txt`，文件开头有一段来源说明。
2. DSH 把这个文件插成引用。
3. 发送时，引用写成 `@.dsh/term-captures/terminal-….txt`。agent 读取这个文件即可。

输入框里只留引用。引用可以点开预览。插件自动只保留最近 20 份捕获。

写入前，插件会去掉每行行尾的空白，以及整段文本开头和结尾的空行。xterm 会把每一行用空格补到终端宽度，原样保存会带上几百个看不见的空格。屏幕上能看见的文字保持不变。

## 安装

DSH 没有官方插件商店。npm 包、git 仓库和 tarball 都可以用应用自带的插件管理器安装。

**从 GitHub 安装。** 仓库里已经放了构建好的客户端 bundle，不需要构建，也不会要求 `allowBuilds` 授权：

```sh
dsh plugin --profile web add github:ZHOU-ZHIZHEN/dsh-terminal-context
```

**从 npm 安装。** 包发布到 npm 之后再用。现在仓库只在 GitHub 上，下面这条命令还不能用：

```sh
dsh plugin --profile web add dsh-terminal-context
```

**从 tarball 安装。** 在本目录执行 `pnpm pack`，然后：

```sh
dsh plugin --profile web add ./dsh-terminal-context-0.1.0.tgz
```

**安装到桌面版。** `desktop` profile 由 Electron 应用独占。CLI 会拒绝，并提示 `profile "desktop" is managed exclusively by the Electron application`。请用应用自己的入口：左侧栏「插件」→ 添加插件，填入本目录的绝对路径，然后重启。

「设置 → 内置插件」是只读的库存列表。安装入口在侧栏。

## 引用是怎么插进去的

输入框里插入文件引用，正规入口只有会话作用域事件 `slash/input-insert-reference`。事件里的 `span` 必须带上当前的 `draftRev`，宿主用修订号做比较并交换。`reference.source` 必须是内核认得的源名。这两项有一项不对，消息就发不出去。

`span` 来自 `inputActions.captureInsertion()`。这是插槽组件的标准 props。直接 `apply(ctx)` 不一定能走到 `conversation.input.for(scope)`。插件按下面的顺序试三条路：

1. **插槽桥。** 向已经声明的列表插槽 `conversation.input.dock` 注册一个无界面组件。内核自带的 `todo` 和 `queue` 也注册在这个插槽。插槽组件一定能拿到 `inputActions`。插件把当前会话的 `captureInsertion` 和 `insertText` 记下来。
2. **服务直连。** 调用 `ctx.get('conversation').input.for(scope)`。
3. **纯文本。** 把 `@路径` 当作普通文本送出。DSH 仍会把它显示成文件夹引用。

插件会检查 `bail()` 的返回值。宿主的 `insertReference` 会核对修订号和输入阶段。返回 `false` 表示这次插入被拒绝，插件改走下一条路。

任何一条路失败，插件只打一条 `[dsh-terminal-context]` 警告。界面继续可用。

### 选区文本怎么读

| 路径 | 何时使用 | 精度 |
|---|---|---|
| xterm 原生选区 | 浏览器选区还能读出文字时 | 与选中范围一致 |
| 高亮层还原 | 浏览器选区已经折叠时 | 按整行取，多取不丢 |

鼠标松开时，浏览器选区经常已经是 `collapsed: true`，矩形数量为 0。这时 `window.getSelection().toString()` 和合成的 `copy` 事件都是空的。xterm 的灰色高亮还在，那是 xterm 自己画的一层。插件读取 `.xterm-selection` 里绝对定位的高亮矩形，判断覆盖了哪些行，再取这些行的整行文本。

边界上的行可能多带一两行。早期版本按像素宽度把末行裁到字符列，实测会切掉要保留的文本，例如把 `ls -la` 的末行切成半个词，并丢掉末尾若干行。多出来的行可以删。少掉的行要重新选。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/client.js` | 浏览器半，构建产物格式（`window.__ModuleLoader__.load`）：选区监听、输入框上方的按钮、快捷键、插槽桥、引用 |
| `lib/index.js` | 宿主半（Node）：HTTP 路由（`capture` / `sweep` / `diag`）和工作区 realpath 限制 |
| `cordis.patch.yml` | bundle 层，把本插件的行插进 profile |
| `test-host.mjs` | 宿主半离线验证（假 ctx、假请求和响应） |
| `test-client.mjs` | 客户端半离线验证（假模块表、假 DOM） |

## 验证

在本目录执行：

```sh
node test-host.mjs lib/index.js     # 路由、落盘、错误分支、保留清理
node test-client.mjs lib/client.js  # bundle 契约、启动、完整点击链路
```

## 已知边界

- **按钮固定在输入框上方。** 高亮矩形、行坐标和鼠标位置都试过，在这个终端里会把按钮推到终端右缘、屏幕外，或压在输入框上。划选完成的那一拍经常读不到文本，按钮多半在点进输入框时才出现。
- **三条 HTTP 路由不校验调用方。** `/capture`、`/sweep`、`/diag` 注册在 DSH 自带的 `webServer` 上。插件不检查请求来自谁。能连上这个端口的程序，可以向某个会话的工作区写入捕获文件（agent 随后可能读到它）、触发一次保留清理，或追加诊断记录。在本机用 Node 脚本发一个不带凭据的 `fetch`，处理函数会返回 `405`，而不是 `401`。

  这个端口能否被应用自己的页面之外访问，由 DSH 决定。这台机器上没有单独的 `webServer` 实现可以核对。请把 DSH 的 Web 端口绑在回环地址上，不要暴露到局域网或公网。在插件里另做一套 token 并不能补上这道检查：能打到这条路由的页面，也能读到同一个页面里的 token。

- **诊断日志按整份文件重写。** `/diag` 会重写 `$DSH_HOME/dsh-terminal-context-diag.json`，只留最近 200 条。单次请求体上限是 4 MB。并发上报可能丢掉记录。这份文件用来排查问题，不作为审计日志。
- **只认内置侧栏终端**（`[data-sidebar-terminal]`）。`dsh-better-sidebar` 从 v0.19.0 起把终端交还给 DSH 原生的 `ui-sidebar-terminal`，所以那个终端页也在范围内。本插件不依赖 `dsh-better-sidebar`，只读 DOM 标记。该插件在 v0.21.1 删掉的终端 API，因此不影响本插件。
- **输出不会自动进入对话。** 使用时仍要划选，再点按钮或按快捷键。DSH 的侧栏终端不把输出写入 agent 的对话记录（`dsh-api-terminal-controller`：*Terminal output stays outside the Agent transcript*）。
- 插件依赖内部事件 `slash/input-insert-reference`。这个事件没有随包发布类型声明。事件形状变了之后，按钮点了没有反应，诊断日志里会出现 `[dsh-terminal-context]` 警告。
- **捕获文件在** `<工作区>/.dsh/term-captures/`。插件按文件名里的时间戳删除最旧的，只留最近 20 份。这个点开头的目录在编辑器文件树、`dir` 和 `ls` 里默认不显示。实测每份约 0.4–6 KB，20 份一共几十 KB。手动查看或清理：`Get-ChildItem -Force .dsh\term-captures`。工作区若是 git 仓库，把 `.dsh/` 写进忽略列表即可。

## 诊断

打包后的桌面客户端打不开 DevTools。源码里有 F12 的绑定，但那段带有「可移除」注释，打包版里不生效。客户端把状态发给宿主的 `/diag` 路由，由宿主追加写入：

```
$DSH_HOME/dsh-terminal-context-diag.json
```

每条记录有一句 `verdict`，例如 `ok via=highlight chars=542`，或 `no-selection (miss=empty-text, live=0, probe=0, rects=3)`，并附上当时的阶段快照。`client-loaded` 这类启动事件每种只上报一次，也不占用配额，所以重复启动不会把后面真正要看的记录挤掉。

## 许可证

MIT
