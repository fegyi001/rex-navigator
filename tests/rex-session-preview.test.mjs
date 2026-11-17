import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installLegacyLua } from "./helpers/rex-legacy-lua.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

function fixture(t) {
  const scratch = join(tmpdir(), "opencode");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "rex-preview ' "));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const configFile = join(home, "config.json");
  const config = {
    screen: "primary",
    text: "old line\nlatest line\n",
    view: { revision: 1, session_id: "session:a", active_window_id: "window:active", windows: [
      { window_id: "window:other", focused_block_id: "block:other", layers: [{ blocks: [{ block_id: "block:other", creator_name: "com.superlogical.terminal" }] }] },
      { window_id: "window:active", focused_block_id: "block:focus", layers: [{ blocks: [
        { block_id: "block:unfocused", creator_name: "com.superlogical.terminal" },
        { block_id: "block:focus", creator_name: "com.superlogical.terminal" },
      ] }] },
    ] },
  };
  const fake = join(home, "fake-rex.mjs");
  writeFileSync(fake, `
    import fs from "node:fs";
    import {setTimeout as delay} from "node:timers/promises";
    const cfg = JSON.parse(fs.readFileSync(process.env.TEST_CONFIG, "utf8"));
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.TEST_HOME + "/calls.jsonl", JSON.stringify({args, server: process.env.REX_SERVER}) + "\\n");
    const stage = args[0] === "api" ? "view" : args[6];
    if (cfg.delayStage === stage) {
      fs.writeFileSync(process.env.TEST_HOME + "/child.pid", String(process.pid));
      await delay(60000);
    }
    if (cfg.refuse) { console.error("private server error"); process.exit(1); }
    if (cfg.malformed) { console.log("not JSON"); process.exit(0); }
    if (cfg.hugeReply) { console.log("x".repeat(400000)); process.exit(0); }
    if (cfg.failModes && stage === "modes") { console.error("modes unavailable"); process.exit(1); }
    let result;
    if (args.slice(0, 3).join(" ") === "api call session.view") {
      if (JSON.parse(args[3]).session_id !== "session:a") process.exit(2);
      result = cfg.view;
    } else if (args.slice(0, 6).join(" ") === "block call -s session:a -b block:focus") {
      const options = JSON.parse(args[7]);
      const bytes = Buffer.from(cfg.text);
      if (args[6] === "modes") {
        result = cfg.modesReply ?? {screen: cfg.screen, modes: []};
      } else if (args[6] === "format") {
        result = cfg.formatReply ?? (bytes.length > 4096
          ? {content: "old prefix", id: 0, total: bytes.length, eof: false}
          : {content: cfg.text, eof: true});
      } else if (args[6] === "blob_read") {
        // Model a byte offset splitting a multibyte character; the partial
        // leading line must be discarded by the real helper.
        const points = Array.from(bytes.subarray(options.offset).toString("utf8"));
        let count = 0, encoded = 2;
        while (count < points.length) {
          const next = Buffer.byteLength(JSON.stringify(points[count])) - 2;
          if (encoded + next > options.max_bytes) break;
          encoded += next;
          count++;
        }
        result = cfg.blobReply ?? {data: points.slice(0, count).join(""), id: 0, total: bytes.length, eof: count === points.length};
      } else process.exit(3);
    } else { console.error("Unexpected command " + JSON.stringify(args)); process.exit(4); }
    console.log(JSON.stringify(result));
  `);
  writeFileSync(join(bin, "rex"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), PATH: `${bin}:/usr/bin:/bin`, TEST_CONFIG: configFile, TEST_HOME: home, FZF_PREVIEW_LINES: "24" };
  const lua = installLegacyLua({ home, bin, env, fakeRex: fake, root });
  const update = () => writeFileSync(configFile, JSON.stringify(config));
  const run = (id = "session:a", overrides = {}) => {
    update();
    const [executable, argv] = lua.script("scripts/session-preview.lua", { session: id });
    const result = spawnSync(executable, argv, { env: { ...env, ...overrides }, encoding: "utf8", timeout: 6000 });
    return result;
  };
  const calls = () => existsSync(join(home, "calls.jsonl")) ? readFileSync(join(home, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
  const ok = (result) => assert.equal(result.status, 0, result.stderr || String(result.error));
  return { home, config, env, update, run, calls, ok, lua };
}

test("snapshot reads only the active tab's focused terminal and ignores REX_SERVER", (t) => {
  const f = fixture(t);
  const result = f.run();
  f.ok(result);
  assert.equal(result.stdout, "old line\nlatest line\n");
  assert.deepEqual(f.calls().map(({ args }) => args.slice(0, 7)), [
    ["api", "call", "session.view", '{"session_id":"session:a"}'],
    ["block", "call", "-s", "session:a", "-b", "block:focus", "modes"],
    ["block", "call", "-s", "session:a", "-b", "block:focus", "format"],
  ]);
  assert.ok(f.calls().every((call) => call.server === undefined));
  const options = JSON.parse(f.calls()[2].args[7]);
  assert.equal(options.format, "text");
  assert.equal(options.trim, true);
  assert.ok(options.max_bytes > 0 && options.max_bytes <= 32768);
  assert.equal(existsSync(join(f.home, "config/rex/state/session-history.json")), false);
});

test("large Unicode scrollback reads one bounded recent blob tail, not the whole result", (t) => {
  const f = fixture(t);
  f.config.text = "old history\n" + "é中🙂".repeat(20000) + "\nrecent café 中文\nlast line\n";
  const result = f.run();
  f.ok(result);
  assert.equal(result.stdout, "recent café 中文\nlast line\n");
  const calls = f.calls();
  assert.equal(calls.length, 4);
  assert.equal(calls[3].args[6], "blob_read");
  const options = JSON.parse(calls[3].args[7]);
  assert.equal(options.id, 0);
  assert.equal(options.offset, Buffer.byteLength(f.config.text) - 32768);
  assert.ok(options.max_bytes <= 196608);
});

test("snapshot strips escape/control sequences and respects available rows", (t) => {
  const f = fixture(t);
  f.config.text = "old\n\u001b[31mred\u001b[0m\n\u001b]52;c;payload\u0007safe\u0000\u0008\nend\n";
  const result = f.run("session:a", { FZF_PREVIEW_LINES: "3" });
  f.ok(result);
  assert.equal(result.stdout, "red\nsafe\nend\n");
});

test("snapshot caps output at 200 rows even with enormous preview dimensions", (t) => {
  const f = fixture(t);
  f.config.text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
  const result = f.run("session:a", { FZF_PREVIEW_LINES: "999999" });
  f.ok(result);
  assert.equal(result.stdout.trimEnd().split("\n").length, 200);
  assert.match(result.stdout, /^line 100\n/);
  assert.match(result.stdout, /line 299\n$/);
});

test("alternate editor screen retains all 49 rows even with a 24-row preview", (t) => {
  const f = fixture(t);
  f.config.screen = "alternate";
  f.config.text = Array.from({ length: 49 }, (_, i) => `EDITOR SCREEN ROW ${i + 1}`).join("\n");
  const result = f.run("session:a", { FZF_PREVIEW_LINES: "24" });
  f.ok(result);
  assert.equal(result.stdout, f.config.text + "\n");
});

for (const screen of ["primary", "future-unknown-mode"]) {
  test(`${screen} retains recent shell output rather than the top`, (t) => {
    const f = fixture(t);
    f.config.screen = screen;
    f.config.text = "old\nrecent\nnewest\n";
    const result = f.run("session:a", { FZF_PREVIEW_LINES: "2" });
    f.ok(result);
    assert.equal(result.stdout, "recent\nnewest\n");
  });
}

test("chunked alternate screen reads the bounded head and preserves Unicode", (t) => {
  const f = fixture(t);
  f.config.screen = "alternate";
  f.config.text = "EDITOR TOP\n" + Array.from({ length: 48 }, (_, i) => `row ${i}: ${"é中🙂".repeat(20)}`).join("\n") + "\nSTATUS BOTTOM\n";
  const result = f.run("session:a", { FZF_PREVIEW_LINES: "10" });
  f.ok(result);
  assert.equal(result.stdout, f.config.text);
  assert.deepEqual(JSON.parse(f.calls().at(-1).args[7]), { id: 0, offset: 0, max_bytes: 32768 });
});

test("oversized escaped alternate screen keeps complete leading lines and marks truncation", (t) => {
  const f = fixture(t);
  f.config.screen = "alternate";
  f.config.text = "EDITOR TOP\n" + Array.from({ length: 100 }, (_, i) => `row ${i}: ${'é🙂\\"'.repeat(200)}`).join("\n") + "\nBOTTOM MUST BE TRUNCATED\n";
  const result = f.run();
  f.ok(result);
  assert.match(result.stdout, /^EDITOR TOP\nrow 0:/);
  assert.match(result.stdout, /\n\[Preview truncated\]\n$/);
  assert.doesNotMatch(result.stdout, /BOTTOM MUST BE TRUNCATED|\uFFFD/);
  const lines = result.stdout.trimEnd().split("\n");
  assert.ok(lines.length <= 200);
  assert.ok(lines.slice(1, -1).every((line) => /(?:é🙂\\")$/.test(line)), "partial last line leaked");
});

test("alternate screen starts at top and marks a 200-line display limit", (t) => {
  const f = fixture(t);
  f.config.screen = "alternate";
  f.config.text = Array.from({ length: 250 }, (_, i) => `row ${i}`).join("\n");
  const result = f.run();
  f.ok(result);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 200);
  assert.equal(lines[0], "row 0");
  assert.equal(lines[198], "row 198");
  assert.equal(lines[199], "[Preview truncated]");
});

for (const [name, change] of [
  ["no active tab", (c) => { delete c.view.active_window_id; }],
  ["no focused pane", (c) => { delete c.view.windows[1].focused_block_id; }],
  ["nonterminal focus", (c) => { c.view.windows[1].layers[0].blocks[1].creator_name = "com.example.editor"; }],
  ["closed session", (c) => { c.refuse = true; }],
  ["malformed JSON", (c) => { c.malformed = true; }],
  ["oversized CLI reply", (c) => { c.hugeReply = true; }],
  ["invalid format shape", (c) => { c.formatReply = { content: 3 }; }],
  ["modes request failure", (c) => { c.failModes = true; }],
  ["invalid modes reply", (c) => { c.modesReply = []; }],
  ["invalid blob metadata", (c) => { c.formatReply = { content: "partial", id: 0, total: -1 }; }],
  ["incomplete blob tail", (c) => { c.text = "x".repeat(40000); c.blobReply = { id: 0, total: 40000, data: "partial", eof: false }; }],
]) {
  test(`snapshot handles ${name} without falling back or exposing server stderr`, (t) => {
    const f = fixture(t);
    change(f.config);
    const result = f.run();
    f.ok(result);
    assert.match(result.stdout, /^Preview unavailable/);
    assert.doesNotMatch(result.stdout, /private server error/);
    assert.ok(f.calls().length <= 4);
  });
}

for (const id of ["--help", "session:a; touch bad", "session:$(touch bad)", "", "other:a"]) {
  test(`snapshot rejects unsafe or missing session ID ${JSON.stringify(id)} before querying`, (t) => {
    const f = fixture(t);
    const result = f.run(id);
    f.ok(result);
    assert.match(result.stdout, /^Preview unavailable/);
    assert.deepEqual(f.calls(), []);
  });
}

async function waitForExit(pid) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await delay(10);
  }
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("slow snapshot meets deadline and terminates the pending Rex child", async (t) => {
  const f = fixture(t);
  f.config.delayStage = "view";
  const started = Date.now();
  const result = f.run();
  f.ok(result);
  assert.match(result.stdout, /^Preview unavailable/);
  assert.ok(Date.now() - started < 3500, "preview exceeded its total deadline");
  const pid = Number(readFileSync(join(f.home, "child.pid"), "utf8"));
  await waitForExit(pid);
});

for (const stage of ["modes", "format"]) {
test(`terminating an obsolete preview reaps its active ${stage} child`, async (t) => {
  const f = fixture(t);
  f.config.delayStage = stage;
  f.update();
  const [executable, argv] = f.lua.script("scripts/session-preview.lua", { session: "session:a" });
  const child = spawn(executable, argv, { env: f.env, stdio: "ignore" });
  const closed = new Promise((resolve) => child.on("close", resolve));
  let rexPid;
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (rexPid) { try { process.kill(rexPid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; } }
  });
  const marker = join(f.home, "child.pid");
  const deadline = Date.now() + 3000;
  while (!existsSync(marker) && Date.now() < deadline && child.exitCode === null) await delay(10);
  assert.equal(existsSync(marker), true, "preview never reached the pending capture");
  rexPid = Number(readFileSync(marker, "utf8"));
  child.kill("SIGTERM");
  await closed;
  await waitForExit(rexPid);
});
}

for (const id of [-1, 0.5, 9007199254740992, null]) {
  test(`preview rejects unsafe blob IDs before reading data: ${JSON.stringify(id)}`, (t) => {
    const f = fixture(t);
    f.config.formatReply = { content: "prefix", id, total: 40000, eof: false };
    const result = f.run();
    f.ok(result);
    assert.match(result.stdout, /^Preview unavailable/);
    assert.equal(f.calls().some(({ args }) => args[6] === "blob_read"), false);
  });
}
