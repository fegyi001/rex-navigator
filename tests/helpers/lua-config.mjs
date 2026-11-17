// Serialize test data to Lua source; no production dependency on this helper.
export function luaLiteral(value) {
  if (typeof value === "string") return `"${value.replace(/[\\"\x00-\x1f\x7f]/g, (char) =>
    char === '"' || char === "\\" ? `\\${char}` : `\\${char.charCodeAt(0).toString().padStart(3, "0")}`)}"`;
  if (Array.isArray(value)) return `{${value.map(luaLiteral).join(",")}}`;
  if (value && typeof value === "object") return `{${Object.entries(value).map(([key, item]) => `[${luaLiteral(key)}]=${luaLiteral(item)}`).join(",")}}`;
  return value === null ? "false" : String(value);
}
