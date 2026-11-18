local config = require("lua.navigation.config")
if rex.args.operation == "action" then
  local command
  rex.action = function(action)
    if action.name == "rex_navigator_open_project_picker" then
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
return { encoded = require("lua.navigation.json").encode(config.resolve(rex.args.options)) }
