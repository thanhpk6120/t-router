/**
 * Dynamic Tool Gating & Schema Sanitization for OpenAI/Non-Anthropic Targets.
 *
 * Problem:
 * Clients like Claude Code CLI load all registered MCP servers upfront (e.g. 395 tools,
 * ~450KB schema). While Anthropic native API can accept large tool arrays, OpenAI-compatible
 * backends (OpenAI API, Gemini, DeepSeek, Qwen, vLLM, etc.) have constrained grammar decoding
 * or hard limits (e.g. OpenAI's 128 function limit). When presented with 300+ tools, these
 * backends frequently fail silently and return HTTP 200 with 0 tokens (content: []), causing
 * Claude Code to enter an infinite retry loop:
 *   [Your previous response had no visible output. Please continue...]
 *
 * Solution:
 * When tool count exceeds MAX_SAFE_OPENAI_TOOLS (default: 64):
 * 1. ALWAYS preserve 100% of Core/Built-in developer tools (Bash, Edit, Read, Grep, etc.).
 * 2. ALWAYS preserve 100% of Active History Tools (any tool called in the current session).
 * 3. ALWAYS preserve any explicitly selected tool (from tool_choice).
 * 4. Intelligently score & rank MCP tools based on user prompt keywords, namespace relevance,
 *    and ensure fair representation across active MCP servers.
 * 5. Sanitize JSON schemas: strip redundant $schema, coerce string numbers, fix nested types.
 */

export const MAX_SAFE_OPENAI_TOOLS = 64;

// Standard core tools from Claude Code, Codex, and common agent harnesses that should never be pruned.
const CORE_TOOL_NAMES = new Set([
  "bash",
  "glob",
  "grep",
  "read",
  "edit",
  "write",
  "ask",
  "task",
  "todo",
  "wait",
  "eval",
  "web_search",
  "web_fetch",
  "websearch",
  "webfetch",
  "browser",
  "computer",
  "notebook",
  "kill",
  "restart",
  "run",
  "terminal",
]);

/**
 * Common English/Vietnamese stop words to filter out when tokenizing user query.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do",
  "does", "did", "can", "could", "should", "would", "will", "shall", "may", "might",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "this", "that", "these", "those", "and", "or", "but", "not", "so", "then", "there",
  "here", "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
  "la", "va", "cua", "cho", "trong", "tren", "duoi", "voi", "boi", "tu", "den",
  "thi", "la", "ma", "co", "duoc", "khong", "se", "da", "dang", "hay", "hoac",
  "help", "please", "want", "need", "like", "try", "make", "let", "get",
]);

function getToolName(tool) {
  return tool?.name || tool?.function?.name || "";
}

function getToolDescription(tool) {
  return tool?.description || tool?.function?.description || "";
}

function isCoreTool(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (CORE_TOOL_NAMES.has(lower)) return true;
  // Handle prefixes like mcp__core__bash
  const parts = lower.split("__");
  const baseName = parts[parts.length - 1];
  return CORE_TOOL_NAMES.has(baseName);
}

/**
 * Coerce numeric JSON Schema constraints that arrived as strings (e.g. "1" -> 1).
 */
const NUMERIC_SCHEMA_FIELDS = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minLength", "maxLength", "minItems", "maxItems",
  "minProperties", "maxProperties", "multipleOf",
]);

