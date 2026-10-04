# dsh-terminal-context

Turn selected text from DeepSeek Harness (DSH)'s built-in sidebar terminal into a native `@file` reference chip in your chat composer with a single click.

Inspired by Cursor's `@Terminals` and Trae's "Add to Conversation": eliminates manual copy-pasting of long terminal logs. References are inserted as clean, structured chips that can be clicked to preview and are automatically expanded to full text when the message is sent.

[English](README.md) | [简体中文](README.zh.md)

---

## How to Use

The workflow integrates naturally with your regular typing habits—no chasing floating buttons:

1. **Select text**: Highlight the desired terminal output or error trace in the right-sidebar terminal.
2. **Click the composer**: Focus the chat input box (where you are about to type your question). The **"Add to context"** button appears docked directly above the top-right corner of the composer.
3. **Insert reference**:
   - **Method A (Click)**: Click **"Add to context"**. The terminal output is immediately attached as a file reference chip.
   - **Method B (Shortcut)**: While the terminal text is still highlighted in grey, press **`Ctrl+L`** (macOS: **`Cmd+L`**).

> **Why a docked button instead of floating next to selection?**
> Practical testing shows that xterm's highlight overlay cannot provide a reliable screen bounding box across platforms once a selection collapses on mouse-up. Floating buttons frequently drifted out of the viewport or obstructed terminal text. Anchoring the button above the composer keeps it predictable, visible, and unobtrusive.

### Keyboard Shortcut & Deselection Behavior

- **Command ID**: `dsh-terminal-context.add`. Rebind it anytime under **Settings → Keyboard shortcuts**.
- **Non-blocking**: When no valid terminal selection exists, the plugin does not claim `Ctrl+L`, allowing the terminal's native screen clearing to function normally. To clear the terminal while a selection is active, use `clear`.
- **Clean Deselection**: Once you clear the selection in the terminal (the grey highlight disappears), the button above the composer hides immediately, and `Ctrl+L` will not send stale captures.

---

## Why Capture to a File Instead of Pasting Raw Text?

Terminal logs often range from dozens to hundreds of lines. Inlining raw text directly into the chat composer has major downsides:

- **Buries Your Question**: Huge walls of text drown out your actual prompt and clutter conversation history.
- **Wastes Context Tokens**: Resending or editing messages causes embedded text to be serialized repeatedly, burning context window capacity.
- **Loses Provenance**: AI agents cannot reliably distinguish between terminal-generated outputs and user-typed instructions.

This plugin implements a **"local capture file + native reference injection"** pattern:

1. Selected text is saved to `<workspace>/.dsh/term-captures/terminal-<timestamp>.txt` with a short provenance header.
2. The capture is inserted into the composer as a native DSH reference chip.
3. When sent, the reference serializes to `@.dsh/term-captures/terminal-….txt`, allowing the Agent to read the full content cleanly on demand.

> **Automatic Trimming**: When saving, trailing whitespace on every row and leading/trailing blank lines are stripped. Because xterm pads rows with spaces to the terminal viewport width, this cleanup removes hundreds of invisible space characters while preserving all visible text verbatim.

---

## Installation

DSH has no centralized plugin marketplace. Plugins are installed using DSH's built-in plugin manager. This repository ships pre-bundled client code, requiring no local build steps or `allowBuilds` permissions.

### Option 1: Desktop GUI Install (Recommended)

If you use the DeepSeek Harness desktop application, install directly from the graphical interface without using a terminal:

1. Open DeepSeek Harness Desktop and click the **Plugins** icon on the left sidebar.
2. Click **Add Plugin** in the top right.
3. In the input box, enter the GitHub repository identifier directly:
   ```text
   github:ZHOU-ZHIZHEN/dsh-terminal-context
   ```
4. Click install and wait for DSH to finish fetching the package.
5. **Restart DeepSeek Harness** to apply the plugin.

> **Local Development Tip**: If you are developing locally, you can also enter the **absolute local path** of this directory into the "Add Plugin" field to load it as a linked local plugin.

### Option 2: Web Profile / CLI Install

If you run DSH Web or manage profiles via CLI, run in your terminal:

```sh
dsh plugin --profile web add github:ZHOU-ZHIZHEN/dsh-terminal-context
```

> **Note**: The desktop profile is managed exclusively by the Electron application. Running the CLI command against `desktop` will return `profile "desktop" is managed exclusively by the Electron application`. For the desktop app, always use **Option 1** via the GUI.

