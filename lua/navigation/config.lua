-- Inline settings validation; project settings also cross the worker boundary.
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

function M.validate_window(window)
  if window == nil then
    window = {}
  end
  assert(type(window) == "table" and window ~= json.null, "window must be a table")
  local function dimension(name, default)
    local value = window[name]
    if value == nil then
      return default
    end
    assert(
      type(value) == "number" and value > 0 and value <= 1,
      "window." .. name .. " must be a number greater than 0 and at most 1"
    )
    return value
  end
  return { width = dimension("width", 0.7), height = dimension("height", 0.6) }
end

function M.validate_projects(projects)
  assert(projects ~= nil, "Configure project discovery with setup({ projects = ... })")
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

return M
