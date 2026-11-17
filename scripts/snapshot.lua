-- One bounded read-only snapshot request chain, supervised by session-preview.lua.
local source = debug.getinfo(1, "S").source:gsub("^@", "")
local root = assert(source:match("^(.*)/scripts/[^/]+$"), "Could not locate Rex navigation modules")
package.path = root .. "/?.lua;" .. root .. "/?/init.lua;" .. package.path
local R = require("lua.navigation.runtime").new({ root = root })
return require("lua.navigation.preview").new(R):snapshot(rex.args.session, rex.args.rows)
