-- Offline driver: keep embedded subprocess facilities, forbid all live Rex operations.
local native = rex
local args = native.args
args.root = args.root or assert(os.getenv("TEST_LUA_ROOT"))
args.home = args.home or assert(os.getenv("TEST_LUA_HOME"))
args.entry = os.getenv("TEST_LUA_ENTRY") or args.entry
assert(type(args.entry) == "string", "Missing test entrypoint")
assert(
  args.entry:sub(1, #args.root + 1) == args.root .. "/" or args.entry:sub(1, #args.home + 1) == args.home .. "/",
  "Disallowed offline entrypoint"
)
local function forbidden()
  error("Live Rex operation forbidden by offline Lua test driver", 0)
end
local forbidden_methods = setmetatable({}, {
  __index = function()
    return forbidden
  end,
})
rex = {
  args = args,
  exec = native.exec,
  after = native.after,
  every = native.every,
  sleep = native.sleep,
  stop = native.stop,
  json = native.json,
  call = forbidden,
  session = forbidden_methods,
  block = forbidden_methods,
  client = forbidden_methods,
  action = forbidden,
  bind = forbidden,
  on = forbidden,
}
package.path = args.root .. "/?.lua;" .. args.root .. "/?/init.lua;" .. package.path
if args.module_root then
  package.path = args.module_root .. "/?.lua;" .. args.module_root .. "/?/init.lua;" .. package.path
end
do
  local runtime = require("lua.navigation.runtime")
  local construct = runtime.new
  runtime.new = function(options)
    local R = construct(options)
    -- Production history is plugin-local. Keep real checkout paths read-only in
    -- offline tests; deliberately relocated scratch plugins use their real path.
    if options.root:sub(1, #args.home + 1) ~= args.home .. "/" then
      R.state_directory = function()
        return args.home .. "/plugin/state"
      end
    end
    if os.getenv("TEST_SAVE_REFUSE") == "1" then
      R.save_json = function()
        error("synthetic save refusal")
      end
    end
    if os.getenv("TEST_FAKE_REX") then
      local run = R.run
      R.run = function(self, argv, options)
        if argv[2] == "--autostart=false" and argv[3] == "api" and argv[4] == "call" and argv[5] == "server.status" then
          assert(options.timeout == 0.5, "Optional status must request a 500ms deadline")
          local file = assert(io.open(assert(os.getenv("TEST_CONFIG")), "r"))
          local cfg = assert(native.json.decode(file:read("*a")))
          file:close()
          local log = assert(io.open(args.home .. "/calls.jsonl", "a"))
          log:write('["api","call","server.status","{}"]\n')
          log:close()
          if cfg.statusDelayMs and cfg.statusDelayMs >= 500 then
            native.sleep(0.5)
            return { ok = false, code = -1, stdout = "", stderr = "", timed_out = true }
          end
          if cfg.statusRefuse then
            return { ok = false, code = 1, stdout = "", stderr = "status unavailable" }
          end
          return {
            ok = true,
            code = 0,
            stdout = native.json.encode(cfg.status or {
              host_id = cfg.host,
              instance_id = "instance:one",
            }),
            stderr = "",
          }
        end
        return run(self, argv, options)
      end
    end
    return R
  end
end
if os.getenv("TEST_FAKE_REX") then
  local attached_sessions = {}
  local function attachment_event(kind, id)
    local file = assert(io.open(args.home .. "/native-attachments.jsonl", "a"))
    file:write(native.json.encode({ kind = kind, session_id = id }) .. "\n")
    file:close()
  end
  local function invoke(argv)
    local command = { assert(os.getenv("TEST_NODE")), os.getenv("TEST_FAKE_REX") }
    for _, arg in ipairs(argv) do
      command[#command + 1] = arg
    end
    local R = require("lua.navigation.runtime").new({ root = args.root, host = rex })
    local result = R:run(command, { max_stdout = 256 * 1024 })
    assert(result.ok, result.stderr)
    return require("lua.navigation.json").decode(result.stdout)
  end
  rex.call = function(method, request)
    request = request or {}
    if method == "session.list" then
      return invoke({ "ls", "--json" })
    end
    if method == "client.list" then
      return invoke({ "client", "ls", "--json" })
    end
    if method == "server.status" then
      return invoke({ "api", "call", "server.status", "{}" })
    end
    if method == "session.view" then
      if os.getenv("TEST_FAKE_KIND") == "project" then
        local file = assert(io.open(assert(os.getenv("TEST_CONFIG")), "r"))
        local cfg = assert(native.json.decode(file:read("*a")))
        file:close()
        if cfg.requireAttachment and not attached_sessions[request.session_id] then
          error(
            'session.view: stream response "control-test" failed: stream is not attached to session '
              .. request.session_id
              .. " (status=409 code=conflict)"
          )
        end
        return invoke({ "session", "inspect", request.session_id, "--json" })
      end
      return invoke({ "api", "call", "session.view", require("lua.navigation.json").encode(request) })
    end
    if method == "session.create" then
      local windows = assert(request.initial_windows)
      assert(#windows == 1 and windows[1].window_label == "Terminal")
      local block = assert(windows[1].layout.block)
      assert(block.flavor == "com.superlogical.terminal.shell" and type(block.options.cwd) == "string")
      return invoke({ "new", request.label, "-c", block.options.cwd, "--window", "Terminal", "--json" })
    end
    forbidden()
  end
  rex.block = {
    call = function(creator, method, request)
      assert(creator == "com.superlogical.terminal")
      local file = assert(io.open(assert(os.getenv("TEST_CONFIG")), "r"))
      local cfg = assert(native.json.decode(file:read("*a")))
      file:close()
      if cfg.requireAttachment and not attached_sessions[request.session_id] then
        error("stream is not attached to session " .. request.session_id .. " (status=409 code=conflict)")
      end
      if cfg.failBlock then
        error("synthetic block read failure")
      end
      local options = {}
      for key, value in pairs(request) do
        if key ~= "session_id" and key ~= "block_id" then
          options[key] = value
        end
      end
      return invoke({
        "block",
        "call",
        "-s",
        request.session_id,
        "-b",
        request.block_id,
        method,
        require("lua.navigation.json").encode(options),
      })
    end,
  }
  rex.session = {
    attach = function(request)
      local view = invoke({ "session", "inspect", request.session_id, "--json" })
      attached_sessions[request.session_id] = true
      attachment_event("attach", request.session_id)
      return { view = view }
    end,
    detach = function(request)
      attached_sessions[request.session_id] = nil
      attachment_event("detach", request.session_id)
      return {}
    end,
  }
end
if os.getenv("TEST_TRANSACTION_BODY") == "1" then
  local function body(request)
    local json = require("lua.navigation.json")
    local R = require("lua.navigation.runtime").new({ root = args.root, host = rex })
    if request.hold then
      local marker = assert(io.open(args.home .. "/transaction-started", "w"))
      marker:write(assert(os.getenv("TEST_EMBEDDED_PID")))
      marker:close()
      rex.sleep(request.hold)
    end
    if request.fail then
      error("synthetic transaction failure")
    end
    local path = args.home .. "/counter.json"
    local value = R:read_json(path, json.object({ count = 0 }))
    value.count = value.count + 1
    R:save_json(path, value)
    return value
  end
  package.preload["lua.navigation.sessions"] = function()
    return {
      new = function()
        return {
          commit_switch = function(_, request)
            return body(request)
          end,
        }
      end,
    }
  end
  package.preload["lua.navigation.projects"] = function()
    return {
      new = function()
        return {
          commit_open = function(_, request)
            return body(request)
          end,
        }
      end,
    }
  end
end
if os.getenv("TEST_PURE_API") == "1" then
  rex.session = {
    attach = function()
      return { view = { windows = {} } }
    end,
    detach = function()
      return {}
    end,
  }
  rex.call = function(method, request)
    local json = require("lua.navigation.json")
    local path = args.home .. "/pure-created.json"
    local file = io.open(path, "r")
    local created = file and json.decode(file:read("*a")) or json.array()
    if file then
      file:close()
    end
    if method == "session.list" then
      local sessions = { { session_id = "session:a", label = "Alpha" }, { session_id = "session:b", label = "Beta" } }
      for _, entry in ipairs(created) do
        sessions[#sessions + 1] = entry
      end
      return { sessions = sessions }
    elseif method == "client.list" then
      return { clients = { { client_id = "client:mac", info = { kind = "app" }, connection_state = "connected" } } }
    elseif method == "server.status" then
      return { host_id = "host:local", instance_id = "instance:pure" }
    elseif method == "session.view" then
      return { windows = {} }
    elseif method == "session.create" then
      local entry = { session_id = "session:new" .. (#created + 1), label = request.label }
      created[#created + 1] = entry
      file = assert(io.open(path, "w"))
      file:write(json.encode(created))
      file:close()
      return entry
    end
    forbidden()
  end
end
return assert(loadfile(args.entry))()
