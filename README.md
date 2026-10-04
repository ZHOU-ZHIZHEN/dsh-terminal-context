# dsh-terminal-context

Select output in DSH's **built-in right-sidebar terminal**, then click into the current
conversation's composer. An **"Add to context"** button appears **above the composer**, fixed
at the right edge of the chat area. One click turns that output into an **`@file` reference
chip** in the composer — the same kind of chip you get by typing `@file` by hand: clickable to
preview, and expanded to its full contents when the message is sent.

The interaction follows Cursor's `@Terminals` and Trae's "add to conversation", not
"copy a wall of text and paste it". The button does not sit next to the selection: this
terminal does not yield a reliable screen position for the highlight, and a fixed spot neither
jumps nor covers the composer.

English | [中文](README.zh.md)

## Two ways to trigger it

1. **Button** — select text in the terminal, then click into the composer (you were going to
   click there to type anyway). "Add to context" appears above the composer. Click it.

   On mouse-up the browser selection has often already collapsed, so the button usually waits
   for the `selectionchange` that comes with focusing the composer. Once the terminal selection
   is cleared and xterm's grey highlight disappears, the button hides immediately.
2. **Shortcut** — while that grey highlight is still showing, press **`Ctrl+L`** (macOS:
   `Cmd+L`). The command id is `dsh-terminal-context.add`; rebind it in **Settings → Keyboard
   shortcuts**.

The shortcut does **not** claim the key when there is no usable selection, so it will not
permanently steal `Ctrl+L` from the terminal. After the highlight layer is empty it also will
not send a stale capture cached from a few minutes earlier. Note that while a selection is
active it *does* take over: `Ctrl+L` will no longer clear the screen — use `clear` for that.

## Why a capture file instead of inlined text

Terminal output is often hundreds of lines. Pasting it as plain text would:

- bury your actual question;
- re-spend tokens on every resend;
- lose the provenance (is this terminal output, or something you typed?).

So the plugin goes through **capture file + native file reference**:

1. selection → written to `<workspace>/.dsh/term-captures/terminal-<timestamp>.txt`
   with a short provenance header;
2. the file is inserted into the composer as a structured reference chip;
3. when sent, the reference serializes to
   `@.dsh/term-captures/terminal-….txt`, which the agent can simply read.

The composer stays clean, the reference is clickable, the original text is preserved,
and old captures are pruned automatically (the 20 most recent are kept).

One deliberate cleanup on the way in: **each trailing-whitespace run and any leading/trailing
blank lines are stripped**. xterm pads every row to the full terminal width with spaces, so
keeping them would embed hundreds of invisible characters — the visible text is unchanged, but
"verbatim" here means *the text you see*, not the padded buffer.

## Install

DSH has **no official plugin store**; distribution is npm, a git host, or a tarball. The app's
own plugin manager handles all three.

**From npm** (recommended — prebuilt, so no build-script approval is needed):

```sh
dsh plugin --profile web add dsh-terminal-context
```

**From GitHub** — the published client bundle is checked in, so this repo needs no build step
and asks for no `allowBuilds` permission:

```sh
dsh plugin --profile web add github:ZHOU-ZHIZHEN/dsh-terminal-context
```

**Tarball** — `pnpm pack` produces one; install it with
`dsh plugin --profile web add ./dsh-terminal-context-0.1.0.tgz`.

**Desktop app** — the `desktop` profile is owned exclusively by the Electron app
(the CLI refuses it: `profile "desktop" is managed exclusively by the Electron application`),
so use the app's own manager: **sidebar → Plugins → Add plugin**, and give the absolute path to
this directory. Restart DeepSeek Harness afterwards.

## How insertion works (three fallback paths)

There is exactly one supported way to insert a reference chip: the session-scoped event
`slash/input-insert-reference`, whose `span` must carry the **current** `draftRev` (the host does
a compare-and-swap) and whose `reference.source` must be a source the core recognizes —
otherwise the user cannot send the message at all.

The hard part is obtaining that span. `inputActions.captureInsertion()` is a slot component's
standard prop, and whether a bare `apply(ctx)` can reach `conversation.input.for(scope)` is not
guaranteed. So all three are prepared, in order:

