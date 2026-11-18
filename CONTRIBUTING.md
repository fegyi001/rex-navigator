# Contributing

Keep changes focused and preserve the public `setup()` interface, worker argument
handling, and existing history/registry formats unless a change explicitly calls
for a migration. Production code uses Rex's embedded Lua and macOS shell tools;
Node.js and standalone Lua are development tools, not plugin runtime dependencies.

## Quick local checks

Install Node.js and standalone Lua, including its `luac` compiler, then run:

```sh
sh scripts/check.sh
```

The script checks Lua and shell syntax, then runs the server-free tests. It does
not need Rex, a running server, fzf, npm packages, or network access. You can also
invoke it by absolute path from another working directory.

To run just the server-free tests:

```sh
node --test tests/standalone/*.test.mjs tests/rex-navigator-window.test.mjs
```

These tests exercise real configuration validation, Unicode/control handling,
history-selection logic, and action construction. Only the external action/layer
registration interfaces are replaced for action tests. A relocated-checkout test
runs with only Lua in PATH to guard against accidental Rex dependencies.

Standalone Lua is not a substitute for Rex's embedded runtime. JSON transport,
process handles, filesystem adapters, locks, and PTYs remain integration tests.

## Rex integration tests

On macOS, install Rex, fzf, Node.js, and standalone Lua, plus the tools listed in
the README's [requirements](README.md#requirements). Start Rex, then run:

```sh
node --test --test-concurrency=2 tests/*.test.mjs
```

Run both test commands before proposing a change. The integration command does not
include `tests/standalone/`. Keep test-file concurrency at 2 to reduce process-start
timing noise. A server connection is required even for local `rex do` scripts;
the harness disables autostart, isolates state, and rejects live session/client
operations rather than changing your open sessions.

The suite exercises the embedded Lua workers, real kernel locks, subprocess
cancellation, fzf, and private PTYs. Preserve those tests when simplifying test
fixtures; a mock cannot establish process-cleanup or locking behavior.

## Tested environment

The local checks and integration suite were verified on November 18, 2026 with:

| Tool | Tested version |
| --- | --- |
| macOS | 27.2.1 |
| Rex | 0.1.0-preview.20, API revision 16 |
| fzf | 0.75.0 (Homebrew) |
| Node.js | 26.13.0 |
| Standalone Lua / luac | 5.5.1 |

These are observed working versions, **not minimum supported versions** or a
compatibility guarantee for other releases. Rex supplies its own embedded Lua;
the standalone Lua version above is for development checks only. Include your
tool versions and the failing command when reporting a problem. The plugin
remains macOS-only; server-free tests do not establish support for other systems.

## Style and generated data

- Lua: two spaces, 120-column target; follow `stylua.toml` (Lua 5.1 syntax).
- Shell: POSIX `/bin/sh`, quote paths and arguments, and do not source user shell
  startup files.
- Tests: use Node's built-in test runner and existing fixture conventions. Prefer
  standalone tests for pure logic and embedded-Rex tests for runtime behavior.

StyLua is optional development tooling. If installed, check formatting with:

```sh
stylua --check init.lua lua scripts tests/helpers
```

`scripts/check.sh` does not install or run formatters. Do not edit the generated
Unicode ranges in `lua/navigation/text-data.lua` by hand. To regenerate them:

```sh
node tools/generate-rex-unicode.mjs > lua/navigation/text-data.lua
```

Node's Unicode version determines the generated categories. Use a matching
Unicode version for reproducible output, or explain an intentional data update
in the change; the generated file records that version in its header.

## Manual app checks

Automated tests do not establish visual appearance or Remote Control permissions.
For changes affecting actions, selection, or previews, check in the Rex app:

- Both pickers open centered in the invoking tab, focus correctly, and close on
  selection or Esc. Errors stay visible until dismissed.
- Session selection and last-used toggling target the invoking app; refused
  Remote Control produces an understandable error.
- Project selection reuses an existing association and does not create duplicates.
- Shell and alternate-screen previews look reasonable; rapid highlight changes
  remain responsive, and unavailable previews do not prevent selection.

Mention checks you could not perform. Do not reload someone else's configuration,
close sessions, or change Remote Control permissions as part of automated tests.