export function coerceSchemaTypes(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map(coerceSchemaTypes);
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!key || typeof key !== "string" || !key.trim()) continue;
    // Strip redundant schema metadata that bloats tokens or causes 400 errors
    if (key === "$schema" || key === "$id") continue;

    // Dictionaries of child schemas: keys are property names, not schema keywords
    if ((key === "properties" || key === "patternProperties" || key === "$defs" || key === "definitions") && value && typeof value === "object" && !Array.isArray(value)) {
      const propMap = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        if (!propName || typeof propName !== "string" || !propName.trim()) continue;
        propMap[propName] = coerceSchemaTypes(propSchema);
      }
      cleaned[key] = propMap;
      continue;
    }

    if (NUMERIC_SCHEMA_FIELDS.has(key) && typeof value === "string") {
      const num = Number(value.trim());
      cleaned[key] = Number.isFinite(num) ? num : value;
    } else if (key === "anyOf" || key === "oneOf") {
      if (Array.isArray(value)) {
        // If it's a simple nullable union: [{ type: "string" }, { type: "null" }]
        const nonNull = value.filter(v => v && v.type !== "null");
        if (nonNull.length === 1 && nonNull[0]?.type) {
          cleaned.type = nonNull[0].type;
          if (nonNull[0].description && !cleaned.description) cleaned.description = nonNull[0].description;
          continue;
        }
        cleaned[key] = value.map(coerceSchemaTypes);
      } else {
        cleaned[key] = value;
      }
    } else if (value && typeof value === "object") {
      cleaned[key] = coerceSchemaTypes(value);
    } else {
      cleaned[key] = value;
    }
  }

  // Ensure object types with properties have explicit type = "object"
  if (cleaned.properties && !cleaned.type) {
    cleaned.type = "object";
  }

  return cleaned;
}

/**
 * Sanitize a tool definition before dispatch to OpenAI format.
 */
export function sanitizeToolDefinition(tool) {
  if (!tool || typeof tool !== "object") return tool;
  const clone = { ...tool };

  if (clone.function && typeof clone.function === "object") {
    clone.function = { ...clone.function };
    if (clone.function.parameters) {
      clone.function.parameters = coerceSchemaTypes(clone.function.parameters);
    }
    if (typeof clone.function.description === "string" && clone.function.description.length > 600) {
      // Keep summary, avoid prompt bloat from massive markdown tables
      clone.function.description = clone.function.description.slice(0, 597) + "...";
    }
  } else if (clone.input_schema) {
    clone.input_schema = coerceSchemaTypes(clone.input_schema);
    if (typeof clone.description === "string" && clone.description.length > 600) {
      clone.description = clone.description.slice(0, 597) + "...";
    }
  }

  return clone;
}

/**
 * Extract active tool names from conversation history.
 */
function extractActiveToolNames(messages) {
  const active = new Set();
  if (!Array.isArray(messages)) return active;

  for (const msg of messages) {
    if (!msg) continue;
    // OpenAI shape
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const name = tc?.function?.name || tc?.name;
        if (name) active.add(name);
      }
    }
    // Claude shape
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === "tool_use" && block.name) {
          active.add(block.name);
        }
      }
    }
  }

  return active;
}

/**
 * Extract significant search tokens from recent user & assistant messages.
 */
function extractQueryKeywords(messages) {
  const textTokens = new Set();
  if (!Array.isArray(messages) || messages.length === 0) return textTokens;

  // Look at the last 3 messages for immediate intent
  const recent = messages.slice(-3);
  for (const msg of recent) {
    let raw = "";
    if (typeof msg.content === "string") {
      raw = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === "text" && part.text) raw += " " + part.text;
      }
    }

    if (raw) {
      const words = raw.toLowerCase().replace(/[^a-zA-Z0-9_]/g, " ").split(/\s+/);
      for (const w of words) {
        if (w.length >= 2 && !STOP_WORDS.has(w)) {
          textTokens.add(w);
        }
      }
    }
  }

  return textTokens;
}

/**
 * Extract the server namespace prefix from a tool name (e.g. "mcp__glab__ci_list" -> "glab").
 */
function getNamespace(name) {
  if (!name) return "default";
  if (name.startsWith("mcp__")) {
    const parts = name.slice(5).split("__");
    return parts[0] || "mcp";
  }
  const parts = name.split("_");
  return parts[0] || "default";
}

/**
 * Score a tool against query tokens.
 */
function scoreTool(tool, tokens) {
  const name = getToolName(tool).toLowerCase();
  const desc = getToolDescription(tool).toLowerCase();
  const ns = getNamespace(name).toLowerCase();
  let score = 0;

  for (const token of tokens) {
    // Exact namespace match (e.g. user asks about "gitlab" / "glab" / "jira" / "confluence" / "browser")
    if (ns.includes(token) || token.includes(ns)) {
      score += 30;
    }
    // Tool name match
    if (name.includes(token)) {
      score += 15;
    }
    // Tool description match
    if (desc.includes(token)) {
      score += 3;
    }
  }

  // Common high-utility operations get a slight baseline boost
  if (/list|get|status|search|read|info|find|view|check/i.test(name)) {
    score += 1;
  }

  return score;
}

