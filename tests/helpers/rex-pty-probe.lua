-- Synthetic private-PTY integration; never calls any Rex session/client API.
if rex.args.render then
  local marker = assert(io.open(rex.args.home .. "/pty-preview", "w"))
  marker:write("rendered")
  marker:close()
  io.write("Synthetic Lua preview\n")
  return
end
local R = require("lua.navigation.runtime").new({ root = rex.args.root })
local function quote(value)
  return "'" .. value:gsub("'", "'\\''") .. "'"
end
local preview = "exec "
  .. quote(R:command_path("rex"))
  .. " --autostart=false do "
  .. quote(rex.args.entry)
  .. " --args "
  .. quote(rex.json.encode({ render = true }))
local result = R:run({
  R:command_path("fzf"),
  "--read0",
  "--print0",
  "--layout=reverse",
  "--border",
  "--preview",
  preview,
  "--preview-window=right,50%",
  "--bind=start:bg-transform(while [ ! -f "
    .. quote(rex.args.home .. "/pty-preview")
    .. " ]; do sleep 0.01; done; echo "
    .. (rex.args.cancel and "abort" or "accept")
    .. ")",
}, { timeout = false, stdin = "session:a\tAlpha ' café\0session:b\tBeta\0", env = R:picker_env() })
local done = assert(io.open(rex.args.home .. "/pty-done", "w"))
done:write("done")
done:close()
return { code = result.code, selection = result.stdout }
