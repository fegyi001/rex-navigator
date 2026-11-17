import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createLuaFixture, realRex } from "./helpers/rex-lua-fixture.mjs";

for (const cancel of [false, true]) {
  test(`foreground Lua/fzf/private-PTY preview integration (${cancel ? "cancel" : "accept"})`, async (t) => {
    const f = createLuaFixture(t);
    const root = process.cwd();
    const args = { root, home: f.home, entry: join(root, "tests/helpers/rex-pty-probe.lua"), cancel };
    // macOS script needs an anonymous pipe, not Node's socket-backed stdin or a
    // named FIFO. Hold it open until fzf has actually completed, not for a fixed delay.
    const holdInput = 'owner=$$; (i=0; while kill -0 "$owner" 2>/dev/null && [ ! -f "$TEST_HOME/pty-done" ] && [ "$i" -lt 500 ]; do /bin/sleep 0.01; i=$((i+1)); done) | "$@"';
    const child = spawn("/bin/sh", ["-c", holdInput, "sh", "/usr/bin/script", "-q", join(f.home, "pty.typescript"), "/bin/sh", "-c",
      'stty cols 100 rows 30; exec "$@"', "sh", realRex, "--autostart=false", "do",
      join(root, "tests/helpers/rex-lua-driver.lua"), "--args", JSON.stringify(args),
    ], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGHUP"), 6000);
    t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGHUP"); });
    const code = await new Promise(resolve => child.once("close", resolve));
    assert.equal(code, 0, output.slice(-2000));
    const match = output.match(/\{"code":\d+,"selection":"(?:[^"\\]|\\.)*"\}/);
    assert.ok(match, output.slice(-2000));
    assert.deepEqual(JSON.parse(match[0]), { code: cancel ? 130 : 0, selection: cancel ? "" : "session:a\tAlpha ' café\0" });
    assert.equal(readFileSync(join(f.home, "pty-preview"), "utf8"), "rendered");
  });
}