/**
 * Intelligently prune and sanitize tools when count exceeds maxTools.
 *
 * @param {Array} tools - Original tools array
 * @param {Object} [options]
 * @param {Array} [options.messages] - Conversation messages for context
 * @param {Object|string} [options.toolChoice] - tool_choice from request
 * @param {number} [options.maxTools=MAX_SAFE_OPENAI_TOOLS] - Maximum safe tools
 * @returns {Array} Pruned and sanitized tools array
 */
export function gateAndPruneTools(tools, options = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;

  // Filter out any tool that lacks a valid non-empty name
  const validTools = tools.filter(tool => {
    const name = getToolName(tool);
    return typeof name === "string" && name.trim().length > 0;
  });

  const maxTools = options.maxTools || MAX_SAFE_OPENAI_TOOLS;

  // Always sanitize schemas regardless of tool count
  if (validTools.length <= maxTools) {
    return validTools.map(sanitizeToolDefinition);
  }
  const messages = options.messages || [];
  const activeToolNames = extractActiveToolNames(messages);
  const queryTokens = extractQueryKeywords(messages);

  // If tool_choice explicitly targets a tool, pin it
  let requiredToolName = null;
  if (options.toolChoice) {
    if (typeof options.toolChoice === "string" && options.toolChoice !== "auto" && options.toolChoice !== "none" && options.toolChoice !== "required") {
      requiredToolName = options.toolChoice;
    } else if (typeof options.toolChoice === "object") {
      requiredToolName = options.toolChoice.name || options.toolChoice.function?.name || null;
    }
  }

  const pinned = [];
  const candidatePool = [];

  for (const tool of validTools) {
    const name = getToolName(tool);
    if (
      isCoreTool(name) ||
      activeToolNames.has(name) ||
      (requiredToolName && name === requiredToolName)
    ) {
      pinned.push(tool);
    } else {
      candidatePool.push(tool);
    }
  }

  // If pinned alone exceed maxTools, keep all pinned (core tools should never be truncated)
  if (pinned.length >= maxTools) {
    return pinned.map(sanitizeToolDefinition);
  }

  const remainingSlots = maxTools - pinned.length;

  // Score candidate tools
  const scored = candidatePool.map(tool => ({
    tool,
    score: scoreTool(tool, queryTokens),
    namespace: getNamespace(getToolName(tool)),
  }));

  // Separate tools with positive keyword scores from baseline tools
  const relevant = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  const baseline = scored.filter(s => s.score === 0);

  const selected = [];
  const selectedNames = new Set(pinned.map(getToolName));

  // Add relevant tools first
  for (const item of relevant) {
    if (selected.length >= remainingSlots) break;
    const name = getToolName(item.tool);
    if (!selectedNames.has(name)) {
      selected.push(item.tool);
      selectedNames.add(name);
    }
  }

  // If slots remain, ensure fair representation across MCP namespaces
  if (selected.length < remainingSlots) {
    const byNamespace = new Map();
    for (const item of baseline) {
      if (!byNamespace.has(item.namespace)) byNamespace.set(item.namespace, []);
      byNamespace.get(item.namespace).push(item.tool);
    }

    // Round-robin pick from each namespace so no single server starves others
    let added = true;
    while (selected.length < remainingSlots && added) {
      added = false;
      for (const [ns, toolList] of byNamespace.entries()) {
        if (selected.length >= remainingSlots) break;
        const candidate = toolList.shift();
        if (candidate) {
          const name = getToolName(candidate);
          if (!selectedNames.has(name)) {
            selected.push(candidate);
            selectedNames.add(name);
            added = true;
          }
        }
      }
    }
  }

  const finalTools = [...pinned, ...selected];
  return finalTools.map(sanitizeToolDefinition);
}
