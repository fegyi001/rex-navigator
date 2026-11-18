# Rex navigator

<a href="https://www.superlogical.com">
  <img src="assets/rex-logo.png" alt="Rex Beta logo" width="128" height="128">
</a>

## What is Rex?

[Rex](https://www.superlogical.com/rex/docs) is a terminal multiplexer from
[Superlogical](https://www.superlogical.com).

You can customize Rex with Lua configuration, keybindings, and custom actions, or
automate it through its CLI and server API. Rex is currently in beta; see the
[official documentation](https://www.superlogical.com/rex/docs) for usage and the
[installation guide](https://www.superlogical.com/rex/docs/installation) for current
platform availability.

## What does Rex navigator add?

Rex navigator is an unofficial Lua extension for Rex. It adds fuzzy session and
project pickers, last-used session switching, and read-only terminal previews in
focused floating panes. You configure it through `require("rex-navigator").setup()`
in your Rex `init.lua` and open its actions with your chosen keybindings.

**The Rex action keybindings in this README are examples, not plugin defaults.**
Bind the actions to any keys or key sequences supported by Rex in your `init.lua`.
The examples use **Ctrl+A as a prefix key**, matching the author's previous tmux
configuration: press **Ctrl+A**, release it, then press the next key.
For example, **Ctrl+A → f** means Ctrl+A followed by lowercase `f`.

All navigation logic runs in **Rex's embedded Lua**, with fzf for the interface.
You do not need Node.js, a standalone Lua installation, npm packages, or a build
step to use it. This project is not an official Superlogical product or Rex plugin
format. The Rex logo above identifies the application this extension works with.

### Project picker

With the example keybindings below, press **Ctrl+A → f** to open the project picker.
Type to filter your configured project directories, then press **Enter** to create
or reuse the project's Rex session and switch to it. Press **Esc** to cancel.

![Project picker showing project directories in a floating Rex pane](assets/project-picker.png)

### Session picker

With the example keybindings below, press **Ctrl+A → Space** to open the session picker.
Filter existing sessions by name and view a read-only terminal preview on the
right. The last-used session appears first, marked `(last used)`. Press **Enter**
to switch, or **Esc** to cancel.

![Session picker showing the last-used session and a terminal preview](assets/session-picker.png)

## Layout

```text
rex-navigator/
├── README.md
├── init.lua             # Public require("rex-navigator") entrypoint
├── lua/
│   └── navigation/       # Importable navigation module
│       ├── init.lua      # setup(): register actions, no bindings
│       ├── config.lua    # Project settings validation and optional file loading
│       ├── sessions.lua  # Picker ordering and shared history
│       ├── projects.lua  # Project discovery and session reuse/creation
│       ├── preview.lua   # Bounded read-only snapshots
│       ├── runtime.lua   # Rex/process/filesystem adapters
│       ├── json.lua      # Strict state/worker-transport JSON handling
│       ├── text.lua      # UTF-8 and terminal-control sanitation
│       └── text-data.lua # Checked-in Unicode property ranges
├── scripts/             # Short-lived Lua workers and POSIX bootstraps
│   ├── navigation.sh     # CLI parsing and Rex lookup
│   ├── navigation.lua    # Session/project dispatch and errors
│   ├── transaction.lua  # Locked state-changing worker
│   ├── lock-transaction.sh
│   ├── process-group.sh # Bounded worker/descendant cleanup
│   ├── session-preview.lua
│   └── snapshot.lua
└── tests/               # Isolated behavior/integration tests and helpers
```

Personal configuration and keybindings belong to the host. Session history is
kept in the plugin's gitignored `state/` directory; it is never committed.

## Loading and packaging

Clone this repository anywhere and symlink it under your Rex configuration root:

```sh
git clone <repository-url> ~/code/rex-navigator
ln -s ~/code/rex-navigator ~/.config/rex/rex-navigator
```

For a tracked configuration repository, a Git submodule at the same
`rex-navigator` path can replace the symlink. Use your actual `$XDG_CONFIG_HOME`
instead of `~/.config` if set. Then add setup and your chosen keybindings to the
host `init.lua`:

```lua
require("rex-navigator").setup({
  projects = {
    roots = {
      { path = "~/code", depth = 2 },
    },
    exclude = { "node_modules" },
  },
})

-- Example bindings: Ctrl+A is the prefix; choose your own keys or sequences.
rex.bind("ctrl+a>space", "open_session_picker")
rex.bind("ctrl+a>f", "open_project_picker")
rex.bind("ctrl+a>enter", "last_used_session")
```

Requiring the module alone has no effects. `setup()` registers
`open_session_picker`, `open_project_picker`, and `last_used_session`; the host's
configuration owns bindings. Call setup once per configuration load. An optional
`{ root = "/absolute/path" }` overrides code-root discovery.

Rex uses `>` to separate keys in a sequence: `ctrl+a>f` means **Ctrl+A → f**.
You can change the prefix, use another sequence, or bind an action to a single
shortcut. See Rex's [key sequences](https://www.superlogical.com/rex/docs/customize/key-sequences)
and [keyboard shortcuts](https://www.superlogical.com/rex/docs/customize/keyboard-shortcuts) documentation.

That's the complete plugin setup: **no extra config file, shell command, or PATH
change is required**. The project picker opens through the registered action
(Ctrl+A → f in this example) and receives the settings supplied to `setup()`.

Code and workers resolve their paths relative to their own root, not the current
working directory. Personal settings stay in your host `init.lua`; session history
is stored under the plugin root, and project associations use the host's XDG state path.

The plugin does not bind keys or change existing pane navigation. No plugin
manager or future Rex plugin API is assumed.

## Configuration

Pass your project settings directly to `setup({ projects = ... })` as shown above.
Neither `navigation-config.lua` nor `projects.json` is needed for this installation.

`roots` must be a nonempty list. Paths must be absolute, `~`, or start with `~/`;
`depth` must be a positive integer. Root directories themselves are not candidates:
depth 1 lists their immediate child directories. Missing/unusable roots warn and
are skipped. Hidden directories and directory symlinks are always skipped.
`exclude` is a list of directory names, at any traversal depth. Omitting it uses
`node_modules`, `vendor`, and `__pycache__`; `{}` explicitly disables those defaults.

Settings are validated during setup and copied directly to the short-lived
project worker; no generated configuration file is written. Reload your Rex
configuration after editing them. There are no machine-specific roots bundled
with the plugin. Session-only actions do not need project settings.

### Optional file-based configuration

This is an alternative, **not an installation requirement**. If you prefer to
keep settings in a file, use:

```lua
require("rex-navigator").setup({
  config = "/absolute/path/navigation-config.lua",
})
```

The trusted Lua file must return `{ projects = { roots = ..., exclude = ... } }`.
It is executed when discovery starts; invalid or missing configuration fails
before project operations. With neither `projects` nor `config` supplied, discovery
looks for `$XDG_CONFIG_HOME/rex/navigation-config.lua`, defaulting to
`~/.config/rex/navigation-config.lua`. Inline `projects` always takes precedence.

## Actions and example keybindings

The following bindings refer to the example configuration above. The plugin
registers action names; you choose their bindings and whether to use a prefix.

- **`open_session_picker`** (example: **Ctrl+A → Space**) opens an fzf session picker
  in a focused floating pane over
  the invoking tab, centered at 70% of its width and 60% of its height. It creates
  no temporary tab. The current session is excluded; the last-used destination
  comes first, marked `(last used)`, followed by other sessions alphabetically,
  ignoring case. The left half lists sessions; the right half
  previews a terminal text snapshot. Typing ranks matches by fuzzy relevance;
  clearing the query restores last-used-first order.
  Esc cancels and closes the pane; selecting a session switches and closes it.
- **`open_project_picker`** (example: **Ctrl+A → f**) opens the project picker
  in the same centered, focused 70% × 60%
  floating pane. Esc cancels; opening a project closes the pane after creating
  or reusing its session and switching to it. No temporary tab is created.
- **`last_used_session`** (example: **Ctrl+A → Enter**) toggles the last two sessions
  selected through either picker.

Existing pane-navigation bindings stay under your control. For example, the
author uses **Ctrl+A → l** for right-pane navigation; this plugin does not bind it.

Reload through Rex's **Reload Config** command, or run `rex config reload`, to
activate the Lua action registration. The plugin launches its own workers;
no automatic reload is performed.
Then switch from session A to B with either picker. With the example bindings, press **Ctrl+A → Enter**
twice: it should return to A, then B.

## Requirements

Requirements are `fzf`, a Rex version with the documented `rex.exec.start`/handle
Lua functions, and macOS built-ins including `lockf`, `find`, `sort`, `realpath`,
`openssl`, `mktemp`, and `dd` with `conv=fsync` support. Linux/Windows portability
is not implemented.

The launchers share `scripts/navigation.sh`. Executable lookup checks PATH, Rex's
managed macOS installation, and local/Homebrew locations, since app-launched
actions may have a minimal PATH. It never sources shell startup files.
Session IDs are hidden: the list shows names and the last-used marker only.
Hidden IDs still identify selections safely when names are duplicated; use the
preview to tell identical names apart. fzf's default colors are left unchanged.
Session selection uses
Rex Remote Control, which must be enabled in the app (the project picker
already required it). Errors from the toggle are reported by the Rex action;
picker errors remain visible in their floating pane until Enter is pressed.

## Session snapshots

Highlighting a session starts a read-only snapshot worker for its focused terminal
in its active tab. The preview refreshes on highlight changes, not continuously;
it is text, not an image of the whole session layout. Missing sessions, missing
focus, non-terminal panes, and failed/slow requests show `Preview unavailable`
without preventing selection. If no other sessions exist, the picker reports
`No other sessions available` without changing history.

Snapshots are screen-aware: ordinary shells show recent output, while alternate-
screen apps such as Neovim are shown from the top instead of losing the upper
part of the screen. Use **Ctrl+U / Ctrl+D** to page the preview up/down; these keys
scroll fzf's snapshot only and never send input to the target terminal. The preview
is plain text, not a rescaled screenshot, so wide editor layouts may not fit.

Previews do not run before the list opens. A worker waits 75 ms for navigation to
settle, has a two-second work budget, and terminates pending Rex children when
cancelled. It retrieves a bounded 32 KiB tail for shell output, or a head with a
32 KiB encoded-byte budget for alternate screens, rather than downloading all
scrollback. Shell output is capped to 200 lines and the available preview rows;
alternate-screen output keeps up to 200 lines for scrolling and shows
`[Preview truncated]` if byte/line limits cut it short. Terminal control sequences
are stripped. No snapshots are cached on disk, and previewing never switches
sessions, sends input, or writes history.

Snapshot RPCs use attach-aware Rex CLI reads with bounded stdout/stderr capture;
native generic Lua RPC has no response-byte limit. Short-lived process groups and
an owner-liveness guard clean up descendants even when Rex exits before signaling
them. The guard checks every 50 ms while a bounded command runs; it is not a
persistent daemon. Cleanup can finish shortly after the preview's Rex CLI exits.

These limits bound client transfer and display, **not Rex's internal formatting
cost**: Rex may still format full scrollback before returning a bounded result.
Actual UI responsiveness and preview cancellation need manual confirmation in
the app; regression tests use fake terminal data and installed fzf.

## History and limits

The picker's first item uses the same remembered destination as the last-used
toggle. If that target is missing/closed, history is missing/unreadable/ambiguous,
or the optional host-status lookup fails, the list stays alphabetical. Opening
the picker only reads an atomic history snapshot without locking or rewriting it.
When nonempty history exists, ordering adds at most one host-status request with
a 500 ms timeout; no ordering-status request is made without history. Switch-time
validation is still strict: malformed history is never silently overwritten.

`lua/navigation/sessions.lua` stores session IDs (not names) in
`state/session-history.json` under the plugin root. Its lock lives alongside it as
`state/session-history.lock`; `/state/` is ignored by Git. The checkout must be
writable. Moving the plugin directory moves its history too, and separate checkouts
have independent histories. History is separated by host and written atomically
under a file lock. All apps using the same checkout and connected to the same host share
one last-used pair, so restarting the app or changing its connection ID does not
reset history. The current client ID is used only to address the connected app.
Kernel locking uses the same lock file and automatically releases when the actual
transaction worker exits. If its coordinator dies while the worker is still
running, the lock remains held rather than admitting a concurrent writer.
Renaming a session is safe. Writes use a private same-directory temporary file,
file fsync, then atomic rename; malformed state is never silently repaired.

New pairs are saved as the host's `shared` entry. Older per-client entries,
including Python-created history, are retained. Before a shared entry exists,
the toggle recovers an old pair only when it contains the invoking session and
all eligible pairs agree on one still-existing destination. Conflicting histories
require a picker selection rather than guessing which is newest. Recovery is
saved only after a successful switch; no standalone migration is needed. Once a
shared entry exists it is authoritative, even if its remembered session closes.

Cancelling the picker or selecting the current session leaves history alone.
If the remembered session was closed, or no history exists yet, the toggle
reports an error; choose another session with a picker to establish a new pair.
While a switch is in progress, another toggle reports a busy error instead of
queuing a second operation with a potentially stale source session. Wait for
the first switch to finish before toggling again.

Rex does not expose a selected-session-change event. Sidebar clicks, the native
session picker, and native next/previous actions do **not** update this history.
After such a switch, the toggle returns to the most recently tracked session,
then alternates with the session it was invoked from.

The helper operates on the local Rex server, matching the project picker;
multiple server instances sharing one configuration directory are not supported.
There is no persistent background process, and merely opening or cancelling either
picker does not record a switch. Case-insensitive Unicode ordering uses macOS's
locale-aware sort and can differ slightly from the old Node/ICU punctuation or
accent ordering; equal labels use hidden full IDs as deterministic ties.

## Project directories

The `open_project_picker` action uses `lua/navigation/projects.lua`;
the action receives the project settings from `setup()`.
Roots accept absolute paths or `~/...`; their depth limits traversal.
Hidden directories, excluded directory names, files, and directory symlinks are
not offered. Overlapping roots are canonicalized and deduplicated.

The picker reuses the project/session associations in
`$XDG_STATE_HOME/rex/project-sessions.json` (default `~/.local/state/rex`).
Existing Python-created associations are read without conversion. If an association
is stale or missing, local terminal working directories are checked before a new
session is created; ambiguous matches require manual selection. Creation and
registry updates are locked to avoid duplicate sessions during concurrent opens.
Project opens wait up to 20 seconds for the registry lock rather than wait indefinitely.
An association survives a refused switch, so retrying does not duplicate the session.
Session matching explicitly attaches the worker's temporary Lua inspection stream,
reads its layout/cwd metadata through native Lua, then detaches even if a read
fails. It never changes the app's selected session. Generic
`rex.call("session.view", ...)` without attachment would fail with a 409 conflict.
Canonical cwd results are cached only for that one scan, not across project opens.

## Tests

From this repository root, run:

```sh
node --test --test-concurrency=2 tests/*.test.mjs
```

Node is a **development-only test runner**, not a production dependency. The suites
run real Lua modules/workers inside Rex, isolated fake API/client responses, temporary
project/state files, real kernel-lock contention, installed fzf, and private PTYs.
The no-Node launcher suite uses shell/Lua fakes and poisons Node startup (including an
absolute Node executable) to catch hidden runtime dependencies.

Development prerequisites: Node.js with the built-in test runner, Rex, fzf, a
standalone `lua` for the offline action/install harnesses, and the same macOS tools
as production. No npm dependencies need installing. Test-file concurrency is
limited because process-start timing assertions become noisy when many separate
Rex runtimes are started simultaneously; all assertions still run.

Embedded-Lua tests require an already-running Rex for its initial CLI connection;
autostart is disabled and fake adapters forbid live session/client operations.
Standalone Lua is used by the offline action/install harnesses only.
Tests do not create, select, capture, or modify live sessions. Real-app appearance,
remote-control permissions, and live interaction still need manual confirmation.

`text-data.lua` is checked in. Its Unicode version is recorded in its header; the
offline generator is `tools/generate-rex-unicode.mjs`. It is not run at startup.

## License

Code and documentation are available under the [MIT license](LICENSE).
The Rex logo in `assets/rex-logo.png` is a third-party asset from Superlogical and
is not covered by this license.
