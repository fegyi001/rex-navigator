-- Public entrypoint; keep implementation modules and workers root-relative.
return require((...) .. ".lua.navigation")
