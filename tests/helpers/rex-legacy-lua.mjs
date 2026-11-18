// Reuse existing behavioral fixtures while running the production Lua modules.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { realRex } from "./rex-lua-fixture.mjs";
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function installLegacyLua({ home, bin, env, fakeRex, root }) {
  Object.assign(env, {
    TEST_LUA_ROOT: root, TEST_LUA_HOME: home, TEST_FAKE_REX: fakeRex, TEST_NODE: process.execPath,
    REX_RUNTIME_DIR: process.env.REX_RUNTIME_DIR || join(process.env.HOME, "Library/Application Support/rex"),
  });
  const driver = join(root, "tests/helpers/rex-lua-driver.lua");
  writeFileSync(join(bin, "rex"), `#!/bin/sh
if [ "\${1-}" = --autostart=false ]; then shift; fi
if [ "\${1-}" = do ]; then
  case "\${2-}" in
    *.lua)
      export TEST_LUA_ENTRY="$2"
      export TEST_EMBEDDED_PID=$$
      shift 2
      exec ${quote(realRex)} --autostart=false do ${quote(driver)} "$@"
      ;;
  esac
fi
exec ${quote(process.execPath)} ${quote(fakeRex)} "$@"
`, { mode: 0o755 });
  return {
    script(entry, args = {}) {
      return [realRex, ["--autostart=false", "do", driver, "--args", JSON.stringify({
        root, home, entry: resolve(root, entry), ...args,
      })]];
    },
    invocation(kind, argv) {
      const request = { operation: kind === "session" ? argv[0] : "project" };
      const names = { "--client": "client", "--current": "current", "--session": "session" };
      for (let i = kind === "session" ? 1 : 0; i < argv.length; i++) {
        if (argv[i] === "--projects-json") request.projects_json = argv[++i];
        else if (names[argv[i]]) request[names[argv[i]]] = argv[++i];
        else if (argv[i] === "--picker-tab") request.picker_tab = true;
        else if (kind === "project" && !argv[i].startsWith("--")) request.directory = argv[i];
        else throw new Error(`Unknown test argument ${argv[i]}`);
      }
      return [realRex, ["--autostart=false", "do", driver, "--args", JSON.stringify({
        root, home, entry: join(root, "tests/helpers/rex-navigator-probe.lua"), request,
      })]];
    },
  };
}
