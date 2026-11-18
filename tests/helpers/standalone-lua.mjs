// Pure-module tests use the system Lua, never Rex or a running server.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function runLua(source, options = {}) {
  return spawnSync("lua", ["-", root], {
    input: 'package.path = arg[1] .. "/?.lua;" .. arg[1] .. "/?/init.lua;" .. package.path\n' + source,
    cwd: options.cwd || "/",
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    timeout: 5000,
  });
}
