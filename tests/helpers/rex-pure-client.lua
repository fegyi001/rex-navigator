-- Pure Lua fake client action: no Node process and no live Rex client request.
local json = require("lua.navigation.json")
local file = assert(io.open(rex.args.home .. "/selected.jsonl", "a"))
file:write(
  json.encode({ client = os.getenv("TEST_SELECTED_CLIENT"), target = os.getenv("TEST_SELECTED_TARGET") }) .. "\n"
)
file:close()
