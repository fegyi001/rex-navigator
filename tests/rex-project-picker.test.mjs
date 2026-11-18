import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installLegacyLua } from "./helpers/rex-legacy-lua.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "scripts/navigation.sh");
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

function fixture(t) {
  const scratch = join(tmpdir(), "opencode");
  mkdirSync(scratch, { recursive: true });
  const home = realpathSync(mkdtempSync(join(scratch, "rex-project-test-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, ".local/bin");
  const configHome = join(home, "config");
  const rexConfig = join(configHome, "rex");
  const rexScripts = join(rexConfig, "scripts");
  mkdirSync(bin, { recursive: true });
  mkdirSync(rexConfig, { recursive: true });
  symlinkSync(join(root, "scripts"), rexScripts);
  symlinkSync(join(root, "lua"), join(rexConfig, "lua"));
  const tree = join(home, "tree");
  mkdirSync(tree);
  const settings = { roots: [{ path: tree, depth: 2 }], exclude: ["node_modules"] };
  const config = {
    client: "client:mac", explicitClient: true, pickIndex: 0,
    status: { host_id: "host:local", instance_id: "instance:one", listeners: [{ primary: true, endpoint: "unix://fake" }] },
    sessions: [{ session_id: "session:a", label: "source" }], views: {}, processes: {},
  };
  const fakeConfig = join(home, "fake-config.json");
  const state = join(home, "state/rex/project-sessions.json");
  const history = join(home, "plugin/state/session-history.json");
  const update = () => {
    writeFileSync(fakeConfig, JSON.stringify(config));
  };
  const fakeRex = join(home, "fake-rex.mjs");
  writeFileSync(fakeRex, `
    import fs from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    const cfg = JSON.parse(fs.readFileSync(process.env.TEST_CONFIG, "utf8"));
    const home = process.env.TEST_HOME;
    const args = process.argv.slice(2);
    fs.appendFileSync(home + "/calls.jsonl", JSON.stringify(args) + "\\n");
    const createdFile = home + "/created.json";
    const created = fs.existsSync(createdFile) ? JSON.parse(fs.readFileSync(createdFile, "utf8")) : [];
    let result;
    if (args.join(" ") === "client ls --json") {
      result = {clients: cfg.apps ?? [{client_id: cfg.client, info: {kind: "app"}, connection_state: "connected"}]};
    } else if (args.join(" ") === "api call server.status {}") {
      result = cfg.status;
    } else if (args.join(" ") === "ls --json") {
      result = {sessions: [...cfg.sessions, ...created.map(({session_id, label}) => ({session_id, label}))]};
    } else if (args[0] === "session" && args[1] === "inspect") {
      result = cfg.views[args[2]] ?? {windows: []};
    } else if (args[0] === "block" && args[1] === "call") {
      result = cfg.processes[args[5]] ?? {ancestors: []};
    } else if (args[0] === "new") {
      if (cfg.createDelay) await delay(cfg.createDelay);
      const session = {session_id: "session:new" + (created.length + 1), label: args[1], args};
      created.push(session);
      fs.writeFileSync(createdFile, JSON.stringify(created));
      result = cfg.missingCreatedId ? {} : session;
    } else if (args[0] === "-C" && args[2] === "do" && args[3] === "session.select") {
      if (cfg.refuse) { console.error("Remote Control disabled"); process.exit(1); }
      fs.appendFileSync(home + "/selected.jsonl", JSON.stringify(args[4]) + "\\n");
      result = null;
    } else { console.error("Unexpected command " + JSON.stringify(args)); process.exit(2); }
    console.log(JSON.stringify(result));
  `);
  const fakeFzf = join(home, "fake-fzf.mjs");
  writeFileSync(fakeFzf, `
    import fs from "node:fs";
    const cfg = JSON.parse(fs.readFileSync(process.env.TEST_CONFIG, "utf8"));
    const input = fs.readFileSync(0, "utf8");
    fs.writeFileSync(process.env.TEST_HOME + "/fzf-records", input);
    if (cfg.pickExit) process.exit(cfg.pickExit);
    process.stdout.write(cfg.fzfOutput ?? (input.split("\\0")[cfg.pickIndex] + "\\0"));
  `);
  for (const [name, target] of [["rex", fakeRex], ["fzf", fakeFzf]]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(target)} "$@"\n`, { mode: 0o755 });
  }
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: join(home, "state"),
    REX_SESSION: "session:a", REX_CLIENT: "", REX_BLOCK: "block:picker",
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, TEST_CONFIG: fakeConfig, TEST_HOME: home,
    TEST_FAKE_KIND: "project",
  };
  const lua = installLegacyLua({ home, bin, env, fakeRex, root });
  const args = (directory) => [
    ...(directory === undefined ? [] : [directory]), "--projects-json", JSON.stringify(settings),
    ...(config.explicitClient ? ["--client", config.client] : []),
  ];
  const run = (directory, overrides = {}) => {
    update();
    const [executable, argv] = lua.invocation("project", args(directory));
    return spawnSync(executable, argv, {
      env: { ...env, ...overrides }, encoding: "utf8", timeout: 15_000,
    });
  };
  const ok = (result) => assert.equal(result.status, 0, result.stderr || String(result.error));
  const readJson = (file, fallback = []) => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
  const jsonLines = (file) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : [];
  const created = () => readJson(join(home, "created.json"));
  const calls = () => jsonLines(join(home, "calls.jsonl"));
  const project = (relative) => { const path = join(tree, relative); mkdirSync(path, { recursive: true }); return path; };
  const registry = (mapping) => {
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ "host:local|unix://fake": mapping }));
  };
  const view = (block, host = "host:local") => ({ windows: [{ layers: [{ blocks: [
    { block_id: block, creator_name: "com.superlogical.terminal", host_id: host },
  ] }] }] });
  return {
    home, bin, tree, config, settings, state, history, env, args, update, run, ok, created, calls, project,
    registry, view, readJson, lua, selected: () => jsonLines(join(home, "selected.jsonl")),
    records: () => readFileSync(join(home, "fzf-records"), "utf8").split("\0").slice(0, -1),
  };
}

test("discovery preserves depth, exclusions, hidden-directory and symlink rules", (t) => {
  const f = fixture(t);
  const alpha = f.project("alpha");
  const nested = f.project("alpha/nested");
  f.project("alpha/nested/too-deep");
  f.project(".hidden/child");
  f.project("node_modules/package");
  writeFileSync(join(f.tree, "plain-file"), "not a directory");
  symlinkSync(f.tree, join(alpha, "loop"));
  f.config.pickExit = 130;
  f.ok(f.run());
  assert.deepEqual(f.records(), [alpha, nested]);
  assert.deepEqual(f.calls(), []);
});

test("overlapping and symlinked root aliases are canonicalized and deduplicated", (t) => {
  const f = fixture(t);
  const alpha = f.project("alpha");
  const alias = join(f.home, "tree-alias");
  symlinkSync(f.tree, alias);
  f.settings.roots.push({ path: alias, depth: 2 });
  f.config.pickExit = 130;
  f.ok(f.run());
  assert.deepEqual(f.records(), [alpha]);
});

test("missing roots warn without hiding projects from valid roots", (t) => {
  const f = fixture(t);
  const alpha = f.project("alpha");
  f.settings.roots.unshift({ path: join(f.home, "missing"), depth: 1 });
  f.config.pickExit = 130;
  const result = f.run();
  f.ok(result);
  assert.match(result.stderr, /skipping missing root/);
  assert.deepEqual(f.records(), [alpha]);
});

for (const settings of [
  { roots: [] }, { roots: [{ path: "relative", depth: 1 }] },
  { roots: [{ path: "/tmp", depth: 0 }] }, { roots: [{ path: "/tmp", depth: true }] },
  { roots: [{ path: "/tmp", depth: 1.5 }] }, { roots: [{ path: "/tmp", depth: 1 }], exclude: "node_modules" },
  { roots: [{ path: "/nonexistent-rex-test-root", depth: 1 }], exclude: null },
]) {
  test(`invalid project settings are rejected: ${JSON.stringify(settings)}`, (t) => {
    const f = fixture(t);
    Object.assign(f.settings, settings);
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /nonempty roots|root paths must|positive integer depth|exclude must/);
    assert.deepEqual(f.calls(), []);
  });
}

test("project selection feeds session toggling after app reconnection", (t) => {
  const f = fixture(t);
  const directory = f.project("restart-project");
  f.ok(f.run(directory));
  f.config.client = "client:reconnected";
  f.update();
  const [executable, argv] = f.lua.invocation("session", ["toggle", "--client", f.config.client, "--current", "session:new1"]);
  const result = spawnSync(executable, argv, { env: f.env, encoding: "utf8", timeout: 10_000 });
  f.ok(result);
  assert.deepEqual(f.selected(), ["session_id=session:new1", "session_id=session:a"]);
  assert.deepEqual(f.calls().filter((args) => args[0] === "-C").at(-1), [
    "-C", "client:reconnected", "do", "session.select", "session_id=session:a",
  ]);
  assert.deepEqual(f.readJson(f.history)["host:local"].shared, { current: "session:a", previous: "session:new1" });
});

test("cancelled picker leaves the project registry and history untouched", (t) => {
  const f = fixture(t);
  const directory = f.project("alpha");
  f.registry({ [directory]: "session:b" });
  const before = readFileSync(f.state, "utf8");
  f.config.pickExit = 130;
  f.ok(f.run());
  assert.equal(readFileSync(f.state, "utf8"), before);
  assert.equal(existsSync(f.history), false);
  assert.deepEqual(f.calls(), []);
});

test("opens a new project with safe argv and updates both registries", (t) => {
  const f = fixture(t);
  const directory = f.project("space ' ; café");
  f.ok(f.run(directory));
  assert.deepEqual(f.created()[0].args, ["new", "space ' ; café", "-c", directory, "--window", "Terminal", "--json"]);
  assert.equal(f.readJson(f.state)["host:local|unix://fake"][directory], "session:new1");
  assert.deepEqual(f.readJson(f.history)["host:local"].shared, { current: "session:new1", previous: "session:a" });
  assert.deepEqual(f.selected(), ["session_id=session:new1"]);
});

test("existing Python registry and a symlinked directory reuse the session", (t) => {
  const f = fixture(t);
  const directory = f.project("alpha");
  const alias = join(f.home, "alias");
  symlinkSync(directory, alias);
  f.config.sessions.push({ session_id: "session:b", label: "renamed" });
  f.registry({ [directory]: "session:b" });
  f.ok(f.run(alias));
  assert.deepEqual(f.created(), []);
  assert.deepEqual(f.selected(), ["session_id=session:b"]);
  assert.equal(f.calls().some((args) => args[0] === "session"), false);
});

test("stale registry reuses matching local terminal cwd and ignores the picker/remote blocks", (t) => {
  const f = fixture(t);
  const directory = f.project("alpha");
  f.registry({ [directory]: "session:closed" });
  f.config.sessions.push({ session_id: "session:b", label: "existing" });
  f.config.views["session:a"] = { windows: [{ layers: [{ blocks: [
    { block_id: "block:picker", creator_name: "com.superlogical.terminal", host_id: "host:local" },
    { block_id: "block:remote", creator_name: "com.superlogical.terminal", host_id: "host:remote" },
  ] }] }] };
  f.config.views["session:b"] = f.view("block:local");
  f.config.processes["block:local"] = { foreground: null, ancestors: [{ cwd: directory }] };
  f.update();
  const [executable, argv] = f.lua.invocation("project", [...f.args(directory), "--picker-tab"]);
  const result = spawnSync(executable, argv, {
    env: f.env, input: "\n", encoding: "utf8", timeout: 15_000,
  });
  f.ok(result);
  assert.deepEqual(f.created(), []);
  assert.deepEqual(f.selected(), ["session_id=session:b"]);
  const inspected = f.calls().filter((args) => args[0] === "block").map((args) => args[5]);
  assert.deepEqual(inspected, ["block:local"]);
});

test("project matching reads sessions safely when its Lua control stream is not attached", (t) => {
  const f = fixture(t);
  const directory = f.project("attachment-regression");
  f.config.requireAttachment = true;
  f.config.sessions.push({ session_id: "session:b", label: "existing" });
  f.config.views["session:b"] = f.view("block:existing");
  f.config.processes["block:existing"] = { foreground: { cwd: directory } };
  const result = f.run(directory);
  f.ok(result);
  assert.deepEqual(f.created(), []);
  assert.deepEqual(f.selected(), ["session_id=session:b"]);
});

test("project creation also scans unattached sessions without a 409 conflict", (t) => {
  const f = fixture(t);
  const directory = f.project("new-attachment-regression");
  f.config.requireAttachment = true;
  const result = f.run(directory);
  f.ok(result);
  assert.equal(f.created().length, 1);
  assert.deepEqual(f.selected(), ["session_id=session:new1"]);
  assert.ok(f.calls().some(args => args[0] === "session" && args[1] === "inspect"));
});

test("native project inspection attaches explicitly and detaches even when a block read fails", (t) => {
  const f = fixture(t);
  const directory = f.project("native-attachment-cleanup");
  f.config.requireAttachment = true;
  f.config.failBlock = true;
  f.config.views["session:a"] = f.view("block:source");
  const result = f.run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /synthetic block read failure/);
  assert.deepEqual(readFileSync(join(f.home, "native-attachments.jsonl"), "utf8").trim().split("\n").map(JSON.parse), [
    { kind: "attach", session_id: "session:a" }, { kind: "detach", session_id: "session:a" },
  ]);
  assert.deepEqual(f.created(), []);
  assert.deepEqual(f.selected(), []);
});

test("ambiguous cwd matches refuse to create or associate an arbitrary session", (t) => {
  const f = fixture(t);
  const directory = f.project("alpha");
  f.config.sessions.push({ session_id: "session:b", label: "also" });
  for (const [sid, bid] of [["session:a", "block:a"], ["session:b", "block:b"]]) {
    f.config.views[sid] = f.view(bid);
    f.config.processes[bid] = { foreground: { cwd: directory } };
  }
  const result = f.run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Multiple Rex sessions/);
  assert.deepEqual(f.created(), []);
  assert.equal(existsSync(f.state), false);
});

test("failed switch keeps a newly created association for a duplicate-free retry", (t) => {
  const f = fixture(t);
  const directory = f.project("alpha");
  f.config.refuse = true;
  const failed = f.run(directory);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Remote Control/);
  assert.equal(f.readJson(f.state)["host:local|unix://fake"][directory], "session:new1");
  assert.equal(existsSync(f.history), false);
  f.config.refuse = false;
  f.ok(f.run(directory));
  assert.equal(f.created().length, 1);
  assert.deepEqual(f.selected(), ["session_id=session:new1"]);
});

test("malformed creation response cannot accidentally invoke the last-session toggle", (t) => {
  const f = fixture(t);
  const directory = f.project("alpha");
  f.config.sessions.push({ session_id: "session:b", label: "unrelated" });
  mkdirSync(dirname(f.history), { recursive: true });
  writeFileSync(f.history, '{"host:local":{"client:mac":{"current":"session:a","previous":"session:b"}}}');
  f.config.missingCreatedId = true;
  const result = f.run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /session ID.*inspect sessions/);
  assert.deepEqual(f.selected(), []);
  assert.equal(existsSync(f.state), false);
});

test("malformed registry is reported without overwriting it or creating sessions", (t) => {
  const f = fixture(t);
  const directory = f.project("alpha");
  mkdirSync(dirname(f.state), { recursive: true });
  writeFileSync(f.state, '{"host": []}');
  const result = f.run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid project-session registry/);
  assert.equal(readFileSync(f.state, "utf8"), '{"host": []}');
  assert.deepEqual(f.created(), []);
});

test("missing source session context is rejected before contacting Rex", (t) => {
  const f = fixture(t);
  const result = f.run(f.project("alpha"), { REX_SESSION: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /REX_SESSION/);
  assert.deepEqual(f.calls(), []);
});

test("multiple apps require an explicit client selection", (t) => {
  const f = fixture(t);
  f.config.explicitClient = false;
  f.config.apps = ["client:mac", "client:other"].map((client_id) => ({
    client_id, info: { kind: "app" }, connection_state: "connected",
  }));
  const result = f.run(f.project("alpha"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one connected Rex app/);
  assert.deepEqual(f.created(), []);
});

test("colliding session labels use the existing deterministic hash and number scheme", (t) => {
  const f = fixture(t);
  const directory = f.project("-alpha");
  const suffix = createHash("sha256").update(directory).digest("hex").slice(0, 8);
  f.config.sessions.push({ session_id: "session:b", label: "project--alpha" },
    { session_id: "session:c", label: `project--alpha-${suffix}` });
  f.ok(f.run(directory));
  assert.equal(f.created()[0].label, `project--alpha-${suffix}-2`);
});

test("Unicode session labels stay within the existing 100-byte base limit", (t) => {
  const f = fixture(t);
  const directory = f.project("é".repeat(60));
  f.ok(f.run(directory));
  assert.equal(f.created()[0].label, "é".repeat(50));
});

test("unknown fzf selections are rejected before creating a session", (t) => {
  const f = fixture(t);
  f.project("alpha");
  f.config.fzfOutput = "/unexpected\0";
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected selection/);
  assert.deepEqual(f.calls(), []);
});

test("project worker launcher uses embedded Lua with minimal GUI PATH", (t) => {
  const f = fixture(t);
  const directory = f.project("alpha");
  const managed = join(f.home, "Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex");
  mkdirSync(dirname(managed), { recursive: true });
  symlinkSync(join(f.bin, "rex"), managed);
  f.update();
  const result = spawnSync("/bin/sh", [launcher, "project", ...f.args(directory)], {
    env: { ...f.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8", timeout: 15_000,
  });
  f.ok(result);
  assert.deepEqual(f.selected(), ["session_id=session:new1"]);
});

test("concurrent opens of the same project create exactly one session", async (t) => {
  const f = fixture(t);
  const directory = f.project("alpha");
  f.config.createDelay = 500;
  f.update();
  const start = () => new Promise((resolve) => {
    const [executable, argv] = f.lua.invocation("project", f.args(directory));
    const child = spawn(executable, argv, { env: f.env });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("close", (status) => resolve({ status, stderr }));
  });
  const results = await Promise.all([start(), start()]);
  results.forEach(f.ok);
  assert.equal(f.created().length, 1);
  assert.deepEqual(f.selected(), ["session_id=session:new1", "session_id=session:new1"]);
});

test("Lua navigation actions retain their floating-layer and argv integration", () => {
  const result = spawnSync("lua", [join(root, "tests/helpers/rex-actions.lua"), root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("an fzf failure with empty stdout is not treated as project cancellation", (t) => {
  const f = fixture(t);
  f.project("alpha");
  f.config.pickExit = 2;
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fzf failed/);
  assert.deepEqual(f.calls(), []);
});

for (const name of ["123", "true", "quote'\nline", "-dash"]) {
  test(`relative project path remains a string and cannot inject commands: ${JSON.stringify(name)}`, (t) => {
    const f = fixture(t);
    const directory = f.project(name);
    f.update();
    const [executable, argv] = f.lua.invocation("project", f.args(`./${name}`));
    const result = spawnSync(executable, argv, { cwd: f.tree, env: f.env, encoding: "utf8", timeout: 15_000 });
    f.ok(result);
    assert.equal(f.readJson(f.state)["host:local|unix://fake"][directory], "session:new1");
    assert.equal(f.created()[0].args[3], directory);
  });
}
