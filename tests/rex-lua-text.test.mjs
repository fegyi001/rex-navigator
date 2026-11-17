import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createLuaFixture } from "./helpers/rex-lua-fixture.mjs";
const script = "tests/helpers/rex-text-probes.lua";

const textCases = [
  ["éé", 3, "éé", "éé", "é"],
  ["😀x", 4, "😀x", "😀x", "😀"],
  ["a\nb\t\u2028\u200b", 100, "a b   ", "a\nb\t\u2028\u200b", "a\nb\t\u2028\u200b"],
  ["\x1b]52;c;secret\x07safe", 100, undefined, "safe"],
  ["\x1b]title\x1b\\safe", 100, undefined, "safe"],
  ["\x1b]secret\u061cmore\x1b\\safe", 100, undefined, "safe"],
  ["\x1bPsecret\x1b\\safe", 100, undefined, "safe"],
  ["\u009dsecret\u009csafe", 100, undefined, "safe"],
  ["\u009b31mred\u009b0m", 100, undefined, "red"],
  ["before\x1b]unterminated secret", 100, undefined, "before"],
  ["\x1b[31mred\x1b[0m\r\ntext\r", 100, undefined, "red\ntext\n"],
];
for (const [value, bytes, label, preview, truncated] of textCases) {
  test(`text sanitation preserves safe Unicode and removes whole controls: ${JSON.stringify(value)}`, (t) => {
    const f = createLuaFixture(t);
    const r = f.run(script, { probe: "text", value, bytes });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout);
    if (label !== undefined) assert.equal(got.label, label);
    assert.equal(got.preview, preview);
    if (truncated !== undefined) assert.equal(got.truncated, truncated);
  });
}

test("project labels keep safe prefixes and a whole-character 100-byte base", (t) => {
  const f = createLuaFixture(t);
  for (const [value, expected] of [["-demo", "project--demo"], ["é".repeat(60), "é".repeat(50)]]) {
    const r = f.run(script, { probe: "text", value });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).base, expected);
  }
});

test("macOS filesystem adapters preserve path bytes, depth, exclusions, and symlink rules", (t) => {
  const f = createLuaFixture(t);
  const root = join(f.home, "tree");
  for (const path of ["alpha/nested/deep", "node_modules/hidden", ".hidden/child", "quote'\nline", "-dash", "123", "true", "literal*"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "file"), "not a directory");
  symlinkSync(root, join(f.home, "alias"));
  symlinkSync(root, join(root, "cycle"));
  const r = f.run(script, { probe: "filesystem", path: join(f.home, "alias"), roots: [{ path: root, depth: 2 }, { path: join(f.home, "alias"), depth: 2 }, { path: join(f.home, "missing"), depth: 1 }], exclude: ["node_modules", "literal*"] });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.equal(got.directory, true);
  assert.equal(got.canonical, root);
  assert.deepEqual(got.paths, ["-dash", "123", "alpha", "alpha/nested", "quote'\nline", "true"].map(path => join(root, path)).sort());
  assert.equal(got.hash, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.match(r.stderr, /missing root/);
});

test("session sorting ignores accented case and breaks equal labels by full ID", (t) => {
  const f = createLuaFixture(t);
  const records = [{ id: "session:z", label: "Écho" }, { id: "session:a", label: "éCHO" }, { id: "session:b", label: "alpha" }];
  const r = f.run(script, { probe: "sort", records });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map(row => row.id), ["session:b", "session:a", "session:z"]);
});
