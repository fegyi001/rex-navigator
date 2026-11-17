-- Exercise real configuration actions without contacting Rex or opening windows.
local root = assert(arg[1])
package.path = root .. "/?.lua;" .. root .. "/?/init.lua;" .. package.path

local actions, bindings, commands, queued = {}, {}, {}, {}
local layers, windows, described = {}, {}, {}
local fail_toggle = false
local fail_layer, fail_describe = false, false
local placement, source_window = "placed", "window:source"
rex = {
  action = function(action)
    actions[action.name] = action
  end,
  bind = function(key, action)
    bindings[key] = action
  end,
  layout = {
    block = function(block)
      return block
    end,
  },
  session = {
    new_window = function(options)
      windows[#windows + 1] = options
      commands[#commands + 1] = options.layout.options.command
      return { window_id = "window:picker" }
    end,
    new_layer = function(options)
      layers[#layers + 1] = options
      if fail_layer then
        return nil, "Floating layer creation failed"
      end
      commands[#commands + 1] = options.layout.options.command
      return { layer_id = "layer:picker", block_ids = { "block:picker" } }
    end,
    describe_block = function(options)
      described[#described + 1] = options
      if fail_describe then
        return nil, "Source block no longer exists"
      end
      return { block = { placement = placement, window_id = source_window } }
    end,
  },
  exec = function(argv)
    commands[#commands + 1] = argv
    return { ok = not fail_toggle, stderr = "No previous session yet" }
  end,
  client = {
    queue = function(action, args)
      queued[#queued + 1] = { action, args }
    end,
  },
}

require("lua.navigation")
assert(next(actions) == nil and #commands == 0 and #layers == 0, "requiring the plugin must have no effects")
require("lua.navigation").setup()
assert(next(bindings) == nil, "plugin must not own host keybindings")
local ctx = { client_id = "client:mac", session_id = "session:a", block_id = "block:source" }
actions.open_session_picker.run(ctx)
assert(#layers == 1 and #windows == 0, "session picker must create a floating layer, not a tab")
assert(#commands == 1 and #queued == 0, "floating picker must not sleep or queue a new-window selection")
assert(#described == 1 and described[1].block_id == ctx.block_id)
assert(layers[1].window_id == "window:source", "use invoking pane's window rather than server-active window")
assert(layers[1].focus == true, "floating picker must focus automatically")
local bounds = layers[1].bounds
assert(#bounds == 4 and bounds[1] == 0.15 and bounds[2] == 0.2 and bounds[3] == 0.7 and bounds[4] == 0.6)
assert(layers[1].layout.flavor == "com.superlogical.terminal.shell")
local exit = layers[1].layout.options.exit
assert(
  exit.on_completion == true and exit.quick_exit_threshold_ms == 0,
  "picker must close even after quick cancellation"
)
local picker = commands[1]
assert(picker[1] == "/bin/sh")
assert(picker[2] == root .. "/scripts/navigation.sh")
assert(picker[3] == "session" and picker[4] == "pick" and picker[5] == "--client" and picker[6] == ctx.client_id)
assert(picker[7] == "--current" and picker[8] == ctx.session_id and picker[9] == "--picker-tab")

actions.open_session_picker.run({ client_id = ctx.client_id, session_id = ctx.session_id })
assert(#layers == 2 and layers[2].window_id == nil, "missing pane context should use active-window default")
assert(#described == 1, "do not describe a missing block ID")

local function rejects_picker(context, expected)
  local before = #layers
  local ok, err = pcall(actions.open_session_picker.run, context)
  assert(not ok and tostring(err):find(expected, 1, true), tostring(err))
  assert(#layers == before, "invalid source context must not create a floating layer")
end
fail_describe = true
rejects_picker(ctx, "Source block no longer exists")
fail_describe = false
placement = "detached"
rejects_picker(ctx, "placed")
placement = "placed"
source_window = nil
rejects_picker(ctx, "window")
source_window = "window:source"
rejects_picker({}, "Rex app")
rejects_picker({ client_id = ctx.client_id }, "existing session")
rejects_picker({ session_id = ctx.session_id }, "Rex app")
fail_layer = true
local layer_ok, layer_err = pcall(actions.open_session_picker.run, ctx)
assert(not layer_ok and tostring(layer_err):find("Floating layer creation failed", 1, true))
fail_layer = false
assert(#windows == 0 and #queued == 0, "failures must not fall back to another window")

actions.last_used_session.run(ctx)
local toggle = commands[#commands]
assert(toggle[1] == "/bin/sh" and toggle[2] == picker[2] and toggle[3] == "session" and toggle[4] == "toggle")
assert(toggle[5] == "--client" and toggle[6] == ctx.client_id)
assert(toggle[7] == "--current" and toggle[8] == ctx.session_id)
fail_toggle = true
local ok, err = pcall(actions.last_used_session.run, ctx)
assert(not ok and tostring(err):find("No previous session", 1, true))
assert(not pcall(actions.open_session_picker.run, {}), "missing context must not open a picker")
fail_toggle = false
local layers_before, commands_before, described_before = #layers, #commands, #described
actions.open_project_picker.run(ctx)
assert(#layers == layers_before + 1 and #windows == 0, "project picker must float without creating a tab")
assert(#commands == commands_before + 1 and #queued == 0, "project picker must not sleep or queue a window selection")
local project_layer = layers[#layers]
assert(#described == described_before + 1 and described[#described].block_id == ctx.block_id)
assert(project_layer.window_id == "window:source", "project picker must target the invoking pane's window")
assert(project_layer.focus == true, "project picker must focus automatically")
local project_bounds = project_layer.bounds
assert(
  #project_bounds == 4
    and project_bounds[1] == 0.15
    and project_bounds[2] == 0.2
    and project_bounds[3] == 0.7
    and project_bounds[4] == 0.6
)
assert(project_layer.layout.flavor == "com.superlogical.terminal.shell")
local project_options = project_layer.layout.options
assert(project_options.cwd == os.getenv("HOME"), "project picker must retain its home cwd")
assert(project_options.exit.on_completion == true and project_options.exit.quick_exit_threshold_ms == 0)
local project = commands[#commands]
assert(project[1] == "/bin/sh" and project[2] == picker[2] and project[3] == "project")
assert(#project == 8 and project[4] == "--client" and project[5] == ctx.client_id)
assert(project[6] == "--current" and project[7] == ctx.session_id and project[8] == "--picker-tab")

described_before = #described
actions.open_project_picker.run({ client_id = ctx.client_id, session_id = ctx.session_id })
assert(
  layers[#layers].window_id == nil and #described == described_before,
  "no block context must use active-window default"
)

local function rejects_project(context, expected)
  local before = #layers
  local ok, err = pcall(actions.open_project_picker.run, context)
  assert(not ok and tostring(err):find(expected, 1, true), tostring(err))
  assert(#layers == before, "invalid project context must not create a layer")
end
fail_describe = true
rejects_project(ctx, "Source block no longer exists")
fail_describe = false
placement = "detached"
rejects_project(ctx, "placed")
placement = "placed"
source_window = nil
rejects_project(ctx, "window")
source_window = "window:source"
rejects_project({}, "Rex app")
rejects_project({ client_id = ctx.client_id }, "existing workspace")
rejects_project({ session_id = ctx.session_id }, "Rex app")
fail_layer = true
local project_ok, project_err = pcall(actions.open_project_picker.run, ctx)
assert(not project_ok and tostring(project_err):find("Floating layer creation failed", 1, true))
fail_layer = false
assert(#windows == 0 and #queued == 0, "neither picker may fall back to a temporary tab")
print("Lua session bindings/actions OK")