1. **Slot bridge (preferred)** — a **headless component** registered into the already-declared
   list slot `conversation.input.dock` (the core's own `todo` / `queue` entries live there too).
   It always receives the standard prop `inputActions`, and records the current session's
   `captureInsertion` / `insertText` into a module-level bridge.
2. **Direct service** — `ctx.get('conversation').input.for(scope)`.
3. **Plain-text degrade** — `@path` as plain text, which DSH still decorates as a folder
   reference.

`bail()`'s **return value is checked**: the host's `insertReference` enforces a revision
compare-and-swap and a phase check, so a `false` return means this insertion was rejected and the
next path must be tried — never assume success.

Any failure in any layer logs one `[dsh-terminal-context]` warning; none of them break the UI.

### Reading the selection: two paths, different precision

| Path | When | Precision |
|---|---|---|
| xterm's native selection | while the DOM selection is still readable | **exact** |
| highlight-layer reconstruction | once the DOM selection has collapsed | **whole rows, errs on the side of more** |

Measured behaviour: by the time the mouse button is released, the browser selection is often
already `collapsed: true` with zero rects, so both `window.getSelection().toString()` and a
synthetic `copy` probe come back empty — while xterm's grey highlight is still painted, because
that is a separate layer xterm draws itself. The reconstruction therefore reads
`.xterm-selection`'s absolutely-positioned highlight rectangles to decide **which rows** were
covered, and takes those rows' text in full.

**Deliberate trade-off:** boundary rows may carry extra lines. An earlier version trimmed the
last row by column, converting pixel widths to character columns — measurably it **cut off text
the user wanted**, truncating a whole line, which violates this plugin's core promise of
preserving the original verbatim. Hence: **better to over-include than to lose content** —
an extra line is trivial to delete, a missing one means selecting again.

## Structure

| File | Role |
|---|---|
| `lib/client.js` | Browser half, in **built-bundle format** (`window.__ModuleLoader__.load`): selection listening, the button docked above the composer, shortcut, slot bridge, reference chip |
| `lib/index.js` | Host half (Node): the HTTP routes (`capture` / `sweep` / `diag`) and the workspace realpath jail |
| `cordis.patch.yml` | The bundle layer that inserts this plugin's row |
| `test-host.mjs` | Offline host verification (fake ctx + fake req/res) |
| `test-client.mjs` | Offline client verification (fake module table + fake DOM) |

## Verify

```sh
node test-host.mjs lib/index.js     # routes, disk write, error branches, retention sweep
node test-client.mjs lib/client.js  # bundle contract, startup, full click path
```

## Known limitations

- **The button stays above the composer; it does not follow the selection.** Highlight
  rectangles, row coordinates, and the pointer were all tried; in this terminal they push the
  button to the terminal's right edge, off screen, or onto the composer. The mouse-up that
  finishes a selection often cannot read the text, so the button usually appears when you
  click into the composer.
- **The three HTTP routes do not authenticate the caller.** `/capture`, `/sweep`, and `/diag`
  are registered through DSH's own `webServer`, and nothing in this plugin checks who is asking:
  whoever can reach the port can write a capture into a session workspace (which the agent may
  then read), trigger a retention sweep, or append diagnostics. Measured on this machine — a
  plain `fetch` from a Node script with **no credentials** reaches the handler (it answers
  `405`, not `401`).

  Whether the port is reachable beyond the app's own page is the host's decision, not this
  plugin's, and I could not verify it (no standalone `webServer` implementation was available to
  test against). So: **keep DSH's web port on loopback and do not expose it to a LAN or the
  internet.** Adding a bespoke token inside the plugin would only create a false sense of
  security, since anything able to reach the route could read the token from the same page.

- **The diagnostics log is read-modify-write.** `/diag` rewrites
  `$DSH_HOME/dsh-terminal-context-diag.json` whole, keeps the newest 200 entries, and caps one
  request body at 4 MB. Concurrent reports can therefore lose entries. It is a debugging aid,
  not an audit log.
- **Only the built-in sidebar terminal** (`[data-sidebar-terminal]`). `dsh-better-sidebar`'s
  terminal page is the same one — since v0.19.0 it hands the terminal back to DSH's native
  `ui-sidebar-terminal` — so both are covered. This plugin declares **no dependency** on
  `dsh-better-sidebar` and reads only DOM markers, which is why it survived the terminal APIs
  that plugin deleted in v0.21.1.
- **Not "automatic context"** — you still select and click. DSH's sidebar terminal is designed
  not to write its output into the agent transcript
  (`dsh-api-terminal-controller`: *Terminal output stays outside the Agent transcript*), so no
  fully automatic path exists.
- Depends on the internal event `slash/input-insert-reference` (it ships no published types).
  If it changes, the plugin stops working — the symptom is a button that does nothing, with
  `[dsh-terminal-context]` warnings in the diagnostics log.
- **Capture location and footprint**: `<workspace>/.dsh/term-captures/`, keeping the 20 most
  recent files (oldest deleted first, by filename timestamp). The dot-prefixed directory is
  hidden from editor file trees, `dir`, and `ls` by default; measured at roughly 0.4–6 KB per
  capture, so a full 20 is a few tens of KB. To inspect or clear it manually:
  `Get-ChildItem -Force .dsh\term-captures`. If the workspace becomes a git repository, ignore
  `.dsh/`.

## Diagnostics

The packaged desktop client cannot open DevTools (F12 is bound in the source but that block is
marked removable and does not take effect in the packaged build). So the client reports its state
to a host route, which appends it to:

```
$DSH_HOME/dsh-terminal-context-diag.json
```

Each entry carries a one-line `verdict`, e.g. `ok via=highlight chars=542` or
`no-selection (miss=empty-text, live=0, probe=0, rects=3)`, plus the raw stage snapshot. Startup
events are reported once and do not consume the quota, so a repeated `client-loaded` cannot crowd
out the event you actually need.

## License

MIT
