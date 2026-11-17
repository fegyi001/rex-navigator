local json = require("lua.navigation.json")
local R = require("lua.navigation.runtime").new({ root = rex.args.root, host = rex })

if rex.args.probe == "json" then
  assert(json.is_object(json.decode("{}")))
  assert(not json.is_array(json.decode("{}")))
  assert(json.is_array(json.decode("[]")))
  assert(not json.is_object(json.decode("[]")))
  assert(json.decode("[null]")[1] == json.null)
  assert(json.decode('{"shared":null}').shared == json.null)
  local encoded = json.encode(json.decode('{"a":[null,{},[],true,false,1.5,"é\\n"]}'))
  local roundtrip = json.decode(encoded).a
  assert(#roundtrip == 7 and roundtrip[1] == json.null)
  assert(json.is_object(roundtrip[2]) and json.is_array(roundtrip[3]))
  assert(roundtrip[4] == true and roundtrip[5] == false and roundtrip[6] == 1.5 and roundtrip[7] == "é\n")
  for _, invalid in ipairs({ "{} trailing", "[1,]", '{"a":}', '"\\x"', "01", "1e", "[", "null null" }) do
    assert(not pcall(json.decode, invalid), "Accepted invalid JSON: " .. invalid)
  end
  return { valid = true }
end

if rex.args.probe == "save" then
  local path = rex.args.home .. "/data/state.json"
  if rex.args.fail == "fsync" then
    local run = R.run
    R.run = function(self, argv, options)
      if argv[1] == "/bin/dd" then
        return { ok = false, stderr = "synthetic fsync failure" }
      end
      return run(self, argv, options)
    end
  elseif rex.args.fail == "rename" then
    os.rename = function()
      return nil, "synthetic rename failure"
    end
  elseif rex.args.fail == "write" then
    local open = io.open
    io.open = function(name, mode)
      if mode == "w" then
        return nil, "synthetic write failure"
      end
      return open(name, mode)
    end
  end
  R:save_json(path, json.decode('{"new":[null,{}]}'))
  local value = R:read_json(path, nil)
  assert(value.new[1] == json.null and json.is_object(value.new[2]))
  return { saved = true }
end

if rex.args.probe == "decode-invalid-file" then
  R:read_json(rex.args.home .. "/data/state.json", {})
  error("Malformed state was accepted")
end

if rex.args.probe == "transaction" then
  return R:transaction(rex.args.kind or "session", rex.args.request or {}, rex.args.wait or 0)
end

if rex.args.probe == "lock-arguments" then
  local captured
  R.run = function(_, argv)
    captured = argv
    return { ok = true, stdout = "" }
  end
  R:transaction("session", {}, 20)
  assert(not pcall(function()
    R:transaction("session", {}, 21)
  end))
  return { wait = captured[3], lock = captured[4] }
end

if rex.args.probe == "empty-xdg" then
  local S = require("lua.navigation.sessions").new(R)
  local P = require("lua.navigation.projects").new(R, S)
  local lock
  R.run = function(_, argv)
    lock = argv[4]
    return { ok = true, stdout = "" }
  end
  R:transaction("session", {}, 0)
  return { history = S:history_path(), registry = P:registry_path(), lock = lock }
end

error("Unknown state probe")
