// Deterministic tool-result summarizers. Port of pi-shadow-mind's summaries.ts.

const summarizers = new Map([
  ["Read", summarizeLines],
  ["Grep", summarizeLines],
  ["Glob", summarizeLines],
  ["LS", summarizeLines],
  ["Bash", summarizeBash],
]);

export function summarizeToolResult(result) {
  const toolName = (result && result.toolName) ?? "";
  const summary = val(result, toolName);
  return result && result.isError ? `error · ${summary}` : summary;
}

function val(result, toolName) {
  const summarizer = summarizers.get(toolName);
  return summarizer ? summarizer(result) : summarizeGeneric(result);
}

function summarizeLines(result) {
  const text = textContent(result);
  if (!text || !text.trim()) return "0 entries";
  const lines = text.split(/\r?\n/).filter(Boolean);
  const preview = compact(lines[0] ?? "");
  return `${lines.length} entries${preview ? ` · ${preview}` : ""}`;
}

function summarizeBash(result) {
  const text = textContent(result);
  if (!text || !text.trim()) return "0 lines · no output";
  const lines = text.split(/\r?\n/).filter(Boolean);
  const preview = compact(lines[0] ?? "");
  return `${lines.length} lines${preview ? ` · ${preview}` : ""}`;
}

function summarizeGeneric(result) {
  return describeContent(result && result.content) ?? "no output";
}

function describeContent(content) {
  if (Array.isArray(content)) {
    const blocks = content.filter((block) => Boolean(block) && typeof block === "object");
    if (!blocks.length) return "empty result";
    const counts = new Map();
    for (const block of blocks) {
      const type = block.type ?? "object";
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return [...counts.entries()].map(([type, count]) => `${count} ${type}${count > 1 ? "s" : ""}`).join(" · ");
  }
  if (content === null) return "null";
  if (typeof content === "string") return `text · ${content.length} chars`;
  if (typeof content === "number" || typeof content === "boolean") return `${typeof content} · ${String(content)}`;
  if (typeof content === "object") return `object · ${Object.keys(content).length} keys`;
  return undefined;
}

function textContent(result) {
  const content = result && result.content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => Boolean(part) && typeof part === "object" && part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
  }
  if (typeof content === "string") return content;
  return "";
}

function compact(value) {
  return value.replace(/\s+/g, " ").trim().slice(0, 200);
}