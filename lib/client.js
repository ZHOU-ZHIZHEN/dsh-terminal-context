window.__ModuleLoader__.load({
  id: 'dsh-terminal-context',
  factory(require) {
    /**
     * dsh-terminal-context — 浏览器侧（DSH 客户端插件）
     *
     * 交互：
     *   在右侧栏内置终端里划选文本，再点进当前对话的输入框。
     *   「添加到上下文」固定出现在输入框上方（不跟选区走）。
     *   点一下后把选中文本写成工作区里的一个录制文件，再用 DSH 原生的
     *     `@file` 引用（结构化 chip）插入输入框。
     *   取消选中、xterm 高亮层清空之后，按钮立刻消失。
     *
     * 为什么落文件而不是直接塞文本：终端输出动辄几百行，纯文本会灌满输入框；
     * 而文件引用是 DSH 原生机制——带来源、可点击预览、我（agent）能直接读取。
     *
     * 本文件是**构建产物格式**（不是源码）：DSH 要求 lib/client.js 必须是
     * `window.__ModuleLoader__.load({ id, factory })` 形态，且 id 必须与包名一致。
     * 依赖一律通过 factory 的 require 从宿主模块表解析，不自行打包。
     *
     * 已核对的宿主接口（DSH Desktop 0.2.0-rc.2 的 app.asar）：
     *   - section[data-sidebar-terminal] / .xterm   侧栏终端容器与其 xterm 根
     *   - [data-composer-input]                     输入框（Lexical contenteditable）
     *   - [data-conversation-session]               会话 id 所在的 DOM 标记
     *   - ctx.sessions.scope(id)                    会话作用域 Context
     *   - conversation.input.for(scope).actions.captureInsertion()
     *                                               当前光标/选区 span + draftRev
     *   - scope.emit('slash/input-insert-reference', { reference, span })
     *                                               结构化引用 chip（原生 @ 选择器同款）
     */
    const PLUGIN_ID = 'dsh-terminal-context'
    /** 诊断用版本标记：控制台日志带上它，便于确认加载的是哪一版。 */
    const PLUGIN_VERSION = '0.1.0'

    /** 侧栏终端容器（DSH 内置 ui-sidebar-terminal）。 */
    const TERMINAL_SELECTOR = '[data-sidebar-terminal]'
    /** 终端里的 xterm 根节点；选区必须落在它内部才算数。 */
    const XTERM_SELECTOR = '.xterm'
    /** 输入框（Lexical 富文本，不是 textarea）。 */
    const COMPOSER_SELECTOR = '[data-composer-input]'
    /** 会话标记：其 dataset.conversationSession 即当前会话 id。 */
    const SESSION_SELECTOR = '[data-conversation-session]'
    /** 单次捕获的字符上限（与宿主半的 MAX_TEXT_CHARS 对齐）。 */
    const MAX_SELECTION_CHARS = 200000
    /** 按钮相对选区的偏移（px）。 */
    const BUTTON_OFFSET = 10

    /**
     * 最近一次「可用选区」的登记表：终端元素 → { text, truncated, at }。
     *
     * 为什么不直接读 DOM：xterm 的选区随时会被清掉——点击按钮、以及快捷键触发
     * 的那一刻，选区往往已经不在了。所以每当检测到有效选区就顺手记一份，
     * 快捷键触发时直接取。按终端元素分键，多开终端时各自独立。
     */
    const lastSelections = new Map()
    /** 登记的有效期：过期选区不再被快捷键使用（避免误用很久以前选中的东西）。 */
    const SELECTION_TTL_MS = 30 * 60 * 1000

    /** 上一次选区检测失败在哪一步（诊断用；null = 最近一次是成功的）。 */
    let selectionMiss = null
    /** 上一次选区检测的阶段快照（诊断用）。 */
    let selectionStage = null
    /** 上一次已上报的选区签名（诊断去重用）。 */
    let lastSelectionDiag = null
    /** 上一次按钮落点快照（诊断用；见 `placeButton`）。 */
    let lastPlacement = null
    /** 上一次 `selectionPoint` 的逐级测量原始值（诊断用）。 */
    let lastPointTrace = null
    /**
     * 最近一次**终端内** `mouseup` 的时刻。
     *
     * 用途：`selectionchange` 会紧随 `mouseup` 到达且**不带事件**，此时 DOM 选区常已折叠、
     * 什么都读不出来。若那一刻就把按钮藏掉，用户看到的就是"我明明选中了，按钮却没出现"
     * —— 而它往往要等到用户去点聊天框（一次非空的 `selectionchange`）才冒出来。
     * 这个时间戳让紧随其后的那次通知走宽限期，不藏按钮。
     */
    let lastMouseupAt = 0
    /** `mouseup` 之后的宽限期（毫秒）。 */
    const MOUSEUP_GRACE_MS = 700
    /**
     * 仅供离线测试：把"刚松开鼠标"的时刻清零，用来绕过宽限期。
     * 真实运行不会调用它 —— 宽限期就是**要**在这段时间里不藏按钮。
     */
    function __resetMouseupGrace() {
      lastMouseupAt = 0
    }

    /**
     * xterm 复制探针缓存：终端元素 → { text, at }。
     *
     * 为什么需要它：xterm 在多行选择后会把 DOM 选区退化到 `.xterm-helpers`
     * （accessibility 层），那里没有可读文本节点，`window.getSelection().toString()`
     * 返回空串——实测就是"划选读不出文本，只有最早那次点击选中还能用"。
     * 但 xterm **自己**始终知道选了什么：它把选中文本写进 `copy` 事件的
     * clipboardData。所以我们在划选时就派发一个合成 `copy` 事件，把它交出来的
     * 文本截获缓存（不阻止默认行为，xterm 该写剪贴板照写）。
     * 这条手法来自 `dsh-better-sidebar-terminal-plus`：它的复制按钮同样是
     * "向 .xterm 派发合成 copy 探针，读取 xterm 内部选择，不经过 PTY"。
     */
    const copyProbeText = new Map()
    /** copy 探针结果的有效期（过了就不再被快捷键使用）。 */
    const PROBE_TTL_MS = 5 * 60 * 1000
    /**
     * 登记表兜底留住按钮的**新鲜度窗口**。
     *
     * `selectionchange` 不带鼠标事件，所以不能靠"这次鼠标在不在终端里"来判断
     * "用户是否还在看这段选区"。改成看时间：刚划选完的那几秒内，读不到选区
     * （常态）就用登记表把按钮留住；超过这个窗口，说明用户已经在做别的事，
     * 不该再拿旧选区弹按钮。
     */
    const FALLBACK_FRESH_MS = 4000

    function apply(ctx) {
      if (typeof document === 'undefined') return

      installStyles()

      let button = null
      /** 最近一次有效选区：DOM Selection 会被后续点击清掉，所以先存下来。 */
      let pending = null

      /**
       * 保底通路。`conversation.input` 在部分版本上是「作用域内」的提供面
       * （只在 conversation 插槽里渲染的组件能拿到），裸 `apply(ctx)` 未必
       * 够得着。所以额外注册一个**无界面组件**到已声明的
       * `conversation.input.dock`（kind: "list"，可多方注册；官方自带的
       * todo / queue 两个条目也注册在此），它作为插槽组件必定拿到标准 props
       * `inputActions`，把当前会话的 `captureInsertion` / `insertText` 记到桥里。
       *
       * 两条通路都存在时优先用桥（它天然属于当前会话）；桥拿不到就退回
       * 直接解析 conversation 服务。
       *
       * `slots` 用 `ctx.get()` 读取而不是写进 `inject`：少一个模块顶层依赖，
       * 更不容易因为客户端模块表差异而加载失败（服务的可选性由代码里的
       * 判断兜住）。
       */
      const bridge = { sessionId: null, actions: null }

      // 诊断线索：浏览器控制台里搜 `[dsh-terminal-context]` 就能看到插件走到哪一步。
      // 若这条日志都没有，说明客户端 bundle 根本没被加载（不是插件内部的问题）。
      console.log(`[${PLUGIN_ID}] v${PLUGIN_VERSION} 客户端已加载`)

      ctx.effect(() => {
        try {
          const slots = ctx.get('slots')
          if (slots === undefined || typeof slots.inject !== 'function') {
            console.warn(`[${PLUGIN_ID}] slots 服务不可用，将只用 conversation 服务通路`)
            return () => {}
          }
          const off = slots.inject('conversation.input.dock', () =>
            slots.register(
              {
                name: 'conversation.input.dock',
                id: PLUGIN_ID,
                order: 90,
                // 官方写法：把会话 id 注入到组件 props，保证拿到的是当前会话。
                inject: (sessionId) => ({ sessionId }),
              },
              makeBridgeComponent(bridge, currentSessionId),
            ),
          )
          console.log(`[${PLUGIN_ID}] 已注册 conversation.input.dock 桥组件`)
          return () => off?.()
        } catch (error) {
          // 插槽不可用不影响主通路：按钮与捕获仍然工作。
          console.warn(`[${PLUGIN_ID}] 桥接插槽注册失败（将只用 conversation 服务）：`, error)
          return () => {}
        }
      })

      ctx.effect(() => {
        const removeButton = mountButton()

        // 诊断样本簿：客户端把关键状态回传宿主，便于在没有 DevTools 的桌面端定位问题。
        const diag = createDiagReporter()
        void diag('client-loaded', {
          hasSelectionApi: typeof window.getSelection === 'function',
          terminalsInDom: document.querySelectorAll(TERMINAL_SELECTOR).length,
          xtermsInDom: document.querySelectorAll(XTERM_SELECTOR).length,
          composerInDom: document.querySelector(COMPOSER_SELECTOR) !== null,
        })

        /**
         * 读不到选区时，判断能否用登记表里的文本把按钮留住；能就返回那个选区。
         *
         * **为什么不能只认 `mouseup` 事件**：浏览器在选区折叠时会发
         * `selectionchange`，而它**不带鼠标事件**。若只在 `mouseup` 那条路上允许兜底，
         * 这个紧随其后的 `selectionchange` 仍会把按钮藏掉 —— 于是"选中 → 按钮出现
         * → 一松手就消失"。在终端外真正点一下也一样：先到的是 `selectionchange`，
         * 按钮在 `mouseup` 之前就已经没了。
         *
         * 所以判定改成两件事：
         *   1. **新鲜度**：登记时间在 `FALLBACK_FRESH_MS` 内。这条替代了原先的
         *      "鼠标必须在终端里"——在页面别处点一下时，刚才那段选区已经过期，不会
         *      拿陈旧内容弹按钮。
         *   2. **终端仍在 DOM 里**：否则它已被关掉，谈不上"留住"。
         *
         * 有鼠标事件时再叠一道：若这次松开明确落在终端**之外**，一律不兜底
         * （这是最直白的"用户在看别处"信号）。
         *
         * @param {Event|null} mouseupEvent
         * @returns {{ selection: object, element: Element } | null} 选区连同它的终端。
         *   终端用来确认这条登记还连在页面上；按钮位置不读它。
         */
        function fallbackRememberedSelection(mouseupEvent) {
          if (mouseupEvent !== null) {
            let inTerminal = false
            try {
              inTerminal = mouseupEvent.target?.closest?.(TERMINAL_SELECTOR) != null
            } catch {
              inTerminal = false
            }
            if (!inTerminal) return null
          }
          const remembered = newestSelection()
          if (remembered === null) return null
          if (Date.now() - remembered.at > FALLBACK_FRESH_MS) return null
          if (remembered.element?.isConnected !== true) return null
          // 连终端一起返回：调用方用来确认登记还连在页面上。按钮位置不读这个元素。
          return { selection: remembered.selection, element: remembered.element }
        }

        /**
         * 选区变化 / 鼠标松开时的统一处理。
         *
         * @param {Event|null} mouseupEvent 鼠标松开时传入。读不到选区时**不要**急着藏按钮，
         *   因为这一刻读失败是常态（选区已折叠），而登记表/探针里可能仍有可用文本。
         *   `selectionchange` 不带事件（浏览器就是这么发的），所以那条路上**同样**要允许
         *   兜底 —— 详见 `fallbackRememberedSelection`。
         */
        const onSelectionChange = (mouseupEvent = null) => {
          let next = null
          let failure = null
          try {
            next = readTerminalSelection()
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error)
          }
          pending = next
          if (next === null) {
            // 曾经这里无条件 `hideButton()`：于是"高亮还原和复制探针都失败"时，
            // 按钮在鼠标松开那一下就消失，登记表里的文本**只有快捷键能用**，
            // 用户看到的是"我明明选中了，按钮却不见了"。
            //
            // 但也不能无条件兜底：**用户取消选中时高亮层会空掉**，而复制探针的缓存
            // 有 5 分钟有效期，于是按钮一直留着 —— 表现是"取消选定后还得再点一次
            // 聊天框才会取消"（真发生过）。
            // 所以判据是**高亮层里还有东西吗**：
            //   · 有 → 用户确实选着文本，只是这一拍读不出来 → 兜底留住按钮
            //   · 没有 → 用户已经取消选中（或压根没选）→ 藏按钮并清掉陈旧探针
            const selectionVisible = anyTerminalHasHighlight()
            const fallbackInfo = selectionVisible ? fallbackRememberedSelection(mouseupEvent) : null
            const fallback = fallbackInfo?.selection ?? null
            if (fallback !== null) {
              selectionMiss = null
              pending = fallback
              placeButton(fallback)
              void diag('button-kept-fallback', {
                verdict: `kept visible via=${fallback.via} chars=${fallback.text.length}`,
                via: fallback.via,
                chars: fallback.text.length,
                fromMouseup: mouseupEvent !== null,
              })
            } else if (selectionVisible && Date.now() - lastMouseupAt <= MOUSEUP_GRACE_MS) {
              // 刚在终端里松开鼠标，高亮还在但这一拍读不出来（DOM 已折叠、探针也没拿到）。
              // **不要藏按钮**：浏览器随后还会补一次 `selectionchange`，那次往往能读出
              // 内容并把按钮放好。过早藏掉正是"选中了却没显示"的直接原因。
              void diag('button-kept-grace', {
                verdict: `kept visible: within ${MOUSEUP_GRACE_MS}ms of mouseup`,
                msSinceMouseup: Date.now() - lastMouseupAt,
              })
            } else {
              hideButton()
              // 高亮层已空 = 用户取消选中（或从来没选）。此时**必须**把复制探针的缓存
              // 一并丢掉：它的有效期是 5 分钟，留着会继续被兜底逻辑当成"还有选区"，
              // 于是按钮再也藏不掉 —— 只能靠点别处触发事件（真发生过）。
              if (!selectionVisible) {
                copyProbeText.clear()
                lastSelections.clear()
              }
            }
            // 注意：这条**必须**在 return 之前。
            // 曾经写在后面，而 `failure !== null` 恰恰只伴随 `next === null`，
            // 于是它永远执行不到 —— 读选区抛错时反而没有任何记录。
            if (failure !== null) void diag('selection-threw', { message: failure })
            return
          }
          rememberSelection(next)
          placeButton(next)
          // 去重：`selectionchange` 在拖选过程中会高频触发，若每次都上报，
          // 一次拖选就能把配额打光，导致"松开鼠标"那条结论反而报不上去。
          // 只有选区真正变化（长度或落点变了）才上报。
          // 注意 `point` 可能是 null（高亮还原路径不给落点），所以不能直接解引用。
          const px = Number.isFinite(next.point?.clientX) ? Math.round(next.point.clientX) : '-'
          const py = Number.isFinite(next.point?.clientY) ? Math.round(next.point.clientY) : '-'
          const signature = `${next.text.length}@${px},${py}`
          if (signature !== lastSelectionDiag) {
            lastSelectionDiag = signature
            void diag('selection-ok', {
              chars: next.text.length,
              lines: next.text.split('\n').length,
              via: next.via,
            })
          }
        }

        const onMouseUp = (event) => {
          // 这次松开鼠标是否发生在终端里。页面别处的 `mouseup` 与本插件无关，
          // 既不该占诊断配额，也不该动按钮。
          let inTerminal = false
          try {
            inTerminal = event?.target?.closest?.(TERMINAL_SELECTOR) != null
          } catch {
            inTerminal = false
          }
          // 记下"刚松开"的时刻：`selectionchange` 会紧随其后到达，而它**不带事件**。
          // 没有这个时间戳时，那次紧随的 `selectionchange` 会把刚显示出来的按钮藏掉
          // （见 `handleSelectionChange` 里的宽限期）。只认终端里的松开。
          if (inTerminal) lastMouseupAt = Date.now()

          // **顺序很关键：先探针，再判定。**
          // xterm 自己始终知道选了什么（它把选中文本写进 `copy` 事件的 clipboardData），
          // 而 DOM 选区在松开这一拍常常已经折叠 —— 但探针能问出真实内容。
          // 早先是"先判定、失败后才探针"，于是这一拍的判定必然失败、按钮挂到
          // `hideButton()`，只能等下一次事件（实测是**用户去点聊天框**带来的那次
          // 非空 `selectionchange`）才把按钮弹出来。
          if (inTerminal && safeSelectionChars() === 0) probeTerminalCopy()

          // 选区丢失前先读一次：终端外的 mouseup 不该覆盖 `pending`/按钮状态。
          // 此刻登记表/探针里已经有真实内容，兜底就能立刻把按钮放对位置。
          if (inTerminal) onSelectionChange(event)
          // 只在终端里松开时上报结论。曾经无条件挂在文档的每一次 mouseup 上：
          // 页面别处的每次松开都会占掉保留配额，终端里那条最该留下的反而不上报。
          //
          // 注意判据必须是"**这次鼠标在不在终端里**"，而不是 `selectionMiss`：
          // 一旦上次读失败，`selectionMiss` 会一直留着失败原因（它只在成功时被清），
          // 于是"终端外松开"在 `selectionMiss !== null` 时反而会被上报。
          if (!inTerminal) return
          const live = safeSelectionChars()
          void diag('mouseup-sample', {
            // 一句话结论：划完那一刻插件认出了什么。
            verdict:
              selectionMiss === null
                ? `ok via=${pending?.via ?? '?'} chars=${pending?.text?.length ?? 0}`
                : `miss=${selectionMiss} (live=${live}, probe=${newestProbeChars()}, rects=${selectionStage?.highlightRects ?? 'n/a'})`,
            inTerminal,
            miss: selectionMiss,
            stage: selectionStage,
            registered: lastSelections.size,
            liveChars: live,
            probeChars: newestProbeChars(),
            // 按钮落点：`anchor` 是算出来的目标点，`applied` 是夹取后真正写进 style 的值。
            // 两者相差过大（或落在视口外）就是"按钮没出现"的直接原因。
            placement: lastPlacement,
            pointTrace: lastPointTrace,
            buttonDisplay: button?.style?.display ?? null,
          })
        }

        /**
         * 合成 `copy` 事件向终端要一次选中文本。
         * 不 `preventDefault`：让 xterm 原本的复制行为照常发生，我们只是旁听。
         */
        const onDocumentCopy = (event) => {
          try {
            const target = event.target
            const terminal = target?.closest?.(TERMINAL_SELECTOR) ?? null
            if (terminal === null) return
            const text = normalize(String(event.clipboardData?.getData('text/plain') ?? ''))
            if (text === '') return
            copyProbeText.set(terminal, { text, at: Date.now() })
            // 探针拿到了：登记成一次有效选区，并显示按钮。
            // 按钮位置由 placeButton 固定在输入框上方，不使用这里的 point。
            const remembered = {
              text: text.slice(0, MAX_SELECTION_CHARS),
              truncated: text.length > MAX_SELECTION_CHARS,
              via: 'xterm-copy',
              terminal,
              point: selectionPoint(terminal),
            }
            rememberSelection(remembered)
            pending = remembered
            placeButton(remembered)
          } catch {
            // 旁听失败不影响任何功能。
          }
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') hideButton()
        }

        document.addEventListener('selectionchange', onSelectionChange)
        document.addEventListener('mouseup', onMouseUp, true)
        document.addEventListener('copy', onDocumentCopy, true)
        window.addEventListener('scroll', hideButton, true)
        window.addEventListener('resize', hideButton)
        window.addEventListener('keydown', onKeyDown)
        void sweepCaptures(ctx)

        return () => {
          document.removeEventListener('selectionchange', onSelectionChange)
          document.removeEventListener('mouseup', onMouseUp, true)
          document.removeEventListener('copy', onDocumentCopy, true)
          window.removeEventListener('scroll', hideButton, true)
          window.removeEventListener('resize', hideButton)
          window.removeEventListener('keydown', onKeyDown)
          hideButton()
          removeButton()
        }
      })

      /**
       * 键盘快捷键：选中终端文本后不用去点按钮，直接按快捷键即可加入上下文。
       *
       * 默认键位是 `primary + KeyL`（Windows/Linux 上即 Ctrl+L，macOS 上 Cmd+L）。
       * 注意 Ctrl+L 在终端里传统上是"清屏"（readline 的 form feed），但 DSH 的
       * 快捷键绑定优先级高于终端本身，所以会被我们接管——这也意味着它不再清屏，
       * 需要清屏请用 `clear`。它是可重新绑定的普通命令，会出现在
       * 「设置 → 快捷键」对话框里，觉得冲突可以改。
       */
      ctx.effect(() => {
        const diag = createDiagReporter()
        try {
          const shortcuts = ctx.get('shortcuts')
          if (shortcuts === undefined || typeof shortcuts.register !== 'function') {
            console.warn(`[${PLUGIN_ID}] shortcuts 服务不可用，快捷键未注册（按钮仍可用）`)
            void diag('shortcut-unavailable', {
              hasService: shortcuts !== undefined,
              hasRegister: typeof shortcuts?.register,
              serviceKeys: shortcuts !== undefined && shortcuts !== null
                ? Object.keys(shortcuts).slice(0, 24)
                : null,
            })
            return () => {}
          }
          const binding = () => ({ code: 'KeyL', modifiers: ['primary'] })
          const off = shortcuts.register({
            id: `${PLUGIN_ID}.add`,
            label: () => '把选中的终端输出添加到上下文',
            aliases: ['add terminal selection', 'terminal context'],
            defaults: {
              'desktop:macos': binding(),
              'desktop:windows': binding(),
              'desktop:linux': binding(),
              'web:macos': { code: 'KeyL', modifiers: ['primary', 'alt'] },
              'web:windows': { code: 'KeyL', modifiers: ['primary', 'alt'] },
              // 刻意**不声明** `web:linux`（省略 = 该平台不绑定）。
              //
              // 内核的 `register()` 是**原子**的：它遍历全部 6 个 runtime×platform，
              // 任一条默认键位不合法就整条命令注册失败（`Unsupported Web shortcut`），
              // 按键于是落回终端手里 —— 表现就是"Ctrl+L 又开始清屏"（真踩过一次）。
              //
              // 而 `isWebBindingAllowed` 只对 windows/macos 放行"primary + alt/shift"
              // 这类两键组合；**linux 会落到一份硬编码白名单**
              // （Slash+primary、Comma+shift、Period+shift），`KeyL` 怎么组合都过不去。
              // 所以这个平台只能空着 —— 别为了"补齐六个"而让整条命令消失。
            },
            regions: ['page', 'editable'],
            modals: [],
            resolve: () => {
              // 只有在"确实有可用选区"时才认领这个键，否则让给别人。
              //
              // 注意状态字面量：内核的判定链是 `pass` → `blocked` → 其余一律
              // 视为已认领并调用 `run()`。所以"不认领"必须返回 **`pass`**
              // （不是 ignored/undefined——那些会走到 `resolution.run()`，
              // 而对象里没有 run，于是在击键路径里抛异常且被吞掉，
              // 表现就是"按了完全没反应"）。
              // 三条兜底路统一在 resolveUsableSelection 里（按钮也走同一条，
              // 见下方说明：按钮曾经只认 `pending`，而 mouseup 会先把它清掉）。
              const target = resolveUsableSelection(diag)
              const fromRegistry = target?.selection?.via === 'remembered'
              // 诊断：把三条兜底路的可用情况都报出来，便于判断死在哪一环
              let liveChars = 0
              try {
                liveChars = window.getSelection()?.toString()?.trim()?.length ?? 0
              } catch {
                liveChars = -1
              }
              void diag('shortcut-resolve', {
                // 一句话结论：成功了是哪条路救的，失败了是死在哪一环。
                verdict:
                  target === null
                    ? `no-selection (miss=${selectionMiss ?? 'none'}, live=${liveChars}, probe=${newestProbeChars()})`
                    : `ok via=${target.selection.via}`,
                status: target === null ? 'pass' : 'handled',
                via: target?.selection?.via ?? null,
                registered: lastSelections.size,
                fromRegistry,
                liveChars,
                probeChars: newestProbeChars(),
                stage: selectionStage,
              })
              if (target === null) return { status: 'pass' }
              return {
                status: 'handled',
                run: () => {
                  void diag('shortcut-run', { chars: target.selection.text.length })
                  pending = target.selection
                  void addToContext(ctx, () => pending, () => {
                    pending = null
                    hideButton()
                  }, () => bridge)
                  return true
                },
              }
            },
          })
          console.log(`[${PLUGIN_ID}] 已注册快捷键 ${PLUGIN_ID}.add（默认 primary+KeyL）`)
          void diag('shortcut-registered', {
            id: `${PLUGIN_ID}.add`,
            disposeType: typeof off,
          })
          return () => off?.()
        } catch (error) {
          console.warn(`[${PLUGIN_ID}] 快捷键注册失败（按钮仍可用）：`, error)
          void diag('shortcut-register-failed', {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? String(error.stack).slice(0, 400) : null,
          })
          return () => {}
        }
      })

      // ── 插槽桥（保底通路）────────────────────────────────────────────────

    /**
     * 造一个无界面的插槽组件：它唯一的作用是把标准 props 里的
     * `inputActions` 记到 `bridge` 上。返回 null 让 React 什么都不渲染。
     *
     * 每次渲染都刷新 `bridge`，所以会话切换、动作对象换代都会自动跟上。
     */
    function makeBridgeComponent(bridge, readSessionId) {
      return function TerminalContextBridge(props) {
        try {
          const sessionId = props?.sessionId ?? readSessionId()
          const candidate = props?.inputActions
          if (
            sessionId !== undefined &&
            candidate !== null &&
            typeof candidate === 'object' &&
            typeof candidate.captureInsertion === 'function' &&
            typeof candidate.insertText === 'function'
          ) {
            if (bridge.actions === null) {
              console.log(`[${PLUGIN_ID}] 桥组件已挂载，拿到 inputActions（会话 ${sessionId}）`)
            }
            bridge.sessionId = sessionId
            bridge.actions = candidate
          }
        } catch {
          // 桥只是保底：任何异常都不该影响渲染。
        }
        return null
      }
    }

    /** 当前会话 id（DOM 标记；插件不依赖 React 上下文）。 */
    function currentSessionId() {
      return document.querySelector(SESSION_SELECTOR)?.dataset.conversationSession
    }

    // ── 浮动按钮 ────────────────────────────────────────────────────────
      function mountButton() {
        button = document.createElement('button')
        button.type = 'button'
        button.className = 'dsh-tc-btn'
        button.textContent = '添加到上下文'
        button.title = '把选中的终端输出作为引用加入当前对话'
        button.setAttribute('aria-label', '把选中的终端输出添加到对话上下文')
        button.style.display = 'none'
        // 按下时阻止默认行为，避免点按钮把终端选区清掉。
        button.addEventListener('mousedown', (event) => {
          event.preventDefault()
          event.stopPropagation()
        })
        button.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          // 注意：不能只读 `pending`。`mouseup` 监听注册在捕获阶段，会先于这次 click
          // 把 `pending` 置 null（那一刻选区常已折叠）并隐藏按钮，于是 click 拿到空值
          // 直接返回 —— 表现就是"点了没反应"。所以按钮走与快捷键**同一条**三条兜底链。
          const target = resolveUsableSelection()
          pending = target?.selection ?? null
          void addToContext(ctx, () => pending, () => {
            pending = null
            hideButton()
          }, () => bridge)
        })
        document.body.appendChild(button)
        return () => {
          button?.remove()
          button = null
        }
      }

      function hideButton() {
        if (button !== null) button.style.display = 'none'
      }

      /**
       * 显示按钮，并把它停在输入框上方、靠聊天区右侧。
       *
       * 不跟选区走。高亮矩形包围盒、高亮相对坐标加行容器原点、行元素矩形、鼠标位置、
       * 高亮层自身的矩形都试过：这个终端里 `.xterm-selection` 的子元素按行绝对定位，
       * 容器高度是 0，按行换算又会把按钮推到终端右缘、屏幕外，或压在输入框上。
       * 找不到输入框时，改贴视口右下，并抬高一截，避开底部工具栏。
       *
       * @param {{ via?: string } | null | undefined} selection 只用于诊断里的 `via`。
       */
      function placeButton(selection) {
        if (button === null) return
        button.style.display = 'block'
        // 先归零再测量，避免上一次尺寸影响本次夹取。
        button.style.left = '0px'
        button.style.top = '0px'
        const rect = button.getBoundingClientRect()
        // 固定落点：紧贴输入框上方，与聊天区右缘对齐。原因见函数注释。
        const composer = safeRect(() => document.querySelector(COMPOSER_SELECTOR)?.getBoundingClientRect())
        let anchor
        if (composer !== null && Number.isFinite(composer.right) && composer.top > rect.height + 8) {
          anchor = {
            clientX: composer.right - rect.width - 8,
            clientY: composer.top - rect.height - 10,
            source: 'composer-dock',
          }
        } else {
          // 找不到输入框（极少）：贴视口右下，但抬高到不至于压住底部工具栏。
          anchor = {
            clientX: window.innerWidth - rect.width - 24,
            clientY: window.innerHeight - rect.height - 96,
            source: 'viewport-dock',
          }
        }
        const left = clamp(anchor.clientX, 4, window.innerWidth - rect.width - 4)
        const top = clamp(anchor.clientY, 4, window.innerHeight - rect.height - 4)
        button.style.left = `${left}px`
        button.style.top = `${top}px`
        // 落点快照，随诊断一起上报（供 `mouseup-sample` 读出）。
        lastPlacement = {
          anchor: { x: Math.round(anchor.clientX), y: Math.round(anchor.clientY) },
          applied: { x: Math.round(left), y: Math.round(top) },
          source: anchor.source,
          composer: composer === null ? null : { right: Math.round(composer.right), top: Math.round(composer.top) },
          viewport: { w: window.innerWidth, h: window.innerHeight },
          via: selection?.via ?? null,
        }
      }
    }

    // ── 选区读取 ──────────────────────────────────────────────────────────

    /**
     * 页面上**还有终端画着高亮**吗？
     *
     * 这是"用户当前是否真的选着文本"最可靠的信号：
     *   · 选中时 xterm 会往 `.xterm-selection` 里放若干按行定位的 div；
     *   · 取消选中（点别处、按 Esc、重新点击）时这些 div 会**消失**。
     *
     * 而"读不读得到文本"不是可靠信号 —— 鼠标松开后 DOM 选区常已折叠，
     * 此时高亮还在、文本读不出来。两者的区别正是"兜底该不该留按钮"的判据。
     *
     * @returns {boolean}
     */
    function anyTerminalHasHighlight() {
      try {
        for (const terminal of document.querySelectorAll(TERMINAL_SELECTOR)) {
          if (collectHighlightRects(terminal).length > 0) return true
        }
      } catch {
        // 读不到就当没有 —— 宁可少留按钮，也不要让它赖着不走。
      }
      return false
    }

    /**
     * 现测一次"选区落点"，按两个来源依次尝试：
     *
     *   1. **DOM 选区的矩形** —— 浏览器自己算的，最可信（`getRangeAt(0)` 或
     *      `getClientRects()`）。选区还在时就是它。
     *   2. **`.xterm-selection` 层的矩形** —— DOM 选区折叠后，xterm 的灰色高亮仍画着，
     *      这一层的 `getBoundingClientRect()` 同样是浏览器真实布局值，无需推断坐标系。
     *
     * 都不行就返回 `null`，由调用方决定退路（**不要**在这里编一个假坐标 ——
     * 曾经填 `{innerWidth-200, 80}`，导致按钮永远出现在屏幕右上角）。
     *
     * @param {Element} terminal
     * @returns {{ clientX: number, clientY: number } | null}
     */
    function selectionPoint(terminal) {
      const usable = (rect) =>
        rect !== null &&
        rect !== undefined &&
        Number.isFinite(rect.right) &&
        Number.isFinite(rect.bottom) &&
        (rect.width > 0 || rect.height > 0)
      const round = (v) => (Number.isFinite(v) ? Math.round(v) : null)
      const box = (r) =>
        r === null || r === undefined
          ? null
          : { r: round(r.right), b: round(r.bottom), w: round(r.width), h: round(r.height) }
      // 逐级记录**原始测量值**：这是"落点又跑到视口角落"这类问题的唯一现场证据。
      // 没有它只能靠猜 —— 已经猜了好几轮，每次都被真实数据推翻。
      const trace = { stage: 'none', rangeCount: null, range: null, layerSel: null, layer: null, pieces: null }
      try {
        const selection = window.getSelection()
        trace.rangeCount = selection === null ? -1 : selection.rangeCount
        if (selection !== null && selection.rangeCount > 0) {
          const r = selection.getRangeAt(0).getBoundingClientRect()
          trace.range = box(r)
          if (usable(r)) {
            trace.stage = 'range'
            lastPointTrace = trace
            return { clientX: r.right, clientY: r.bottom }
          }
        }
      } catch (error) {
        trace.rangeThrew = String(error).slice(0, 60)
      }
      try {
        const layer = terminal.querySelector('.xterm-selection')
        trace.layerSel = layer === null ? 'null' : 'found'
        const lr = layer?.getBoundingClientRect()
        trace.layer = box(lr)
        if (usable(lr)) {
          trace.stage = 'layer'
          lastPointTrace = trace
          return { clientX: lr.right, clientY: lr.bottom }
        }
        // 层的整体矩形不可用时，退回**每段高亮 div** 各自的矩形（取最右、最下）。
        const pieces = layer === null ? [] : Array.from(layer.children ?? [])
        trace.pieces = pieces.length
        let right = null
        let bottom = null
        for (const piece of pieces) {
          const pr = safeRect(() => piece.getBoundingClientRect())
          if (pr === null) continue
          if (Number.isFinite(pr.right)) right = right === null ? pr.right : Math.max(right, pr.right)
          if (Number.isFinite(pr.bottom)) bottom = bottom === null ? pr.bottom : Math.max(bottom, pr.bottom)
        }
        trace.pieceEdge = right === null ? null : { r: round(right), b: round(bottom) }
        if (right !== null) {
          trace.stage = 'pieces'
          lastPointTrace = trace
          return { clientX: right, clientY: bottom ?? window.innerHeight - 80 }
        }
      } catch (error) {
        trace.layerThrew = String(error).slice(0, 60)
      }
      lastPointTrace = trace
      return null
    }

    /**
     * 读取落在侧栏终端内部的选区。
     *
     * 尽量宽容：xterm 的选择在 selectionchange 时可能已被清理、range 也可能退化，
     * 所以这里对每个 DOM 读取都单独容错，并把命中方式记在 `via` 里供诊断。
     * 判定顺序：有 range → 用 range 的祖先找终端；没有 range 但有 anchorNode →
     * 用 anchorNode 找；两者都没有就放弃（不猜）。
     *
     * @returns 选中文本 + 落点 + 命中方式；无有效选区时为 null。
     */
    function readTerminalSelection() {
      const selection = window.getSelection()
      if (selection === null) {
        selectionMiss = 'no-selection-object'
        return null
      }
      let raw = ''
      try {
        raw = String(selection.toString() ?? '')
      } catch {
        selectionMiss = 'toString-threw'
        return null
      }
      if (raw.trim() === '') {
        selectionMiss = 'empty-text'
        // 深挖 + 兜底：range 明明存在却读不到文本时，把它的形态记下来，
        // 并改用 xterm 自己的高亮叠加层来还原选中文本。
        // 已知情形：xterm 把锚点留在 `.xterm-helpers`（accessibility 层）且选区
        // **已折叠**，`toString()` 是空串——但高亮矩形仍然在 DOM 里。
        try {
          const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null
          // 逐项容错读取：任一属性抛异常都不该让整条高亮兜底路径失效
          // （实测踩过：整段包在一个 try 里，一行读属性抛了就整段放弃，
          //   连带把最可靠的还原方式也赔进去）。
          selectionStage = {
            rangeCount: safeRead(() => selection.rangeCount),
            collapsed: safeRead(() => selection.isCollapsed),
            startTag: describeNode(safeRead(() => range?.startContainer)),
            startOffset: safeRead(() => range?.startOffset),
            endTag: describeNode(safeRead(() => range?.endContainer)),
            endOffset: safeRead(() => range?.endOffset),
            rectCount: safeRect(() => range?.getClientRects()?.length ?? 0),
            anchorTag: describeNode(safeRead(() => selection.anchorNode)),
            focusTag: describeNode(safeRead(() => selection.focusNode)),
          }
          const anchor = safeRead(() => selection.anchorNode)
          // 归属判定分两段：
          //   a) 选区祖先链能找到终端 → 直接用它（准确）
          //   b) 找不到 → 看**哪些**终端真的画着高亮；**恰好一个**才敢用。
          //
          // 为什么 (b) 要求"恰好一个"：实测 xterm 会把选区锚点放进 `.xterm-helpers`
          // （accessibility 层），它不保证位于 `section[data-sidebar-terminal]` 之内，
          // 所以 (a) 经常全灭。而此时若按"高亮段数最多"来挑，**另一侧终端里一段旧的
          // 多行高亮会盖过这一侧刚选的一行** —— 于是把别的终端的内容当成你的选区。
          // 给错内容比不给更糟（你会拿到一份看似合理、其实无关的捕获），
          // 所以有歧义时宁可放弃：返回 null，让快捷键走登记表那条路。
          const domTerminals = Array.from(safeRead(() => document.querySelectorAll(TERMINAL_SELECTOR)) ?? [])
          const ancestorTerminal =
            closestTerminal(anchor) ??
            closestTerminal(safeRead(() => range?.startContainer)) ??
            closestTerminal(safeRead(() => range?.commonAncestorContainer))

          let terminal = ancestorTerminal
          let terminalSource = ancestorTerminal !== null ? 'selection-ancestor' : 'none'
          const highlightedTerminals = []
          if (terminal === null) {
            for (const candidate of domTerminals) {
              const rects = safeRect(() => collectHighlightRects(candidate).length) ?? 0
              if (rects > 0) highlightedTerminals.push(candidate)
            }
            if (highlightedTerminals.length === 1) {
              terminal = highlightedTerminals[0]
              terminalSource = 'dom-highlight'
            }
          }

          selectionStage.terminalFound = terminal !== null
          selectionStage.terminalsInDom = domTerminals.length
          selectionStage.terminalsWithHighlight = highlightedTerminals.length
          selectionStage.terminalSource =
            terminalSource === 'none' && highlightedTerminals.length > 1
              ? 'ambiguous-highlight'
              : terminalSource
          if (terminal !== null) {
            selectionStage.highlightRects = safeRect(() => collectHighlightRects(terminal).length) ?? -1
            selectionStage.rowsInTerminal = safeRead(() => terminal.querySelector('.xterm-rows')?.children?.length) ?? -1
            const restored = safeRead(() => readHighlightedText(terminal)) ?? {
              text: '',
              lastRow: -1,
              rowElement: null,
            }
            const highlighted = typeof restored === 'string' ? restored : restored.text
            selectionStage.highlightChars = highlighted.length
            selectionStage.highlightLastRow = restored.lastRow ?? -1
            if (highlighted !== '') {
              selectionMiss = null
              selectionStage.via = 'highlight'
              // 高亮还原成功说明这才是用户当前的选区：清掉该终端上可能残留的
              // 旧 copy 探针，否则它会凭"优先级更高"压过这次的新选区。
              copyProbeText.delete(terminal)
              // 落点现测：DOM 选区矩形（此时通常已空）→ `.xterm-selection` 层矩形。
              // 两者都是浏览器真实布局值，不含任何我对 xterm 内部结构的假设。
              return {
                text: highlighted.slice(0, MAX_SELECTION_CHARS),
                truncated: highlighted.length > MAX_SELECTION_CHARS,
                via: 'highlight',
                terminal,
                point: selectionPoint(terminal),
              }
            }
          }
        } catch {
          selectionStage = { probe: 'threw' }
        }
        return null
      }
      const text = normalize(raw)
      if (text === '') {
        selectionMiss = 'empty-after-normalize'
        return null
      }

      /** @type {{ terminal: Element, rect: DOMRect | null, via: string } | null} */
      let hit = null
      const stage = { rangeCount: -1, rangeAncestorTag: null, rangeTerminal: false, anchorTag: null, anchorTerminal: false }

      if (selection.rangeCount > 0) {
        stage.rangeCount = selection.rangeCount
        try {
          const range = selection.getRangeAt(0)
          const node = range.commonAncestorContainer
          stage.rangeAncestorTag = describeNode(node)
          const terminal = closestTerminal(node)
          stage.rangeTerminal = terminal !== null
          if (terminal !== null) {
            hit = { terminal, rect: safeRect(() => range.getBoundingClientRect()), via: 'range' }
          }
        } catch {
          stage.rangeThrew = true
        }
      }

      if (hit === null && selection.anchorNode !== null) {
        stage.anchorTag = describeNode(selection.anchorNode)
        const terminal = closestTerminal(selection.anchorNode)
        stage.anchorTerminal = terminal !== null
        if (terminal !== null) hit = { terminal, rect: null, via: 'anchor' }
      }

      if (hit === null) {
        selectionMiss = 'not-inside-terminal'
        selectionStage = stage
        return null
      }
      selectionMiss = null
      selectionStage = stage

      const rect = hit.rect
      const hasRect = rect !== null && (rect.width > 0 || rect.height > 0)
      return {
        text: text.slice(0, MAX_SELECTION_CHARS),
        truncated: text.length > MAX_SELECTION_CHARS,
        via: hit.via,
        /** 选区所属的终端元素（登记表按它分键）。 */
        terminal: hit.terminal,
        // 落点：DOM 选区矩形优先；没有就现测一次（高亮层矩形，同样是浏览器布局值）。
        // 这里曾经在无矩形时填 `{innerWidth-200, 80}`，于是按钮莫名出现在屏幕右上角。
        point: hasRect ? { clientX: rect.right, clientY: rect.bottom } : selectionPoint(hit.terminal),
      }
    }

    /**
     * 向页面里每个终端派发一次合成 `copy` 事件，请 xterm 把选中文本交出来。
     * 结果由 `onDocumentCopy` 旁听截获（见 copyProbeText 的说明）。
     */
    function probeTerminalCopy() {
      try {
        for (const terminal of document.querySelectorAll(TERMINAL_SELECTOR)) {
          const xterm = terminal.querySelector(XTERM_SELECTOR) ?? terminal
          // 不 bubbles：避免被无关监听器看到；xterm 自己在 .xterm 上监听。
          xterm.dispatchEvent(new ClipboardEvent('copy', { bubbles: false, cancelable: true }))
        }
      } catch {
        // 探针是尽力而为。
      }
    }

    /**
     * 三条兜底路的统一解析（**按钮与快捷键共用**）。
     *
     * 顺序：
     *   ① 登记表（划选时记下的最近选区）
     *   ② 实时 DOM 选区（这一刻可能还读得到）
     *   ③ xterm 复制探针（DOM 读不出时的最后手段）
     *
     * 为什么按钮也要走这条：按钮原先只读 `pending`，而 `mouseup` 监听注册在**捕获阶段**，
     * 会先于按钮的 `click` 把 `pending` 置为 null（读到的选区常已折叠）并隐藏按钮 ——
     * 结果就是"点了没反应"。快捷键当时有三条兜底，按钮一条都没有，这个不对称是 bug。
     *
     * ① 和 ③ 只在高亮层还在时才用。取消选中后这两份缓存仍会留着（探针 5 分钟，
     * 登记表 30 分钟）。藏按钮的那条路会清缓存，但快捷键不经过那条路：高亮已经
     * 没了、缓存还在时，`Ctrl+L` 仍会把上一次的终端文本送进对话。
     * ② 不受这条约束。这一拍浏览器里确实还有选区时，照常认。
     *
     * @returns {{ element: Element|null, selection: object } | null}
     */
    function resolveUsableSelection(diag) {
      const highlightVisible = anyTerminalHasHighlight()
      let target = highlightVisible ? newestSelection(diag) : null
      if (target === null) {
        try {
          const live = readTerminalSelection()
          if (live !== null) target = { element: live.terminal, selection: live }
        } catch {
          // 读不到就当没有。
        }
      }
      if (target === null && highlightVisible) {
        const probed = newestProbe()
        if (probed !== null) {
          target = {
            element: probed.terminal,
            selection: {
              text: probed.text,
              truncated: probed.text.length > MAX_SELECTION_CHARS,
              via: 'xterm-copy',
              terminal: probed.terminal,
              point: { clientX: 8, clientY: 8 },
            },
          }
        }
      }
      return target
    }

    /** 最近一次 copy 探针拿到的记录（未过期）；没有则 null。 */
    function newestProbe() {
      const now = Date.now()
      let best = null
      for (const [terminal, entry] of copyProbeText) {
        if (now - entry.at > PROBE_TTL_MS) {
          copyProbeText.delete(terminal)
          continue
        }
        if (terminal?.isConnected !== true) {
          copyProbeText.delete(terminal)
          continue
        }
        if (best === null || entry.at > best.at) best = { ...entry, terminal }
      }
      return best
    }

    /** 最近一次 copy 探针拿到的字符数（诊断用）。 */
    function newestProbeChars() {
      const probed = newestProbe()
      return probed === null ? 0 : probed.text.length
    }

    /**
     * 从 xterm 自己的**高亮叠加层**提取选中文本。
     *
     * 为什么必须走这条：实测 xterm 的「灰色高亮」与浏览器选区是两套东西——
     * 鼠标松开时 `window.getSelection()` 已经是 `collapsed: true`（零矩形），
     * 因此 DOM 选区读取与合成 `copy` 探针**都拿不到文本**，而高亮还好端端画着。
     *
     * xterm 的 DOM 渲染器把高亮画在 `.xterm-selection`（`pointer-events:none`
     * 的绝对定位层）里的若干 `<div>` 上，每个 div 的 `style.left/top/width/height`
     * 就是一段高亮的像素矩形。据此还原「哪些行、行的哪几列」被选中，
     * 再从 `.xterm-rows` 的对应行元素取文本。
     *
     * @param {Element} terminal 终端容器
     * @returns {{ text: string, lastRow: number, rowElement: Element|null }}
     *   选中文本 + **选区最后落在哪一行**。行号连同行元素一起返回，是为了让按钮落点能
     *   用行元素自己的矩形来算 —— 见 `rowBottomRight` 里关于坐标系的说明。
     *   无法还原时 `{ text: '', lastRow: -1, rowElement: null }`。
     */
    function readHighlightedText(terminal) {
      const empty = { text: '', lastRow: -1, rowElement: null }
      const rowsHost = terminal.querySelector('.xterm-rows')
      if (rowsHost === null) return empty
      const rows = Array.from(rowsHost.children)
      if (rows.length === 0) return empty

      const firstTop = rows[0].offsetTop
      const rowHeight = rows[0].offsetHeight || rows[0].getBoundingClientRect().height
      if (!Number.isFinite(rowHeight) || rowHeight <= 0) return empty

      const highlights = collectHighlightRects(terminal)
      if (highlights.length === 0) return empty

      const picked = []
      for (const rect of highlights) {
        const startRow = clampInt(Math.floor((rect.top - firstTop) / rowHeight), 0, rows.length - 1)
        const endRow = clampInt(
          Math.floor((rect.top + Math.max(rect.height, 1) - firstTop - 1) / rowHeight),
          0,
          rows.length - 1,
        )
        for (let row = startRow; row <= endRow; row += 1) {
          picked.push({ row, text: rowText(rows[row]) })
        }
      }
      if (picked.length === 0) return empty

      // 只按行拼接，**不做任何列裁剪**。
      //
      // 曾经尝试"中间行整行、末行按列裁"以还原更精确的选区，但那必须把高亮矩形的
      // 像素宽度换算成字符列。实测这会**切掉用户真正想要的文本**（把 `ls -la` 的
      // 最后一行切成半个词、并丢掉末尾若干行），违背本插件"原文一字不改"的根本承诺。
      //
      // 现在的分工：高亮矩形只用来判断**覆盖了哪些行**；行内文本整行取。
      // 宁可多带几个字符，也绝不丢内容。
      picked.sort((a, b) => a.row - b.row)
      const lines = []
      let currentRow = -1
      let buffer = ''
      for (const piece of picked) {
        if (piece.row !== currentRow) {
          if (currentRow !== -1) lines.push(buffer)
          currentRow = piece.row
          buffer = ''
        }
        // 同一行有多段高亮时（跨列选择）按行去重，只取一次整行。
        if (!buffer.includes(piece.text)) buffer = buffer === '' ? piece.text : buffer
      }
      lines.push(buffer)
      const lastRow = picked.reduce((max, piece) => Math.max(max, piece.row), picked[0].row)
      return {
        text: normalize(lines.join('\n')),
        lastRow,
        rowElement: rows[lastRow] ?? null,
      }
    }

    /** 收集 `.xterm-selection` 里每段高亮的像素矩形。 */
    function collectHighlightRects(terminal) {      const out = []
      for (const layer of terminal.querySelectorAll('.xterm-selection')) {
        for (const piece of layer.children) {
          const style = piece.style ?? {}
          const top = Number.parseFloat(style.top)
          const left = Number.parseFloat(style.left)
          const width = Number.parseFloat(style.width)
          const height = Number.parseFloat(style.height)
          if (!Number.isFinite(top) || !Number.isFinite(left) || !Number.isFinite(width)) continue
          if (!(width > 0)) continue
          out.push({ top, left, width, height: Number.isFinite(height) ? height : 0 })
        }
      }
      return out
    }

    /** 一行元素的纯文本（xterm 每行由若干 span 组成）。 */
    function rowText(rowElement) {
      try {
        return rowElement.textContent ?? ''
      } catch {
        return ''
      }
    }

    /** 整数夹取。 */
    function clampInt(value, min, max) {
      if (!Number.isFinite(value)) return min
      return Math.min(Math.max(Math.trunc(value), min), Math.max(min, max))
    }

    /** 当前 DOM 选区的字符数（诊断用；读不到返回 -1）。 */
    function safeSelectionChars() {
      try {
        return window.getSelection()?.toString()?.trim()?.length ?? 0
      } catch {
        return -1
      }
    }

    /** 节点的简短描述（诊断用）。 */
    function describeNode(node) {
      if (node === null || node === undefined) return null
      try {
        if (node.nodeType === Node.TEXT_NODE) {
          return `#text@${node.parentElement?.tagName ?? '?'}`
        }
        const element = node
        const cls = typeof element.className === 'string' && element.className !== ''
          ? `.${element.className.split(/\s+/)[0]}`
          : ''
        return `${element.tagName ?? '?'}${cls}`
      } catch {
        return 'unreadable'
      }
    }

    /** 跑一个可能抛异常的 DOM 读取，失败返回 null。 */
    function safeRect(read) {
      try {
        return read()
      } catch {
        return null
      }
    }

    /** 同上，语义更清楚的别名：任何单个属性读取都不该让调用方整段失败。 */
    function safeRead(read) {
      try {
        return read()
      } catch {
        return null
      }
    }

    /** 选区是否落在某个侧栏终端的 xterm 里；是则返回该终端元素。 */
    function closestTerminal(node) {
      if (node === null || node === undefined) return null
      // 文本节点 → 元素；文档节点直接放弃。
      let element = null
      try {
        element = node.nodeType === Node.ELEMENT_NODE ? node : (node.parentElement ?? null)
      } catch {
        return null
      }
      if (element === null) return null
      const terminal = element.closest(TERMINAL_SELECTOR)
      if (terminal === null) return null
      // 终端容器存在即可；xterm 根可能还没挂上（空态卡片），此时放行但不强求。
      return terminal
    }

    // ── 写入上下文 ────────────────────────────────────────────────────────

    /**
     * 落盘捕获文件 → 插引用 chip。按钮与快捷键共用这一条通路。
     *
     * 注意：**不迁移焦点到输入框**（见函数末尾的注释）——抢焦点会清掉终端选区，
     * 导致"第一次能用、之后失灵"。
     */
    async function addToContext(ctx, takeSelection, clearSelection, getBridge) {
      const selection = takeSelection()
      clearSelection()
      if (selection === null) return

      const composer = document.querySelector(COMPOSER_SELECTOR)
      const sessionId = composer?.closest(SESSION_SELECTOR)?.dataset.conversationSession
      if (composer === null || sessionId === undefined) {
        console.warn(`[${PLUGIN_ID}] 找不到输入框或当前会话，已取消`)
        return
      }

      try {
        const stamp = timestamp()
        // 浏览器侧拿不到 node:fs（宿主模块表不含 Node 内置），落盘一律交给
        // 宿主一半的 HTTP 路由；路由自己按会话解析工作区并限制在允许范围内。
        const relative = await writeCapture(sessionId, renderCapture(selection, stamp), stamp)

        // ① 首选：插槽桥（属于当前会话的 inputActions）
        const bridge = getBridge()
        if (bridge.actions !== null && bridge.sessionId === sessionId) {
          const span = bridge.actions.captureInsertion()
          if (emitReference(ctx, sessionId, {
            draftRev: span.draftRev,
            start: span.start,
            end: span.end,
          }, relative)) {
            return
          }
        }

        // ② 次选：直接解析 conversation 服务
        const input = resolveInput(ctx, sessionId)
        if (input !== null && insertFileChip(ctx, sessionId, input, relative)) {
          return
        }

        // ③ 兜底：把路径作为纯文本提及送出（DSH 仍会做文件夹装饰）
        console.warn(`[${PLUGIN_ID}] 结构化插入不可用，回退为纯文本提及`)
        const fallback = bridge.actions ?? input?.actions
        if (fallback !== null && fallback !== undefined) {
          const span = fallback.captureInsertion()
          fallback.insertText(`@${relative} `, span)
        }
        // 注意：这里**故意不调 `composer.focus()`**。
        // 抢焦点会清掉终端的选区 → 下一次按 Ctrl+L 时登记表已空、DOM 里也没有选区，
        // 表现就是"第一次能用，之后失灵"（真发生过）。保持焦点不动，用户想打字
        // 自己点输入框即可，而选区得以保留、可以连着按几次。
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] 写入上下文失败：`, error)
      }
    }

    /** 调宿主路由落盘捕获文件，返回工作区相对路径（POSIX 分隔符）。 */
    async function writeCapture(sessionId, text, stamp) {
      const response = await fetch(`/${PLUGIN_ID}/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, text, stamp }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error?.message ?? `宿主返回 HTTP ${response.status}`)
      }
      return payload.value.relativePath
    }

    /** 解析会话的输入框 shell；任一层服务缺失都返回 null。 */
    function resolveInput(ctx, sessionId) {
      try {
        const actx = ctx.sessions.scope(sessionId)
        if (actx === undefined) return null
        const conversation = ctx.get('conversation')
        if (conversation === undefined) return null
        const input = conversation.input.for(actx)
        return input ?? null
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] 解析输入框失败：`, error)
        return null
      }
    }

    /**
     * 用 DSH 原生的结构化引用事件插入一个文件 chip。
     * `span` 必须携带**当前** draftRev（宿主用修订号做 CAS 校验），
     * 所以每次点击都重新捕获，不能复用旧快照。
     */
    function insertFileChip(ctx, sessionId, input, relativePath) {
      try {
        const span = input.actions.captureInsertion()
        return emitReference(ctx, sessionId, {
          draftRev: span.draftRev,
          start: span.start,
          end: span.end,
        }, relativePath)
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] 插入引用失败：`, error)
        return false
      }
    }

    /** 派发 `slash/input-insert-reference`（会话作用域）。 */
    function emitReference(ctx, sessionId, span, relativePath) {
      try {
        const actx = ctx.sessions.scope(sessionId)
        if (actx === undefined) return false
        const label = relativePath.slice(relativePath.lastIndexOf('/') + 1)
        const payload = {
          reference: {
            source: 'reference',
            ref: `@${relativePath}`,
            label,
            appearance: 'file',
            clipboardText: `@${relativePath}`,
          },
          span,
        }
        // 作用域派发：官方三处都用 `actx.bail(actx, name, payload)`（把 actx 当
        // dispatch 的 this 以启用作用域过滤）；`actx.emit(...)` 在部分版本上不带
        // 作用域。优先 bail，缺失时回退 emit。
        //
        // 关键：`insertReference` 内部有修订号 CAS（`span.draftRev !== this.rev`
        // 直接返回 false）与阶段检查，所以**必须看返回值**——返回 false 说明这次
        // 插入被拒（草稿变了、或输入框处于非 plain/claimed 阶段），此时应该换一条
        // 通路而不是假装成功。`emit` 不返回处理结果，只能当作"已提交"。
        if (typeof actx.bail === 'function') {
          return actx.bail(actx, 'slash/input-insert-reference', payload) === true
        }
        actx.emit('slash/input-insert-reference', payload)
        return true
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] 派发引用事件失败：`, error)
        return false
      }
    }

    // ── 杂项 ──────────────────────────────────────────────────────────────

    /** 组装落盘内容：来源头部 + 原文（原文一字不改，只统一换行）。 */
    function renderCapture(selection, stamp) {
      const lines = selection.text.split('\n').length
      const header = [
        '<!-- DSH 终端上下文 · 由 dsh-terminal-context 插件生成 -->',
        '<!-- 来源：右侧栏终端（DSH 内置 ui-sidebar-terminal） -->',
        `<!-- 捕获时间：${stamp} · 行数：${lines}${selection.truncated ? ' · 已截断' : ''} -->`,
        '',
      ].join('\n')
      return `${header}${selection.text}\n`
    }

    /** 提示宿主清理超额的历史捕获文件（路由内部保留最近若干个）。 */
    async function sweepCaptures(ctx) {
      try {
        const sessionId = document.querySelector(SESSION_SELECTOR)?.dataset.conversationSession
        if (sessionId === undefined) return
        await fetch(`/${PLUGIN_ID}/sweep`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
      } catch {
        // 清理是尽力而为：失败不影响功能。
      }
    }

    // ── 小工具 ────────────────────────────────────────────────────────────

    /**
     * 配额策略（踩过两次坑，现在是三档）：
     *
     *   1. **一次性事件**（`DIAG_ONCE_EVENTS`）—— 每种只报一次，且**不占配额**。
     *      否则反复的 `client-loaded` 会把配额吃光，把关键事件挤掉。
     *   2. **结论事件**（`DIAG_RESERVED_EVENTS`）—— 走**保留配额**，永远不被高频事件挡住。
     *      `mouseup-sample` / `shortcut-resolve` / `shortcut-run` 是"这门功能到底成没成"
     *      的唯一结论行；而一次拖选能触发几十次 `selectionchange`，共用配额时
     *      恰恰是"松开鼠标"那条最该留下的报不上去。
     *   3. 其余事件共用普通配额。
     *
     * 上报失败一律静默：诊断绝不能影响功能。
     */
    const DIAG_ONCE_EVENTS = new Set([
      'client-loaded',
      'shortcut-registered',
      'shortcut-unavailable',
      'shortcut-register-failed',
    ])
    const DIAG_RESERVED_EVENTS = new Set([
      'mouseup-sample',
      'shortcut-resolve',
      'shortcut-run',
      'selection-threw',
    ])
    function createDiagReporter() {
      let sent = 0
      let reservedSent = 0
      const LIMIT = 40
      const RESERVED_LIMIT = 60
      const alreadySent = new Set()
      return async function report(event, detail) {
        if (DIAG_ONCE_EVENTS.has(event)) {
          if (alreadySent.has(event)) return
          alreadySent.add(event)
        } else if (DIAG_RESERVED_EVENTS.has(event)) {
          if (reservedSent >= RESERVED_LIMIT) return
          reservedSent += 1
        } else {
          if (sent >= LIMIT) return
          sent += 1
        }
        try {
          await fetch(`/${PLUGIN_ID}/diag`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              event,
              detail: detail ?? null,
              pluginVersion: PLUGIN_VERSION,
              href: typeof location !== 'undefined' ? location.href : null,
              at: new Date().toISOString(),
            }),
          })
        } catch {
          // 诊断是尽力而为。
        }
      }
    }

    /**
     * 登记一次有效选区（按终端元素分键，保留最新的）。
     * 超过有效期的登记在读取时顺带清掉，避免长期占用内存。
     *
     * 登记的是文本，供按钮和 `Ctrl+L` 在 DOM 选区折叠之后继续使用。
     * 调用方若带了 `point` 就一起存，诊断还能读到；按钮位置不读它，
     * 落点固定在输入框上方（见 `placeButton`）。
     */
    function rememberSelection(selection) {
      if (selection.terminal === null || selection.terminal === undefined) return
      lastSelections.set(selection.terminal, {
        text: selection.text,
        truncated: selection.truncated,
        at: Date.now(),
        /** 登记时带上的坐标；按钮位置不读它。 */
        point: selection.point ?? null,
      })
    }

    /**
     * 取最近一次登记的选区——优先"当前仍连在页面上的终端"，其次是任意未过期的登记。
     *
     * @returns {{ selection: object, element: Element } | null}
     */
    function newestSelection(diag) {
      const now = Date.now()
      let best = null
      for (const [element, entry] of lastSelections) {
        // 终端标签页可能已被关闭/替换：摘掉失效登记。
        if (element?.isConnected !== true) {
          lastSelections.delete(element)
          void diag?.('selection-pruned', { why: 'disconnected', ageMs: now - entry.at })
          continue
        }
        if (now - entry.at > SELECTION_TTL_MS) {
          lastSelections.delete(element)
          void diag?.('selection-pruned', { why: 'expired', ageMs: now - entry.at })
          continue
        }
        if (best === null || entry.at > best.entry.at) best = { element, entry }
      }
      if (best === null) return null
      return {
        element: best.element,
        /** 这条登记的时间戳，供调用方做**新鲜度**判断（按钮兜底要用）。 */
        at: best.entry.at,
        selection: {
          text: best.entry.text,
          truncated: best.entry.truncated === true,
          via: 'remembered',
          // 登记时记下的坐标，可能是 null。按钮位置不读这个字段。
          point: best.entry.point ?? null,
        },
      }
    }

    /** 终端选区文本清洗：统一换行、去掉 xterm 行尾带出的空白。 */
    function normalize(text) {
      return text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/\s+$/u, ''))
        .join('\n')
        .replace(/^\n+|\n+$/g, '')
    }

    /** 文件名时间戳（本地时区，可排序）。 */
    function timestamp() {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      return [
        now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()),
        '-', pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds()),
      ].join('')
    }

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), Math.max(min, max))
    }

    /** 注入插件样式（幂等：同一份 CSS 只挂一次）。 */
    function installStyles() {
      const id = `${PLUGIN_ID}-css`
      if (document.getElementById(id) !== null) return
      const style = document.createElement('style')
      style.id = id
      style.dataset.pluginCss = PLUGIN_ID
      style.textContent = `
.dsh-tc-btn {
  position: fixed;
  z-index: 2147483000;
  margin: 0;
  padding: 4px 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 55%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 92%, #000);
  color: #fff;
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: 0 4px 14px rgb(0 0 0 / 28%);
  transition: transform .12s ease, opacity .12s ease;
}
.dsh-tc-btn:hover { transform: translateY(-1px); }
.dsh-tc-btn:active { transform: translateY(0); }
`
      document.head.appendChild(style)
    }

    // 客户端包用 default 输出插件（与官方模板的 `export default {...}` 同形）。
    //
    // `inject` 是必需的，不能省：Cordis 靠它**等到服务就绪才加载插件**。
    // 早先为了"少一个顶层依赖"改成只用 `ctx.get('shortcuts')` 是错的——apply 会在
    // shortcuts 服务注册之前执行，拿到 undefined，快捷键静默失效（诊断日志里就是
    // `shortcut-unavailable { hasService: false }`）。官方消费者 ui-layout 同样声明
    // `inject = ['slots','theme','locale','shortcuts']`。
    return {
      default: {
        name: PLUGIN_ID,
        inject: ['slots', 'sessions', 'shortcuts'],
        apply,
        /**
         * 离线测试钩子。**不在真实运行里使用** —— 宽限期就是要在 `mouseup` 后的
         * 那段时间里不藏按钮，测试却需要能构造"早就松开过了"的场景。
         */
        __test: { resetMouseupGrace: __resetMouseupGrace },
      },
    }
  },
})
