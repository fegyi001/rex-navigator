-- Characterization probes for assumptions required by the Lua migration.
local function write(path, text)
  local f = assert(io.open(path, "w"))
  assert(f:write(text))
  f:close()
end

if rex.args.probe == "escalation" then
  local h = assert(rex.exec.start({
    "/bin/sh",
    "-c",
    'trap "" TERM; echo $$ > "$1"; exec /bin/sleep 20',
    "sh",
    rex.args.home .. "/worker.pid",
  }, { stdout = false, stderr = false }))
  local term_sent, kill_sent = false, false
  rex.after(0.1, function()
    term_sent = true
    h:kill("SIGTERM")
    rex.after(0.1, function()
      kill_sent = true
      h:kill("SIGKILL")
    end)
  end)
  local result = h:wait(1)
  local completed = result ~= nil
  if not completed then
    h:kill("SIGKILL")
    h:wait(1)
  end
  return { completed = completed, term_sent = term_sent, kill_sent = kill_sent }
end

if rex.args.probe == "wait-escalation" then
  local h = assert(rex.exec.start({
    "/bin/sh",
    "-c",
    'trap "" TERM; echo $$ > "$1"; exec /bin/sleep 20',
    "sh",
    rex.args.home .. "/worker.pid",
  }, { stdout = false, stderr = false }))
  assert(h:wait(0.1) == nil)
  h:kill("SIGTERM")
  assert(h:wait(0.1) == nil)
  h:kill("SIGKILL")
  local result = assert(h:wait(1))
  return { completed = true, signal = result.signal }
end

if rex.args.probe == "cleanup-signal" or rex.args.probe == "cleanup-group" or rex.args.probe == "runtime-cancel" then
  local argv = {
    "/bin/sh",
    "-c",
    [[trap 'echo TERM > "$1/term-seen"; exit 0' TERM;
      echo $$ > "$1/worker.pid";
      /bin/sh -c 'echo $$ > "$1/grandchild.pid"; exec /bin/sleep 20' sh "$1" & wait]],
    "sh",
    rex.args.home,
  }
  if rex.args.probe == "cleanup-group" then
    table.insert(argv, 1, rex.args.root .. "/tests/helpers/rex-process-group-probe.sh")
    table.insert(argv, 1, "/bin/sh")
  end
  if rex.args.probe == "runtime-cancel" then
    local R = require("lua.navigation.runtime").new({ root = rex.args.root, host = rex })
    return R:run(argv, { timeout = 20 })
  end
  local h = assert(rex.exec.start(argv, { stdout = false, stderr = false }))
  write(rex.args.home .. "/holder.pid", tostring(h.pid))
  h:wait(25)
  return
end

if rex.args.probe == "parent-death" or rex.args.probe == "worker-lock" then
  local argv = {
    "/usr/bin/lockf",
    "-k",
    "-s",
    "-t",
    "0",
    rex.args.home .. "/scratch.lock",
    "/bin/sh",
    "-c",
    'echo $$ > "$1"; exec /bin/sleep 20',
    "sh",
    rex.args.home .. "/worker.pid",
  }
  if rex.args.probe == "worker-lock" then
    argv = {
      "/bin/sh",
      "-c",
      'exec 3>>"$1"; shift; /usr/bin/lockf -s -t 0 3 || exit $?; ' .. 'echo $$ > "$1"; exec /bin/sleep 20',
      "sh",
      rex.args.home .. "/scratch.lock",
      rex.args.home .. "/worker.pid",
    }
  end
  local h = assert(rex.exec.start(argv, { stdout = false, stderr = false }))
  write(rex.args.home .. "/holder.pid", tostring(h.pid))
  h:wait(25)
  return
end

if rex.args.probe == "module" then
  local runtime = require("lua.navigation.runtime")
  assert(type(runtime.new) == "function")
  local R = runtime.new({ root = rex.args.root, host = rex })
  assert(type(R.run) == "function")
  return { loaded = true }
end

if rex.args.probe == "run" then
  local R = require("lua.navigation.runtime").new({ root = rex.args.root, host = rex })
  return R:run(rex.args.argv, rex.args.options or {})
end

if rex.args.probe == "leaf-latency" then
  local R = require("lua.navigation.runtime").new({ root = rex.args.root, host = rex })
  for _ = 1, 10 do
    local result = rex.args.native and rex.exec({ "/usr/bin/true" }) or R:run({ "/usr/bin/true" })
    assert(result.ok)
  end
  return { completed = 10 }
end

if rex.args.probe == "interfaces" then
  local host = { exec = rex.exec, json = rex.json }
  host.call = function(method, args)
    if method == "fail" then
      return nil, "synthetic failure"
    end
    return { method = method, args = args }
  end
  host.block = {
    call = function(creator, method, args)
      return { creator = creator, method = method, args = args }
    end,
  }
  local R = require("lua.navigation.runtime").new({ root = rex.args.root, host = host })
  local input = { format = "text" }
  local call = R:call("session.list", { key = "value" })
  local block = R:block_call("session:a", "block:b", "format", input)
  assert(input.session_id == nil and input.block_id == nil)
  local ok, err = pcall(function()
    R:call("fail", {})
  end)
  assert(not ok and tostring(err):find("synthetic failure", 1, true))
  local argv = R:script_argv("snapshot", { directory = "123", label = "quote'\n" })
  return { call = call, block = block, argv = argv }
end

if rex.args.probe == "select-client" then
  local R = require("lua.navigation.runtime").new({ root = rex.args.root, host = rex })
  R:select_client("client:mac", "session:target")
  return { selected = true }
end

if rex.args.probe == "recursive" then
  local R = require("lua.navigation.runtime").new({ root = rex.args.root, host = rex })
  return R:run({
    R:command_path("rex"),
    "--autostart=false",
    "do",
    rex.args.entry,
    "--args",
    rex.json.encode({ probe = "forbidden" }),
  })
end

if rex.args.probe == "cancelled-wait" then
  local signals = {}
  local child = {
    wait = function()
      return nil, "context canceled"
    end,
    kill = function(_, signal)
      signals[#signals + 1] = signal
    end,
  }
  local host = { exec = {
    start = function()
      return child
    end,
  } }
  local R = require("lua.navigation.runtime").new({ root = rex.args.root, host = host })
  local ok, err = pcall(function()
    R:run({ "/bin/cat" })
  end)
  assert(not ok)
  return { signals = signals, error = tostring(err) }
end

if rex.args.probe == "forbidden" then
  rex.call("session.create", {})
  error("offline driver allowed a live operation")
end

if rex.args.probe == "stream" then
  local stdout_bytes, stderr_bytes = 0, 0
  local h = assert(rex.exec.start({
    "/bin/sh",
    "-c",
    "/bin/dd if=/dev/zero bs=1024 count=64 2>/dev/null; " .. "/bin/dd if=/dev/zero bs=1024 count=64 >&2 2>/dev/null",
  }, {
    timeout = 3,
    stdout = function(chunk)
      stdout_bytes = stdout_bytes + #chunk
    end,
    stderr = function(chunk)
      stderr_bytes = stderr_bytes + #chunk
    end,
  }))
  local result = assert(h:wait(4))
  assert(result.ok)
  return {
    stdout_bytes = stdout_bytes,
    stderr_bytes = stderr_bytes,
    retained_stdout = result.stdout and #result.stdout or 0,
    retained_stderr = result.stderr and #result.stderr or 0,
    stdout_type = type(result.stdout),
    stderr_type = type(result.stderr),
  }
end

error("Unknown process probe")
