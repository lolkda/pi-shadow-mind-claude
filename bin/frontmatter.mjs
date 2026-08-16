// Minimal YAML frontmatter parser (zero-dependency).
// Supports the subset pi-shadow-mind shadow definitions use:
//   scalars (string/number/boolean/null), plain string lists ("- item"),
//   and inline arrays ([a, b, c]). No nested maps, no multi-line strings.

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "" || value === "~" || value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[+-]?\d+$/.test(value)) return Number(value);
  if (/^[+-]?(\d+\.\d*|\.\d+)(e[+-]?\d+)?$/i.test(value)) return Number(value);
  const unquoted = /^[^"']/.test(value);
  if (unquoted && /^[?!&%|>{}\[\],#]/.test(value)) throw new Error(`unsupported plain scalar: ${value}`);
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) throw new Error(`unterminated double-quoted string: ${value}`);
    return JSON.parse(value);
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error(`unterminated single-quoted string: ${value}`);
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/**
 * Parse the YAML between the frontmatter fences into a plain object.
 * @param {string} yamlText - text between leading `---` and trailing `---`
 */
export function parseYaml(yamlText) {
  const result = {};
  const lines = yamlText.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 0) throw new Error(`expected "key: value", got: ${trimmed}`);
    const key = line.slice(0, separator).trim();
    if (!key) throw new Error("empty key");
    let rest = line.slice(separator + 1).trim();
    // Inline array form: [a, b, c]
    if (rest.startsWith("[")) {
      const end = line.lastIndexOf("]");
      if (end < 0) throw new Error(`unterminated inline array: ${trimmed}`);
      const inner = line.slice(separator + 1, end + 1).trim();
      result[key] = splitQuotedList(inner.slice(1, -1))
        .map((item) => parseScalar(item))
        .filter((item) => item !== null);
      continue;
    }
    // Empty value may introduce a block list (common but unused here): consume as empty list.
    if (rest === "" || rest === "null") {
      // Peek: does the next non-empty line start with "- "?
      let cursor = index;
      while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
      if (cursor < lines.length && lines[cursor].trimStart().startsWith("- ")) {
        const items = [];
        while (cursor < lines.length) {
          const candidate = lines[cursor].trimStart();
          if (!candidate.startsWith("- ")) break;
          items.push(parseScalar(candidate.slice(2)));
          cursor += 1;
        }
        result[key] = items;
        index = cursor;
      } else {
        result[key] = null;
      }
      continue;
    }
    result[key] = parseScalar(rest);
  }
  return result;
}

/** Split on commas, respecting single/double quoted segments. */
function splitQuotedList(text) {
  const items = [];
  let current = "";
  let quote = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ",") {
      items.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

/**
 * Extract frontmatter from markdown: `---\n<yaml>\n---\n<body>`.
 * @returns {{ meta: Record<string, unknown>, body: string } | null} null when no frontmatter
 */
export function parseFrontmatter(source) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) return null;
  return { meta: parseYaml(match[1]), body: match[2].trim() };
}

/** Serialize a shadow definition back to markdown with YAML frontmatter. */
export function serializeFrontmatter(meta, body) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${yamlQuote(value)}`);
  }
  lines.push("---", "", body ?? "");
  return `${lines.join("\n")}\n`;
}

function yamlQuote(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => yamlQuote(item)).join(", ")}]`;
  return String(value);
}