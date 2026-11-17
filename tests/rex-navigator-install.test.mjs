import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("symlinked plugin imports and launches root-relative navigation without a dotfiles checkout", (t) => {
  const home = mkdtempSync(join(tmpdir(), "opencode/navigation-install-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const plugin = join(home, "plugin ' café\nroot");
  cpSync(root, plugin, { recursive: true, filter: (path) => !path.includes("/.git") && !path.includes("/tests") });
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
navigation.setup()
actions.last_used_session.run({client_id="client:test", session_id="session:test"})
`;
  const result = spawnSync("lua", ["-", home], { input: script, encoding: "utf8", cwd: "/" });
  assert.equal(result.status, 0, result.stderr);
});
