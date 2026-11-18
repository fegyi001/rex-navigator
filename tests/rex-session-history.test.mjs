import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installLegacyLua } from "./helpers/rex-legacy-lua.mjs";
import { testCommandPath as commandPath } from "./helpers/rex-lua-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "scripts/navigation.sh");
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

function fixture(t) {
  const scratch = join(tmpdir(), "opencode");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "rex-node-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, ".local/bin");
  mkdirSync(bin, { recursive: true });
  const configFile = join(home, "fake-config.json");
  const log = join(home, "selected.jsonl");
  const state = join(home, "plugin/state/session-history.json");
  const config = {
    client: "client:mac", host: "host:local", pickIndex: 0,
    sessions: [
      { session_id: "session:a", label: "Alpha" },
      { session_id: "session:b", label: "Beta" },
      { session_id: "session:c", label: "Gamma" },
    ],
  };
  const update = () => writeFileSync(configFile, JSON.stringify(config));
  update();
  const fakeRex = join(home, "fake-rex.mjs");
  writeFileSync(fakeRex, `
    import fs from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    const cfg = JSON.parse(fs.readFileSync(process.env.TEST_CONFIG, "utf8"));
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.TEST_HOME + "/calls.jsonl", JSON.stringify(args) + "\\n");
    let result;
    if (args.join(" ") === "client ls --json") {
      result = {clients: cfg.noClient ? [] : [{client_id: cfg.client, info: {kind: "app"}, connection_state: "connected"}]};
    } else if (args.join(" ") === "api call server.status {}") {
      if (cfg.statusDelayMs) await delay(cfg.statusDelayMs);
      if (cfg.statusRefuse) { console.error("status unavailable"); process.exit(1); }
      result = {host_id: cfg.host, instance_id: "instance:one"};
    } else if (args.join(" ") === "ls --json") {
      result = {sessions: cfg.sessions};
    } else if (args.slice(0, 3).join(" ") === "api call session.view") {
      result = {revision: 1, session_id: JSON.parse(args[3]).session_id, active_window_id: "window:active", windows: [
        {window_id: "window:active", focused_block_id: "block:preview", layers: [{blocks: [
          {block_id: "block:preview", creator_name: cfg.previewNonterminal ? "com.example.editor" : "com.superlogical.terminal"},
        ]}]},
      ]};
    } else if (args[0] === "block" && args[1] === "call" && args[6] === "modes") {
      result = {screen: "primary", modes: []};
    } else if (args[0] === "block" && args[1] === "call" && args[6] === "format") {
      result = {content: "fake terminal snapshot\\n", eof: true};
    } else if (args[0] === "-C" && args[1] === cfg.client && args[2] === "do" && args[3] === "session.select") {
      if (cfg.refuse) { console.error("Remote Control disabled"); process.exit(1); }
      if (cfg.delayMs) {
        fs.writeFileSync(process.env.TEST_HOME + "/select-started", String(process.pid));
        await delay(cfg.delayMs);
      }
      fs.appendFileSync(process.env.TEST_HOME + "/selected.jsonl", JSON.stringify(args[4]) + "\\n");
      result = null;
    } else { console.error("Unexpected command: " + JSON.stringify(args)); process.exit(2); }
    console.log(JSON.stringify(result));
  `);
  const fakeFzf = join(home, "fake-fzf.mjs");
  writeFileSync(fakeFzf, `
    import fs from "node:fs";
    const cfg = JSON.parse(fs.readFileSync(process.env.TEST_CONFIG, "utf8"));
    const input = fs.readFileSync(0, "utf8");
    fs.writeFileSync(process.env.TEST_HOME + "/fzf-records", input);
    fs.writeFileSync(process.env.TEST_HOME + "/fzf-args", JSON.stringify(process.argv.slice(2)));
    fs.writeFileSync(process.env.TEST_HOME + "/fzf-env", JSON.stringify(process.env));
    fs.writeFileSync(process.env.TEST_HOME + "/calls-at-fzf", fs.readFileSync(process.env.TEST_HOME + "/calls.jsonl", "utf8"));
    if (cfg.pickExit) process.exit(cfg.pickExit);
    process.stdout.write(cfg.fzfOutput ?? (input.split("\\0")[cfg.pickIndex] + "\\0"));
  `);
  for (const [name, target] of [["rex", fakeRex], ["fzf", fakeFzf]]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(target)} "$@"\n`, { mode: 0o755 });
  }
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"),
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, TEST_CONFIG: configFile, TEST_HOME: home,
  };
  const lua = installLegacyLua({ home, bin, env, fakeRex, root });
  const args = (command, current = "session:a", target) => [
    command, "--client", config.client, "--current", current, ...(target ? ["--session", target] : []),
  ];
  const run = (command, current, target, overrides = {}) => {
    update();
    const [executable, argv] = lua.invocation("session", args(command, current, target));
    return spawnSync(executable, argv, {
      env: { ...env, ...overrides }, encoding: "utf8", timeout: 10_000,
    });
  };
  const ok = (result) => assert.equal(result.status, 0, result.stderr || String(result.error));
  const selected = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  return { home, bin, state, config, env, update, args, run, ok, selected, lua };
}

test("Lua modules select A→B and toggle B→A→B", (t) => {
  const f = fixture(t);
  f.ok(f.run("select", "session:a", "session:b"));
  f.ok(f.run("toggle", "session:b"));
  f.ok(f.run("toggle", "session:a"));
  assert.deepEqual(f.selected(), ["session_id=session:b", "session_id=session:a", "session_id=session:b"]);
});

test("runtime history and its lock stay inside the ignored state directory", (t) => {
  const f = fixture(t);
  f.ok(f.run("select", "session:a", "session:b"));
  assert.equal(existsSync(f.state), true);
  assert.equal(existsSync(f.state.replace(/\.json$/, ".lock")), true);
  assert.equal(existsSync(join(f.home, "config/rex/state/session-history.json")), false);
  assert.equal(existsSync(join(f.home, "config/rex/state/session-history.lock")), false);
});

test("recovers a disconnected client's legacy history and preserves old entries", (t) => {
  const f = fixture(t);
  mkdirSync(dirname(f.state), { recursive: true });
  const legacy = { "host:local": { "client:old": { current: "session:b", previous: "session:a" } } };
  writeFileSync(f.state, JSON.stringify(legacy));
  f.ok(f.run("toggle", "session:b"));
  assert.deepEqual(f.selected(), ["session_id=session:a"]);
  assert.deepEqual(JSON.parse(readFileSync(f.state, "utf8")), {
    "host:local": { ...legacy["host:local"], shared: { current: "session:a", previous: "session:b" } },
  });
});

for (const [name, entries, destination] of [
  ["reversed duplicates", { one: { current: "session:b", previous: "session:a" }, two: { current: "session:a", previous: "session:b" } }, "session:a"],
  ["stale and unrelated entries", { one: { current: "session:b", previous: "session:a" }, stale: { current: "session:b", previous: "session:closed" }, unrelated: { current: "session:a", previous: "session:c" } }, "session:a"],
  ["conflicting destinations", { one: { current: "session:b", previous: "session:a" }, two: { current: "session:b", previous: "session:c" } }, null],
  ["only unrelated entries", { one: { current: "session:a", previous: "session:c" } }, null],
  ["only stale entries", { one: { current: "session:b", previous: "session:closed" } }, null],
  ["self-pair", { one: { current: "session:b", previous: "session:b" } }, null],
]) {
  test(`legacy recovery handles ${name} without guessing`, (t) => {
    const f = fixture(t);
    mkdirSync(dirname(f.state), { recursive: true });
    const before = JSON.stringify({ "host:local": entries, "host:other": { other: { current: "session:b", previous: "session:c" } } });
    writeFileSync(f.state, before);
    const result = f.run("toggle", "session:b");
    if (destination) {
      f.ok(result);
      assert.deepEqual(f.selected(), [`session_id=${destination}`]);
      const after = JSON.parse(readFileSync(f.state, "utf8"));
      for (const [key, entry] of Object.entries(entries)) assert.deepEqual(after["host:local"][key], entry);
      assert.deepEqual(after["host:other"], JSON.parse(before)["host:other"]);
    } else {
      assert.equal(result.status, 1);
      assert.match(result.stderr, name === "conflicting destinations" ? /ambiguous.*picker/i : /No previous session/);
      assert.equal(readFileSync(f.state, "utf8"), before);
      assert.deepEqual(f.selected(), []);
    }
  });
}

test("refused legacy recovery preserves exact bytes", (t) => {
  const f = fixture(t);
  mkdirSync(dirname(f.state), { recursive: true });
  const before = '{ "host:local": { "client:old": { "current": "session:b", "previous": "session:a" } } }\n';
  writeFileSync(f.state, before);
  f.config.refuse = true;
  const result = f.run("toggle", "session:b");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Remote Control/);
  assert.equal(readFileSync(f.state, "utf8"), before);
});

test("shared history is authoritative even when closed and legacy history is live", (t) => {
  const f = fixture(t);
  mkdirSync(dirname(f.state), { recursive: true });
  const before = JSON.stringify({ "host:local": {
    shared: { current: "session:b", previous: "session:closed" },
    "client:mac": { current: "session:b", previous: "session:a" },
  } });
  writeFileSync(f.state, before);
  const result = f.run("toggle", "session:b");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /closed/);
  assert.deepEqual(f.selected(), []);
  assert.equal(readFileSync(f.state, "utf8"), before);
});

test("same-session selection does not replace previous history", (t) => {
  const f = fixture(t);
  f.ok(f.run("select", "session:a", "session:b"));
  const before = readFileSync(f.state, "utf8");
  f.ok(f.run("select", "session:b", "session:b"));
  assert.equal(readFileSync(f.state, "utf8"), before);
  f.ok(f.run("toggle", "session:b"));
  assert.deepEqual(f.selected(), ["session_id=session:b", "session_id=session:a"]);
});

for (const exit of [1, 130]) {
  test(`fzf cancellation (${exit}) leaves history unchanged`, (t) => {
    const f = fixture(t);
    f.ok(f.run("select", "session:a", "session:b"));
    const before = readFileSync(f.state, "utf8");
    f.config.pickExit = exit;
    f.ok(f.run("pick", "session:b"));
    assert.equal(readFileSync(f.state, "utf8"), before);
    assert.equal(f.selected().length, 1);
  });
}

test("renaming a remembered session does not break the ID-based toggle", (t) => {
  const f = fixture(t);
  f.ok(f.run("select", "session:a", "session:b"));
  f.config.sessions[0].label = "Renamed";
  f.ok(f.run("toggle", "session:b"));
  assert.equal(f.selected().at(-1), "session_id=session:a");
});

test("closed previous session reports an error without changing history", (t) => {
  const f = fixture(t);
  f.ok(f.run("select", "session:a", "session:b"));
  const before = readFileSync(f.state, "utf8");
  f.config.sessions.shift();
  const result = f.run("toggle", "session:b");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /closed|no longer exists/);
  assert.equal(readFileSync(f.state, "utf8"), before);
});

test("missing history reports how to seed it", (t) => {
  const f = fixture(t);
  const result = f.run("toggle");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No previous session/);
  assert.deepEqual(f.selected(), []);
});

test("refused selection preserves history and releases the lock", (t) => {
  const f = fixture(t);
  f.ok(f.run("select", "session:a", "session:b"));
  const before = readFileSync(f.state, "utf8");
  f.config.refuse = true;
  const result = f.run("toggle", "session:b");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Remote Control/);
  assert.equal(readFileSync(f.state, "utf8"), before);
  f.config.refuse = false;
  f.ok(f.run("toggle", "session:b"));
});

for (const invalid of ["not JSON", "[]", '{"host":{"client":[]}}', '{"host":{"client":{"current":12,"previous":"a"}}}']) {
  test(`malformed history is not overwritten: ${invalid}`, (t) => {
    const f = fixture(t);
    mkdirSync(dirname(f.state), { recursive: true });
    writeFileSync(f.state, invalid);
    const result = f.run("select", "session:a", "session:b");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid session history/);
    assert.equal(readFileSync(f.state, "utf8"), invalid);
    assert.deepEqual(f.selected(), []);
  });
}

test("reconnected clients share history while hosts stay isolated", (t) => {
  const f = fixture(t);
  f.ok(f.run("select", "session:a", "session:b"));
  f.config.client = "client:other";
  f.ok(f.run("toggle", "session:b"));
  f.ok(f.run("toggle", "session:a"));
  assert.deepEqual(f.selected(), ["session_id=session:b", "session_id=session:a", "session_id=session:b"]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f.state, "utf8"))["host:local"]), ["shared"]);
  f.config.host = "host:other";
  assert.match(f.run("toggle").stderr, /No previous session/);
  f.config.host = "host:local";
  f.ok(f.run("toggle", "session:b"));
});

test("explicit invoking session overrides stale saved context", (t) => {
  const f = fixture(t);
  f.ok(f.run("select", "session:a", "session:b"));
  f.ok(f.run("select", "session:c", "session:a"));
  f.ok(f.run("toggle", "session:a"));
  assert.equal(f.selected().at(-1), "session_id=session:c");
});

test("toggle after a native switch returns to last tracked current session", (t) => {
  const f = fixture(t);
  f.ok(f.run("select", "session:a", "session:b"));
  f.ok(f.run("toggle", "session:c"));
  f.ok(f.run("toggle", "session:b"));
  assert.deepEqual(f.selected(), ["session_id=session:b", "session_id=session:b", "session_id=session:c"]);
});

for (const [name, hosts, settings, pinned] of [
  ["shared pair", { "host:local": { shared: { current: "session:a", previous: "session:c" } } }, {}, "session:c"],
  ["native switch context", { "host:local": { shared: { current: "session:c", previous: "session:b" } } }, {}, "session:c"],
  ["reconnected client", { "host:local": { shared: { current: "session:a", previous: "session:c" } } }, { client: "client:new" }, "session:c"],
  ["unique legacy pair", { "host:local": { "client:old": { current: "session:a", previous: "session:c" } } }, {}, "session:c"],
  ["reversed legacy duplicates", { "host:local": { one: { current: "session:a", previous: "session:c" }, two: { current: "session:c", previous: "session:a" } } }, {}, "session:c"],
  ["another host", { "host:other": { shared: { current: "session:a", previous: "session:c" } } }, {}, null],
  ["ambiguous legacy", { "host:local": { one: { current: "session:a", previous: "session:c" }, two: { current: "session:a", previous: "session:b" } } }, {}, null],
  ["closed authoritative shared", { "host:local": { shared: { current: "session:a", previous: "session:closed" }, legacy: { current: "session:a", previous: "session:c" } } }, {}, null],
  ["self-pair", { "host:local": { shared: { current: "session:a", previous: "session:a" } } }, {}, null],
  ["failed optional status", { "host:local": { shared: { current: "session:a", previous: "session:c" } } }, { statusRefuse: true }, null],
  ["instance fallback", { "instance:one": { shared: { current: "session:a", previous: "session:c" } } }, { host: undefined }, "session:c"],
]) {
  test(`last-used picker ordering handles ${name} without changing history`, (t) => {
    const f = fixture(t);
    f.config.sessions.push({ session_id: "session:d", label: "aardvark" });
    Object.assign(f.config, settings, { pickExit: 130 });
    mkdirSync(dirname(f.state), { recursive: true });
    const before = JSON.stringify(hosts, null, 2) + "\n";
    writeFileSync(f.state, before);
    f.ok(f.run("pick"));
    const rows = readFileSync(join(f.home, "fzf-records"), "utf8").split("\0").filter(Boolean);
    assert.deepEqual(rows.map((row) => row.split("\t")[0]), pinned
      ? ["session:c", "session:d", "session:b"] : ["session:d", "session:b", "session:c"]);
    assert.equal(rows.filter((row) => row.includes("(last used)")).length, pinned ? 1 : 0);
    if (pinned) assert.equal(rows[0], "session:c\tGamma (last used)");
    assert.equal(readFileSync(f.state, "utf8"), before);
    assert.equal(existsSync(f.state.replace(/\.json$/, ".lock")), false, "ordering must not lock or rewrite history");
    assert.deepEqual(f.selected(), []);
    const calls = readFileSync(join(f.home, "calls-at-fzf"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls[0], ["ls", "--json"]);
    assert.ok(calls.length <= 2, "ordering may issue at most one optional host-status query");
    if (calls.length === 2) assert.deepEqual(calls[1], ["api", "call", "server.status", "{}"]);
  });
}

for (const initial of [
  { current: "session:a", previous: "session:c" },
  { current: "session:c", previous: "session:b" },
]) {
  test(`picker first row agrees with toggle from ${initial.current}`, (t) => {
    const f = fixture(t);
    mkdirSync(dirname(f.state), { recursive: true });
    writeFileSync(f.state, JSON.stringify({ "host:local": { shared: initial } }));
    f.config.pickExit = 130;
    f.ok(f.run("pick"));
    const first = readFileSync(join(f.home, "fzf-records"), "utf8").split("\t")[0];
    assert.equal(first, "session:c");
    f.ok(f.run("toggle", "session:a"));
    assert.deepEqual(f.selected(), ["session_id=session:c"]);
  });
}

for (const initial of [undefined, "{}", "not JSON", "[]", '{"host":{"client":[]}}']) {
  test(`optional ordering skips unusable history ${JSON.stringify(initial)}`, (t) => {
    const f = fixture(t);
    if (initial !== undefined) {
      mkdirSync(dirname(f.state), { recursive: true });
      writeFileSync(f.state, initial);
    }
    f.config.pickExit = 130;
    f.ok(f.run("pick"));
    assert.equal(readFileSync(join(f.home, "fzf-records"), "utf8"), "session:b\tBeta\0session:c\tGamma\0");
    assert.equal(readFileSync(join(f.home, "calls-at-fzf"), "utf8"), '["ls","--json"]\n');
    if (initial !== undefined) assert.equal(readFileSync(f.state, "utf8"), initial);
    else assert.equal(existsSync(f.state), false);
  });
}

test("unreadable history does not prevent the picker opening", (t) => {
  const f = fixture(t);
  mkdirSync(f.state, { recursive: true });
  f.config.pickExit = 130;
  f.ok(f.run("pick"));
  assert.equal(readFileSync(join(f.home, "calls-at-fzf"), "utf8"), '["ls","--json"]\n');
  assert.equal(readFileSync(join(f.home, "fzf-records"), "utf8"), "session:b\tBeta\0session:c\tGamma\0");
});

test("slow optional status falls back quickly and leaves history untouched", (t) => {
  const f = fixture(t);
  mkdirSync(dirname(f.state), { recursive: true });
  const before = '{"host:local":{"shared":{"current":"session:a","previous":"session:c"}}}';
  writeFileSync(f.state, before);
  Object.assign(f.config, { statusDelayMs: 3000, pickExit: 130 });
  const start = Date.now();
  f.ok(f.run("pick"));
  assert.ok(Date.now() - start < 1800, "optional status blocked the picker too long");
  assert.equal(readFileSync(f.state, "utf8"), before);
  assert.equal(readFileSync(join(f.home, "fzf-records"), "utf8"), "session:b\tBeta\0session:c\tGamma\0");
  const calls = readFileSync(join(f.home, "calls-at-fzf"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
});

test("last-used marker preserves duplicate-label selection by full ID", (t) => {
  const f = fixture(t);
  f.config.sessions[1].label = f.config.sessions[2].label = "same label";
  mkdirSync(dirname(f.state), { recursive: true });
  writeFileSync(f.state, '{"host:local":{"shared":{"current":"session:a","previous":"session:c"}}}');
  f.ok(f.run("pick"));
  const rows = readFileSync(join(f.home, "fzf-records"), "utf8").split("\0").filter(Boolean);
  assert.deepEqual(rows, ["session:c\tsame label (last used)", "session:b\tsame label"]);
  assert.deepEqual(f.selected(), ["session_id=session:c"]);
});

test("real fzf restores last-used-first order after a relevance query", (t) => {
  const f = fixture(t);
  f.config.sessions[1].label = "a needle";
  f.config.sessions[2].label = "z n-e-e-d-l-e";
  mkdirSync(dirname(f.state), { recursive: true });
  writeFileSync(f.state, '{"host:local":{"shared":{"current":"session:a","previous":"session:c"}}}');
  f.config.pickExit = 130;
  f.ok(f.run("pick"));
  const input = readFileSync(join(f.home, "fzf-records"), "utf8");
  const args = JSON.parse(readFileSync(join(f.home, "fzf-args"), "utf8"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FZF_")));
  const filter = (query) => {
    const result = spawnSync(commandPath("fzf"), [...args, "--filter", query], { env, input, encoding: "utf8", timeout: 5000 });
    f.ok(result);
    return result.stdout.split("\0").filter(Boolean).map((row) => row.split("\t")[0]);
  };
  assert.deepEqual(filter(""), ["session:c", "session:b"]);
  assert.deepEqual(filter("needle"), ["session:b", "session:c"]);
  assert.deepEqual(filter(""), ["session:c", "session:b"]);
});

test("picker excludes current and sorts remaining visible labels ignoring case", (t) => {
  const f = fixture(t);
  f.config.sessions = [
    { session_id: "session:z", label: "zebra" },
    { session_id: "session:b", label: "Beta" },
    { session_id: "session:a", label: "alpha" },
    { session_id: "session:c", label: "Z-current" },
  ];
  f.ok(f.run("pick", "session:c"));
  const records = readFileSync(join(f.home, "fzf-records"), "utf8").split("\0").slice(0, -1);
  assert.deepEqual(records, [
    "session:a\talpha",
    "session:b\tBeta",
    "session:z\tzebra",
  ]);
  assert.deepEqual(f.selected(), ["session_id=session:a"]);
  const calls = readFileSync(join(f.home, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((args) => args.join(" ") === "ls --json").length, 2);
});

test("picker without a listed current session sorts alphabetically without a marker", (t) => {
  const f = fixture(t);
  f.config.sessions.reverse();
  f.config.pickExit = 130;
  f.ok(f.run("pick", "session:missing"));
  const records = readFileSync(join(f.home, "fzf-records"), "utf8").split("\0").slice(0, -1);
  assert.deepEqual(records, ["session:a\tAlpha", "session:b\tBeta", "session:c\tGamma"]);
  assert.deepEqual(f.selected(), []);
  assert.equal(existsSync(f.state), false);
});

test("equal case-insensitive picker labels use IDs to break ties", (t) => {
  const f = fixture(t);
  f.config.sessions = [
    { session_id: "session:c", label: "same" },
    { session_id: "session:b", label: "SAME" },
    { session_id: "session:a", label: "current" },
  ];
  f.ok(f.run("pick"));
  const records = readFileSync(join(f.home, "fzf-records"), "utf8").split("\0").slice(0, -1);
  assert.deepEqual(records.map((row) => row.split("\t")[0]), ["session:b", "session:c"]);
  assert.deepEqual(f.selected(), ["session_id=session:b"]);
});

test("no other sessions reports guidance without opening fzf or changing history", (t) => {
  const f = fixture(t);
  f.ok(f.run("select", "session:a", "session:c"));
  const before = readFileSync(f.state, "utf8");
  f.config.sessions = [{ session_id: "session:c", label: "only current" }];
  const result = f.run("pick", "session:c");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No other sessions available/);
  assert.equal(existsSync(join(f.home, "fzf-records")), false);
  assert.deepEqual(f.selected(), ["session_id=session:c"]);
  assert.equal(readFileSync(f.state, "utf8"), before);
});

test("real fzf preserves initial order but ranks stronger search matches first", (t) => {
  const f = fixture(t);
  f.config.sessions = [
    { session_id: "session:z", label: "z needle" },
    { session_id: "session:a", label: "a n-e-e-d-l-e" },
  ];
  f.config.pickExit = 130;
  f.ok(f.run("pick", "session:missing"));
  const input = readFileSync(join(f.home, "fzf-records"), "utf8");
  const args = JSON.parse(readFileSync(join(f.home, "fzf-args"), "utf8"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FZF_")));
  const filter = (query) => {
    const result = spawnSync(commandPath("fzf"), [...args, "--filter", query], { env, input, encoding: "utf8", timeout: 5000 });
    f.ok(result);
    return result.stdout.split("\0").filter(Boolean).map((row) => row.split("\t")[0]);
  };
  assert.deepEqual(filter(""), ["session:a", "session:z"]);
  assert.deepEqual(filter("needle"), ["session:z", "session:a"]);
  assert.deepEqual(filter(""), ["session:a", "session:z"]);
});

test("session names hide IDs while duplicate sanitized labels still select the correct session", (t) => {
  const f = fixture(t);
  f.config.sessions[0].label = "same\tname\nline\u001b";
  f.config.sessions[1].label = "same\tname\nline\u001b";
  f.config.sessions[2].label = "same\tname\nline\u001b";
  f.config.pickIndex = 1;
  f.ok(f.run("pick"));
  const records = readFileSync(join(f.home, "fzf-records"), "utf8").split("\0").slice(0, -1);
  const visible = records.map((record) => record.split("\t").slice(1).join("\t"));
  assert.deepEqual(visible, ["same name line ", "same name line "]);
  assert.doesNotMatch(visible[0], /[\n\u001b]/);
  assert.deepEqual(records.map(record => record.split("\t")[0]), ["session:b", "session:c"]);
  assert.deepEqual(f.selected(), ["session_id=session:c"]);
});

test("picker preview uses a quoted standalone worker and never prefetches before fzf", (t) => {
  const f = fixture(t);
  const scripts = join(f.home, "picker scripts ' quoted");
  mkdirSync(scripts);
  cpSync(join(root, "scripts"), join(scripts, "scripts"), { recursive: true });
  cpSync(join(root, "lua/navigation"), join(scripts, "lua/navigation"), { recursive: true });
  const sentinel = join(f.home, "must-not-execute");
  f.config.sessions[1].label = `bad ' $(touch ${quote(sentinel)}) label`;
  f.config.pickExit = 130;
  f.update();
  const [executable, argv] = f.lua.script("tests/helpers/rex-navigator-probe.lua", {
    module_root: scripts, request: { operation: "pick", client: f.config.client, current: "session:a" },
  });
  f.ok(spawnSync(executable, argv, {
    env: { ...f.env, SHELL: "/not/a/shell" }, encoding: "utf8", timeout: 5000,
  }));
  const args = JSON.parse(readFileSync(join(f.home, "fzf-args"), "utf8"));
  assert.ok(args.includes("--preview-window=right,50%"));
  assert.ok(args.includes("--bind=ctrl-u:preview-page-up,ctrl-d:preview-page-down"));
  assert.ok(args.some((arg) => arg.startsWith("--header=") && arg.includes("Ctrl+U/D")));
  const template = args[args.indexOf("--preview") + 1];
  assert.equal(typeof template, "string");
  assert.match(template, /\{1\}/);
  const env = JSON.parse(readFileSync(join(f.home, "fzf-env"), "utf8"));
  assert.equal(env.SHELL, "/bin/sh");
  const before = readFileSync(join(f.home, "calls-at-fzf"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(before, [["ls", "--json"]]);
  const preview = (id) => spawnSync(env.SHELL, ["-c", template.replace("{1}", quote(id))], {
    env, encoding: "utf8", timeout: 5000,
  });
  const result = preview("session:b");
  f.ok(result);
  assert.equal(result.stdout, "fake terminal snapshot\n");
  const unsafe = preview(`session:$(touch ${quote(sentinel)})`);
  f.ok(unsafe);
  assert.match(unsafe.stdout, /^Preview unavailable/);
  assert.equal(existsSync(sentinel), false);
  const calls = readFileSync(join(f.home, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const normalized = calls.map(args => args[0] === "block" ? [...args.slice(0, 7), JSON.parse(args[7])] : args);
  assert.deepEqual(normalized, [
    ["ls", "--json"],
    ["api", "call", "session.view", '{"session_id":"session:b"}'],
    ["block", "call", "-s", "session:b", "-b", "block:preview", "modes", {}],
    ["block", "call", "-s", "session:b", "-b", "block:preview", "format", { format: "text", trim: true, max_bytes: 4096 }],
  ]);
  assert.deepEqual(f.selected(), []);
  assert.equal(existsSync(f.state), false);
});

test("unavailable preview does not prevent selecting a session", (t) => {
  const f = fixture(t);
  f.config.previewNonterminal = true;
  f.ok(f.run("pick"));
  const args = JSON.parse(readFileSync(join(f.home, "fzf-args"), "utf8"));
  assert.ok(args.includes("--preview"), "picker must configure a preview worker");
  const template = args[args.indexOf("--preview") + 1];
  assert.equal(typeof template, "string");
  const result = spawnSync("/bin/sh", ["-c", template.replace("{1}", quote("session:b"))], {
    env: f.env, encoding: "utf8", timeout: 5000,
  });
  f.ok(result);
  assert.match(result.stdout, /^Preview unavailable/);
  assert.deepEqual(f.selected(), ["session_id=session:b"]);
});

test("fzf environment customizations cannot inject picker behavior", (t) => {
  const f = fixture(t);
  f.ok(f.run("pick", "session:a", undefined, { FZF_DEFAULT_OPTS: "--expect=ctrl-x" }));
  const env = JSON.parse(readFileSync(join(f.home, "fzf-env"), "utf8"));
  assert.equal(env.FZF_DEFAULT_OPTS, undefined);
});

for (const [settings, pattern] of [[{ pickExit: 2 }, /fzf failed/], [{ fzfOutput: "unknown\0" }, /unexpected selection/]]) {
  test(`invalid picker result reports ${pattern}`, (t) => {
    const f = fixture(t);
    Object.assign(f.config, settings);
    const result = f.run("pick");
    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
    assert.deepEqual(f.selected(), []);
  });
}

test("missing app is rejected without creating history", (t) => {
  const f = fixture(t);
  f.config.noClient = true;
  const result = f.run("select", "session:a", "session:b");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /connected Rex app/);
  assert.equal(existsSync(f.state), false);
});

test("launcher finds managed Rex and fzf under a minimal GUI PATH", (t) => {
  const f = fixture(t);
  const managed = join(f.home, "Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex");
  mkdirSync(dirname(managed), { recursive: true });
  symlinkSync(join(f.bin, "rex"), managed);
  f.update();
  const result = spawnSync("/bin/sh", [launcher, "session", ...f.args("pick")], {
    env: { ...f.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8", timeout: 10_000,
  });
  f.ok(result);
  assert.deepEqual(f.selected(), ["session_id=session:b"]);
});

test("argument validation rejects missing target and unknown options before contacting Rex", (t) => {
  const f = fixture(t);
  const result = f.run("select");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires --session/);
  const unknown = spawnSync("/bin/sh", [launcher, "session", "toggle", "--unknown"], { env: f.env, encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.deepEqual(f.selected(), []);
});

test("kernel lock rejects overlapping toggles and releases when a request finishes", async (t) => {
  const f = fixture(t);
  f.ok(f.run("select", "session:a", "session:b"));
  f.config.delayMs = 1000;
  f.update();
  const [executable, argv] = f.lua.invocation("session", f.args("toggle", "session:b"));
  const first = spawn(executable, argv, { env: f.env, stdio: "ignore" });
  const completed = new Promise((resolve) => first.on("close", resolve));
  t.after(() => { if (first.exitCode === null) first.kill("SIGKILL"); });
  const deadline = Date.now() + 5000;
  while (!existsSync(join(f.home, "select-started")) && Date.now() < deadline) await delay(10);
  assert.equal(existsSync(join(f.home, "select-started")), true, "first request never reached Rex selection");
  const second = f.run("toggle", "session:b");
  assert.equal(second.status, 1);
  assert.match(second.stderr, /in progress/);
  assert.equal(await completed, 0);
  f.config.delayMs = 0;
  f.ok(f.run("toggle", "session:a"));
  assert.deepEqual(f.selected(), ["session_id=session:b", "session_id=session:a", "session_id=session:b"]);
});

test("a killed coordinator retains the lock until its active Lua worker exits", async (t) => {
  const f = fixture(t);
  f.ok(f.run("select", "session:a", "session:b"));
  f.config.delayMs = 5000;
  f.update();
  const [executable, argv] = f.lua.invocation("session", f.args("toggle", "session:b"));
  const child = spawn(executable, argv, { env: f.env, stdio: "ignore" });
  const completed = new Promise((resolve) => child.on("close", resolve));
  let rexPid;
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (rexPid) {
      try { process.kill(rexPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  });
  const marker = join(f.home, "select-started");
  const deadline = Date.now() + 5000;
  while (!existsSync(marker) && Date.now() < deadline) await delay(10);
  assert.equal(existsSync(marker), true, "request never acquired the lock and reached Rex");
  rexPid = Number(readFileSync(marker, "utf8"));
  child.kill("SIGKILL");
  await completed;
  const check = spawnSync("/usr/bin/lockf", ["-k", "-s", "-t", "0", f.state.replace(/\.json$/, ".lock"), "/usr/bin/true"]);
  assert.equal(check.status, 75, "an active Lua worker lost its lock when its coordinator died");
  process.kill(rexPid, "SIGKILL");
  rexPid = undefined;
  let released;
  for (let attempt = 0; attempt < 100; attempt++) {
    released = spawnSync("/usr/bin/lockf", ["-k", "-s", "-t", "0", f.state.replace(/\.json$/, ".lock"), "/usr/bin/true"]);
    if (released.status === 0) break;
    await delay(20);
  }
  assert.equal(released.status, 0, "a finished Lua worker left a stale kernel lock");
});

test("a successful session switch reports a subsequent history save failure distinctly", (t) => {
  const f = fixture(t);
  const result = f.run("select", "session:a", "session:b", { TEST_SAVE_REFUSE: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Session switched, but history could not be saved/);
  assert.deepEqual(f.selected(), ["session_id=session:b"]);
  assert.equal(existsSync(f.state), false);
});
