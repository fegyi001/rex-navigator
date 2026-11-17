local text = require("lua.navigation.text")
local R = require("lua.navigation.runtime").new({ root = rex.args.root, host = rex })
if rex.args.probe == "text" then
  return {
    label = text.session_label(rex.args.value),
    preview = text.preview(rex.args.value),
    base = text.project_base(rex.args.value),
    truncated = text.truncate_utf8(rex.args.value, rex.args.bytes or 100),
  }
elseif rex.args.probe == "filesystem" then
  return {
    paths = R:discover(rex.args.roots, rex.args.exclude),
    canonical = R:canonical_path(rex.args.path),
    directory = R:is_directory(rex.args.path),
    hash = R:sha256("abc"),
  }
elseif rex.args.probe == "sort" then
  return R:sort_labels(rex.args.records)
end
error("Unknown text probe")
