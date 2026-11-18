import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fixture(t) {
  mkdirSync(join(tmpdir(), "opencode"), { recursive: true });
  const home = realpathSync(mkdtempSync(join(tmpdir(), "opencode/rex-check-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const checkout = join(home, "quoted ' checkout");
  const bin = join(home, "bin");
  for (const directory of [bin, ...["lua/navigation", "scripts", "tests/helpers", "tests/standalone"].map(path => join(checkout, path))]) {
    mkdirSync(directory, { recursive: true });
  }
  cpSync(join(root, "scripts/check.sh"), join(checkout, "scripts/check.sh"));
  for (const path of ["init.lua", "lua/navigation/config.lua", "scripts/navigation.lua", "tests/helpers/probe.lua"]) {
    writeFileSync(join(checkout, path), "return {}\n");
  }
  writeFileSync(join(checkout, "scripts/worker.sh"), "#!/bin/sh\nexit 0\n");
  for (const path of ["tests/standalone/core.test.mjs", "tests/rex-navigator-window.test.mjs"]) {
    writeFileSync(join(checkout, path), "");
  }
  const lookup = spawnSync("/bin/sh", ["-c", "command -v luac"], { encoding: "utf8" });
  assert.equal(lookup.status, 0, lookup.stderr);
  writeFileSync(join(bin, "luac"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$TEST_LOG/luac"\nexec "$TEST_LUAC" "$@"\n', { mode: 0o755 });
  writeFileSync(join(bin, "sh"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$TEST_LOG/sh"\nexec /bin/sh "$@"\n', { mode: 0o755 });
  // Record the test invocation rather than recursively running this test file.
  writeFileSync(join(bin, "node"), '#!/bin/sh\npwd > "$TEST_LOG/cwd"\nprintf "%s\\n" "$@" > "$TEST_LOG/node"\n', { mode: 0o755 });
  symlinkSync("/usr/bin/true", join(bin, "lua"));
  return {
    checkout,
    bin,
    log(name) { return readFileSync(join(home, name), "utf8").trim().split("\n"); },
    tested() { return existsSync(join(home, "node")); },
    run() {
      return spawnSync("/bin/sh", [join(checkout, "scripts/check.sh")], {
        cwd: home, encoding: "utf8", timeout: 5000,
        env: { ...process.env, PATH: bin, TEST_LOG: home, TEST_LUAC: lookup.stdout.trim() },
      });
    },
  };
}

test("local checks find the checkout and invoke only server-free tests", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.deepEqual(f.log("cwd"), [f.checkout]);
  assert.deepEqual(f.log("node"), ["--test", "tests/standalone/core.test.mjs", "tests/rex-navigator-window.test.mjs"]);
  assert.deepEqual(f.log("sh"), ["-n", "scripts/check.sh", "-n", "scripts/worker.sh"]);
  assert.deepEqual(f.log("luac"), ["-p", "init.lua", "-p", "lua/navigation/config.lua", "-p", "scripts/navigation.lua", "-p", "tests/helpers/probe.lua"]);
});

for (const [name, path, source] of [
  ["shell", "scripts/worker.sh", "if then\n"],
  ["Lua", "lua/navigation/config.lua", "local =\n"],
]) {
  test(`local checks stop on invalid ${name} before running tests`, (t) => {
    const f = fixture(t);
    writeFileSync(join(f.checkout, path), source);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /syntax|unexpected|expected/i);
    assert.equal(f.tested(), false);
  });
}

test("local checks explain missing development tools", (t) => {
  const f = fixture(t);
  rmSync(join(f.bin, "luac"));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /luac/);
  assert.equal(f.tested(), false);
});
