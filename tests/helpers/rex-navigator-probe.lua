local R = require("lua.navigation.runtime").new({ root = rex.args.module_root or rex.args.root })
local request = rex.args.request
local S = require("lua.navigation.sessions").new(R)
local context = { client_id = request.client, session_id = request.current or os.getenv("REX_SESSION") }
if request.operation == "project" then
  local P = require("lua.navigation.projects").new(R, S)
  local directory = request.directory
  if directory == nil then
    local projects = request.projects_json and require("lua.navigation.json").decode(request.projects_json)
    directory = P:pick(projects)
    if directory == nil then
      return
    end
  end
  return P:open(context, directory, request.picker_tab and os.getenv("REX_BLOCK") or nil)
end
assert(request.client and request.current, "--client and --current are required")
if request.operation == "select" then
  assert(request.session, "select requires --session")
end
local target = request.session
if request.operation == "pick" then
  target = S:pick(context)
  if target == nil then
    return
  end
end
return S:switch(context, target)
