local config = require("lua.navigation.config")
if rex.args.operation == "setup" then
  local count = 0
  rex.action = function()
    count = count + 1
  end
  local ok, err = pcall(require("lua.navigation").setup, rex.args.options)
  return { ok = ok, error = tostring(err), actions = count }
end
if rex.args.operation == "action" then
  local command
  rex.action = function(action)
    if action.name == "rex_navigator_create_session" then
      command = action.run
    end
  end
  local launched
  rex.layout = {
    block = function(block)
      return block
    end,
  }
  rex.session = {
    new_layer = function(layer)
      launched = layer.layout.options.command
      return {}
    end,
  }
  require("lua.navigation").setup(rex.args.options)
  assert(command, "Prefixed project action was not registered")
  command({ client_id = "client:mac", session_id = "session:a" })
  return launched
end
-- Rex's automatic return encoder loses empty-array shape; exercise the same
-- strict transport encoder used by setup() when crossing the worker boundary.
local projects = rex.args.options.projects
if rex.args.sparse_roots then
  projects.roots[2] = projects.roots[1]
  projects.roots[1] = nil
end
return { encoded = require("lua.navigation.json").encode({ projects = config.validate_projects(projects) }) }
