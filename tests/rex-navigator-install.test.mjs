import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createLuaFixture, realRex } from "./helpers/rex-lua-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const obsoleteRoot of [false, true]) {
  test(`symlinked plugin discovers its own workers${obsoleteRoot ? " even when an obsolete root option is supplied" : " without a dotfiles checkout"}`, (t) => {
    const home = mkdtempSync(join(tmpdir(), "opencode/navigation-install-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const plugin = join(home, "plugin ' café\nroot");
    mkdirSync(plugin);
    for (const name of ["init.lua", "lua", "scripts"]) {
      cpSync(join(root, name), join(plugin, name), { recursive: true });
    }
    symlinkSync(plugin, join(home, "rex-navigator"));
    const script = `
package.path = arg[1] .. "/?.lua;" .. arg[1] .. "/?/init.lua;" .. package.path
local actions = {}
rex = { action = function(a) actions[a.name] = a end, exec = function(argv)
  assert(argv[2] == arg[1] .. "/rex-navigator/scripts/navigation.sh", argv[2])
  assert(argv[3] == "session" and argv[4] == "toggle")
  return { ok = true }
end }
local navigation = require("rex-navigator")
assert(navigation == require("rex-navigator.lua.navigation"), "both imports must share one module")
assert(next(actions) == nil)
navigation.setup(${obsoleteRoot ? '{ root = "/unrelated-plugin-checkout" }' : ""})
actions["rex_navigator_last_used_session"].run({client_id="client:test", session_id="session:test"})
`;
    const result = spawnSync("lua", ["-", home], { input: script, encoding: "utf8", cwd: "/" });
    assert.equal(result.status, 0, result.stderr);
  });
}

test("Rex accepts the plugin action names and bindings without reloading its configuration", (t) => {
  const f = createLuaFixture(t);
  const config = join(f.home, "config/rex");
  mkdirSync(config, { recursive: true });
  symlinkSync(root, join(config, "rex-navigator"));
  const init = join(config, "init.lua");
  writeFileSync(init, `
require("rex-navigator").setup({ window = { width = 0.8, height = 0.5 } })
rex.bind("ctrl+a>f", "rex_navigator_create_session")
rex.bind("ctrl+a>space", "rex_navigator_switch_session")
rex.bind("ctrl+a>enter", "rex_navigator_last_used_session")
`);
  const result = spawnSync(realRex, ["--autostart=false", "config", "check", init], {
    env: f.env, cwd: "/", encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /actions:\s+3/);
  assert.match(result.stdout, /bindings:\s+3/);
});
