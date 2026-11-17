-- Trusted host-owned Lua configuration, shared by actions and CLI workers.
local namespace = (...):match("^(.*)%.config$")
local json = require(namespace .. ".json")
local M = {}

local function nonempty(value)
  return type(value) == "string" and value ~= "" and not value:find("%z")
end

local function list(value, name)
  assert(type(value) == "table" and value ~= json.null, name .. " must be a list")
  local count = 0
  for key in pairs(value) do
    assert(type(key) == "number" and key >= 1 and key % 1 == 0, name .. " must be a list")
    count = count + 1
  end
  for index = 1, count do
    assert(value[index] ~= nil, name .. " must be a contiguous list")
  end
  return count
end

function M.validate_projects(projects)
  assert(type(projects) == "table" and projects ~= json.null, "configuration.projects must be a table")
  assert(list(projects.roots, "projects.roots") > 0, "projects must contain a nonempty roots list")
  local roots = json.array()
  for _, root in ipairs(projects.roots) do
    assert(type(root) == "table" and nonempty(root.path), "each root needs a nonempty path")
    assert(
      root.path:sub(1, 1) == "/" or root.path == "~" or root.path:sub(1, 2) == "~/",
      "root paths must be absolute or start with ~/"
    )
    assert(
      type(root.depth) == "number" and root.depth >= 1 and root.depth < math.huge and root.depth % 1 == 0,
      "each root needs a positive integer depth"
    )
    roots[#roots + 1] = json.object({ path = root.path, depth = root.depth })
  end
  local exclude = projects.exclude
  if exclude == nil then
    exclude = { "node_modules", "vendor", "__pycache__" }
  end
  list(exclude, "exclude")
  local exclusions = json.array()
  for _, name in ipairs(exclude) do
    assert(nonempty(name), "exclude must be a list of directory names")
    exclusions[#exclusions + 1] = name
  end
  return json.object({ roots = roots, exclude = exclusions })
end

function M.default_path()
  local home = os.getenv("XDG_CONFIG_HOME")
  if not home or home == "" then
    home = assert(os.getenv("HOME"), "HOME is not set") .. "/.config"
  end
  return home .. "/rex/navigation-config.lua"
end

function M.load(path)
  path = path or M.default_path()
  assert(nonempty(path), "configuration path must be a nonempty string")
  local chunk, err = loadfile(path)
  assert(chunk, "Could not load navigation configuration " .. path .. ": " .. tostring(err))
  local ok, value = pcall(chunk)
  assert(ok, "Could not execute navigation configuration " .. path .. ": " .. tostring(value))
  assert(type(value) == "table", "Navigation configuration " .. path .. " must return a table")
  return value
end

function M.resolve(options)
  options = options or {}
  assert(type(options) == "table", "navigation options must be a table")
  local projects = options.projects
  if projects == nil then
    projects = M.load(options.config).projects
  end
  return json.object({ projects = M.validate_projects(projects) })
end

return M
