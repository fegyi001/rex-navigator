import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function setup(options = "{}") {
  // Only the external layer-creation API is replaced; run real setup and actions.
  const script = `
package.path = arg[1] .. "/?.lua;" .. arg[1] .. "/?/init.lua;" .. package.path
local actions, count, layers = {}, 0, {}
rex = {
  action = function(action)
    actions[action.name] = action
    count = count + 1
  end,
  layout = { block = function(block) return block end },
  session = { new_layer = function(layer)
    layers[#layers + 1] = layer
    return {}
  end },
}
local options = ${options}
local ok, err = pcall(require("lua.navigation").setup, options)
print(tostring(ok))
print(count)
if not ok then
  print(err)
else
  local ctx = { client_id = "client:test", session_id = "session:test" }
  actions.rex_navigator_switch_session.run(ctx)
  actions.rex_navigator_create_session.run(ctx)
  for _, layer in ipairs(layers) do
    assert(layer.focus == true, "picker must keep focus")
    print(table.concat(layer.bounds, ","))
  end
end
`;
  const result = spawnSync("lua", ["-", root], {
    input: script, encoding: "utf8", cwd: "/", timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const [ok, count, ...output] = result.stdout.trim().split("\n");
  return { ok: ok === "true", count: Number(count), output };
}

for (const [name, options, expected] of [
  ["omitted window", "{}", [0.15, 0.2, 0.7, 0.6]],
  ["empty window", "{ window = {} }", [0.15, 0.2, 0.7, 0.6]],
  ["custom dimensions", "{ window = { width = 0.8, height = 0.5 } }", [0.1, 0.25, 0.8, 0.5]],
  ["width only", "{ window = { width = 0.9 } }", [0.05, 0.2, 0.9, 0.6]],
  ["height only", "{ window = { height = 0.8 } }", [0.15, 0.1, 0.7, 0.8]],
  ["full tab", "{ window = { width = 1, height = 1 } }", [0, 0, 1, 1]],
]) {
  test(`both pickers use centered bounds: ${name}`, () => {
    const result = setup(options);
    assert.equal(result.ok, true, result.output.join("\n"));
    assert.equal(result.count, 3);
    assert.equal(result.output.length, 2);
    for (const line of result.output) {
      const bounds = line.split(",").map(Number);
      assert.equal(bounds.length, 4);
      bounds.forEach((value, index) => {
        assert.ok(Math.abs(value - expected[index]) < 1e-12, `${name}: bound ${index} was ${value}, wanted ${expected[index]}`);
      });
    }
  });
}

for (const value of ["false", "true", '"wide"', "0.7"]) {
  test(`invalid window container rejects setup before action registration: ${value}`, () => {
    const result = setup(`{ window = ${value} }`);
    assert.equal(result.ok, false);
    assert.equal(result.count, 0);
    assert.match(result.output.join("\n"), /window must be a table/);
  });
}

for (const dimension of ["width", "height"]) {
  for (const value of ["0", "-0.1", "1.01", '"0.7"', "false", "{}", "math.huge", "-math.huge", "0/0"]) {
    test(`invalid window.${dimension} rejects setup before action registration: ${value}`, () => {
      const result = setup(`{ window = { ${dimension} = ${value} } }`);
      assert.equal(result.ok, false);
      assert.equal(result.count, 0);
      assert.match(result.output.join("\n"), new RegExp(`window\\.${dimension} must be a number greater than 0 and at most 1`));
    });
  }
}