### Option 3: Via Local Tarball

Pack the repository locally and install the tarball:

```sh
pnpm pack
dsh plugin --profile web add ./dsh-terminal-context-0.1.0.tgz
```

---

## How It Works

### 1. Structured Reference Injection (Three Fallback Layers)

Injecting a native reference chip requires dispatching the session-scoped event `slash/input-insert-reference`. The payload's `span` must carry the current draft revision (`draftRev`) for the host's compare-and-swap check, and `reference.source` must match a recognized core source identifier.

To reliably obtain insertion and cursor context across versions, the plugin attempts three paths in order:

1. **Slot Bridge (Primary)**: Registers a headless UI component into the declared list slot `conversation.input.dock` (where core `todo` and `queue` widgets live). This component receives standard `inputActions` containing `captureInsertion` and `insertText` for the active conversation.
2. **Direct Service**: Calls `ctx.get('conversation').input.for(scope)` to resolve the active composer session.
3. **Plain Text Degradation (Fallback)**: If the host's CAS validation rejects structured injection (returns `false`), the plugin falls back to inserting `@relative/path ` as plain text, which DSH still renders as a folder reference.

### 2. Selection Extraction & Highlight Layer Reconstruction

| Extraction Path | When Triggered | Precision |
|---|---|---|
| **xterm DOM Selection** | Browser selection remains readable | Exact character match |
| **Highlight Geometry Reconstruction** | Browser selection has collapsed on mouse-up | Full line extraction (errs on inclusion) |

By the time the mouse button is released over xterm, browser selections often collapse to `collapsed: true` (reporting zero-width bounding rects), returning empty strings from `window.getSelection()`. However, xterm's grey highlight on the `.xterm-selection` layer remains active.

The plugin inspects the positioned highlight divs in `.xterm-selection`, maps their vertical ranges to covered lines, and extracts text directly from corresponding `.xterm-rows` nodes. This design ensures user-selected content (such as multiline shell commands or stack traces) is never accidentally truncated by character-column rounding errors.

---

## Repository Structure

| File | Purpose |
|---|---|
| `lib/client.js` | Client-side bundle (`window.__ModuleLoader__.load` format): selection tracking, composer docking, shortcut management, and reference injection |
| `lib/index.js` | Host-side Node.js module: provides `/capture` (writing files), `/sweep` (retention pruning), and `/diag` (logging) HTTP endpoints |
| `cordis.patch.yml` | Cordis bundle manifest declaring the runtime plugin entry |
| `test-host.mjs` | Offline host unit test suite (mocking WebServer, Sessions, and edge cases) |
| `test-client.mjs` | Offline browser unit test suite (mocking DOM, Lexical composer, and xterm events) |

---

## Verification & Testing

Offline tests run without a live DSH runtime:

```sh
node test-host.mjs lib/index.js     # Validates routing, workspace jail security, and retention limits
node test-client.mjs lib/client.js  # Validates module contracts, event pipelines, fallback paths, and shortcuts
```

---

## Limitations & Security Notes

- **HTTP Route Scope**: The `/capture`, `/sweep`, and `/diag` routes run on DSH's internal `webServer` without a separate authentication token layer. Ensure DSH's Web port binds strictly to the loopback address (`127.0.0.1`); do not expose it directly to public or untrusted local networks.
- **Built-in Sidebar Terminal Only**: Selectors target `[data-sidebar-terminal]` (covering native terminals and `dsh-better-sidebar` v0.19.0+). The plugin does not rely on private terminal APIs.
- **Explicit Trigger Only**: DSH intentionally keeps terminal session activity out of agent transcripts (per `dsh-api-terminal-controller` conventions). The plugin never logs terminal activity in the background; it acts strictly when a user selects text and triggers an action.
- **Automatic Retention Pruning**: Captures are written to `<workspace>/.dsh/term-captures/terminal-<timestamp>.txt`. The host automatically prunes captures, keeping only the 20 most recent files. Files typically occupy 0.5–6 KB each. If your workspace uses Git, add `.dsh/` to your root `.gitignore`.
- **Diagnostic Logging**: Packaged desktop builds do not allow opening DevTools. Runtime events and errors are recorded via `/diag` into `$DSH_HOME/dsh-terminal-context-diag.json` (capped at the 200 most recent entries, max 4MB) to facilitate headless troubleshooting.

---

## License

Released under the [MIT License](LICENSE).
