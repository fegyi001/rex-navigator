import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lookup = spawnSync("/bin/sh", ["-c", "command -v rex"], { encoding: "utf8" });
assert.equal(lookup.status, 0, "Rex is required for embedded-Lua integration tests");
export const realRex = lookup.stdout.trim();
export function testCommandPath(name) {
  const result = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", name], { encoding: "utf8" });
  assert.equal(result.status, 0, `Test executable unavailable: ${name}`);
  return result.stdout.trim();
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function createLuaFixture(t) {
  const scratch = join(tmpdir(), "opencode");
  mkdirSync(scratch, { recursive: true });
  const home = realpathSync(mkdtempSync(join(scratch, "rex-lua-test-")));
  const bin = join(home, "fake-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "rex"), `#!/bin/sh
if [ "\${1-}" = --autostart=false ]; then shift; fi
if [ "\${1-}" = do ] && [ "\${3-}" = --args ]; then
  export TEST_LUA_ENTRY="$2"
  export TEST_EMBEDDED_PID=$$
  exec ${quote(realRex)} --autostart=false do ${quote(join(root, "tests/helpers/rex-lua-driver.lua"))} --args "$4"
fi
if [ "\${TEST_PURE_API-}" = 1 ] && [ "\${1-}" = do ]; then
  export TEST_LUA_ENTRY="$2"
  export TEST_EMBEDDED_PID=$$
  shift 2
  exec ${quote(realRex)} --autostart=false do ${quote(join(root, "tests/helpers/rex-lua-driver.lua"))} "$@"
fi
if [ "\${TEST_PURE_API-}" = 1 ] && [ "\${1-}" = -C ] && [ "\${4-}" = session.select ]; then
  export TEST_SELECTED_CLIENT="$2"
  export TEST_SELECTED_TARGET="\${5#session_id=}"
  export TEST_LUA_ENTRY=${quote(join(root, "tests/helpers/rex-pure-client.lua"))}
  exec ${quote(realRex)} --autostart=false do ${quote(join(root, "tests/helpers/rex-lua-driver.lua"))} --args '{}'
fi
if [ "\${TEST_PURE_API-}" = 1 ] && [ "\${1-}" = session ] && [ "\${2-}" = inspect ]; then
  printf '{"windows":[]}\\n'
  exit 0
fi
echo 'Live Rex operation forbidden by offline Lua test executable' >&2
exit 1
`, { mode: 0o755 });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    TEST_HOME: home,
    TEST_LUA_ROOT: root,
    TEST_LUA_HOME: home,
    PATH: `${bin}:${process.env.PATH || "/usr/bin:/bin"}`,
    // rex do initializes its existing-server connection before running even a local script.
    // Keep that endpoint while isolating all script files/state; the driver forbids live calls.
    REX_RUNTIME_DIR: process.env.REX_RUNTIME_DIR || join(process.env.HOME, "Library/Application Support/rex"),
  };
  for (const name of ["REX_SERVER", "REX_SESSION", "REX_BLOCK", "REX_CLIENT"]) delete env[name];
  const argv = (entry, args) => [
    "--autostart=false", "do", join(root, "tests/helpers/rex-lua-driver.lua"),
    "--args", JSON.stringify({ ...args, entry: resolve(root, entry), root, home }),
  ];
  return {
    home,
    env,
    run(entry, args = {}, overrides = {}) {
      return spawnSync(realRex, argv(entry, args), {
        env: { ...env, ...overrides }, encoding: "utf8", timeout: 8000, maxBuffer: 1024 * 1024,
      });
    },
    spawn(entry, args = {}, overrides = {}) {
      return spawn(realRex, argv(entry, args), { env: { ...env, ...overrides } });
    },
    operations() {
      const path = join(home, "operations.jsonl");
      return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    },
  };
}
