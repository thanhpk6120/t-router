import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE, CLAUDE_BLOCK, MODEL_FALLBACK } from "../schema/index.js";
import { fromOpenAIFinish } from "../concerns/finishReason.js";
import { extractReasoningText } from "../concerns/reasoning.js";
import { fallbackToolCallId } from "../concerns/toolCall.js";

// Legacy "proxy_" prefix used by older request translators. Response strips it
// defensively so tool names from such turns resolve back (e.g. proxy_Read → Read
// for arg sanitization). Current request translator emits no prefix ("") — strip
// is then a no-op. Kept intentionally; do NOT couple to request's empty prefix.
const CLAUDE_OAUTH_TOOL_PREFIX = "proxy_";

// Sanitize tool call arguments to fix bad params from non-Anthropic models
function sanitizeToolArgs(toolName, argsJson) {
  try {
    const args = JSON.parse(argsJson);
    const name = toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)
      ? toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
      : toolName;
    if (name === "Read") sanitizeReadArgs(args);
    return JSON.stringify(args);
  } catch {
    return argsJson;
  }
}

// DeepSeek and other non-Anthropic models occasionally stream truncated or
// trailing-comma JSON. Claude Code hard-fails on malformed partial_json, so
// repair (or fall back to {}) rather than emitting the raw text.
function repairToolArgsJson(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "{}";
  try { JSON.parse(raw); return raw; } catch {}

  const noTrailingCommas = raw.replace(/,\s*([}\]])/g, "$1");
  try { JSON.parse(noTrailingCommas); return noTrailingCommas; } catch {}

  let inStr = false;
  let esc = false;
  const stack = [];
  for (const ch of noTrailingCommas) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let closed = noTrailingCommas;
  if (inStr) closed += '"';
  while (stack.length) closed += stack.pop();
  try { JSON.parse(closed); return closed; } catch {}

  return "{}";
}

function sanitizeReadArgs(args) {
  if (typeof args.limit === "string" && /^\d+$/.test(args.limit)) args.limit = Number(args.limit);
  if (typeof args.offset === "string" && /^-?\d+$/.test(args.offset)) args.offset = Number(args.offset);

  if (typeof args.limit === "number") {
    if (args.limit > 2000) args.limit = 2000;
    if (args.limit < 1) delete args.limit;
  }
  if (typeof args.offset === "number" && args.offset < 0) args.offset = 0;

  if ("pages" in args && !isValidPdfPagesArg(args.file_path, args.pages)) {
    delete args.pages;
  }
}

function isValidPdfPagesArg(filePath, pages) {
  return typeof filePath === "string" &&
    filePath.toLowerCase().endsWith(".pdf") &&
    typeof pages === "string" &&
    /^\d+(?:-\d+)?$/.test(pages);
}

// Helper: stop thinking block if started
function stopThinkingBlock(state, results) {
  if (!state.thinkingBlockStarted) return;
  results.push({
    type: "content_block_stop",
    index: state.thinkingBlockIndex
  });
  state.thinkingBlockStarted = false;
}

// Helper: stop text block if started
function stopTextBlock(state, results) {
  if (!state.textBlockStarted || state.textBlockClosed) return;
  state.textBlockClosed = true;
  results.push({
    type: "content_block_stop",
    index: state.textBlockIndex
  });
  state.textBlockStarted = false;
}

// Convert OpenAI stream chunk to Claude format
export function openaiToClaudeResponse(chunk, state) {
  if (!chunk || !chunk.choices?.[0]) return null;

  const results = [];
  const choice = chunk.choices[0];
  const delta = choice.delta;

  // Track usage from OpenAI chunk if available
  if (chunk.usage && typeof chunk.usage === "object") {
    const promptTokens = typeof chunk.usage.prompt_tokens === "number" ? chunk.usage.prompt_tokens : 0;
    const outputTokens = typeof chunk.usage.completion_tokens === "number" ? chunk.usage.completion_tokens : 0;

    // Extract cache tokens from prompt_tokens_details
    const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
    const cacheCreationTokens = chunk.usage.prompt_tokens_details?.cache_creation_tokens;
    const cacheReadTokens = typeof cachedTokens === "number" ? cachedTokens : 0;
    const cacheCreateTokens = typeof cacheCreationTokens === "number" ? cacheCreationTokens : 0;

    // input_tokens = prompt_tokens - cached_tokens - cache_creation_tokens
    // Because OpenAI's prompt_tokens includes all prompt-side tokens
    const inputTokens = promptTokens - cacheReadTokens - cacheCreateTokens;

    state.usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    };

    // Add cache_read_input_tokens if present
    if (cacheReadTokens > 0) {
      state.usage.cache_read_input_tokens = cacheReadTokens;
    }

    // Add cache_creation_input_tokens if present
    if (cacheCreateTokens > 0) {
      state.usage.cache_creation_input_tokens = cacheCreateTokens;
    }

    // Note: completion_tokens_details.reasoning_tokens is already included in output_tokens
    // No need to add separately as Claude expects total output_tokens
  }

  // First chunk - ALWAYS send message_start first
  if (!state.messageStartSent) {
    state.messageStartSent = true;
    state.messageId = chunk.id?.replace("chatcmpl-", "") || `msg_${Date.now()}`;
    if (!state.messageId || state.messageId === "chat" || state.messageId.length < 8) {
      state.messageId = chunk.extend_fields?.requestId ||
        chunk.extend_fields?.traceId ||
        `msg_${Date.now()}`;
    }
    state.model = chunk.model || MODEL_FALLBACK;
    state.nextBlockIndex = 0;
    results.push({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: ROLE.ASSISTANT,
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  // Handle reasoning (thinking) across vendor shapes - GLM/DeepSeek/Qwen/MiniMax/etc.
  const reasoningContent = extractReasoningText(delta);
  if (reasoningContent) {
    stopTextBlock(state, results);

    if (!state.thinkingBlockStarted) {
      state.thinkingBlockIndex = state.nextBlockIndex++;
      state.thinkingBlockStarted = true;
      results.push({
        type: "content_block_start",
        index: state.thinkingBlockIndex,
        content_block: { type: CLAUDE_BLOCK.THINKING, thinking: "" }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking: reasoningContent }
    });
  }

  // Handle regular content
  if (delta?.content) {
    stopThinkingBlock(state, results);

    if (!state.textBlockStarted) {
      state.textBlockIndex = state.nextBlockIndex++;
      state.textBlockStarted = true;
      state.textBlockClosed = false;
      results.push({
        type: "content_block_start",
        index: state.textBlockIndex,
        content_block: { type: CLAUDE_BLOCK.TEXT, text: "" }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.textBlockIndex,
      delta: { type: "text_delta", text: delta.content }
    });
  }

  // Tool calls
  if (delta?.tool_calls) {
    if (!state.toolCalls) state.toolCalls = new Map();
    if (!state.toolArgBuffers) state.toolArgBuffers = new Map();
    // Synthetic slots for parallel calls that reuse an index (DeepSeek does
    // this). Negative so they never collide with provider-supplied indices.
    if (state.nextToolIdx === undefined) state.nextToolIdx = -1;

    for (const tc of delta.tool_calls) {
      const incomingId = tc.id || "";
      const incomingName = tc.function?.name || "";
      const incomingArgs = tc.function?.arguments || "";

      let idx;
      let entry;

      // 1) Provider index, unless a different id on the same index signals
      //    parallel-call index reuse.
      if (tc.index !== undefined && tc.index !== null) {
        idx = tc.index;
        entry = state.toolCalls.get(idx);
        if (entry && incomingId && entry.id && entry.id !== incomingId) {
          idx = state.nextToolIdx--;
          entry = undefined;
        }
      }

      // 2) No index: match by id across open blocks.
      if (idx === undefined && incomingId) {
        for (const [k, v] of state.toolCalls) {
          if (v.id === incomingId) { idx = k; entry = v; break; }
        }
      }

      // 3) Still unresolved: adopt a pending anonymous slot (args streamed
      //    before identity) or start a fresh one.
      if (idx === undefined) {
        const last = state.lastToolIdx;
        const lastEntry = last !== undefined ? state.toolCalls.get(last) : undefined;
        if (incomingId || incomingName) {
          if (last !== undefined && !lastEntry && state.toolArgBuffers.has(last)) {
            idx = last;
          } else if (lastEntry && incomingId && lastEntry.id === incomingId) {
            idx = last;
            entry = lastEntry;
          } else {
            idx = state.nextToolIdx--;
          }
        } else {
          idx = state.lastToolIdx ?? 0;
          entry = state.toolCalls.get(idx);
        }
      }

      state.lastToolIdx = idx;
      if (!entry) entry = state.toolCalls.get(idx);

      // Open the block as soon as identity is known. Deferring until id
      // arrives used to drop every argument chunk that streamed ahead of it,
      // and emitting an empty name is rejected by Claude.
      if (!entry && (incomingId || incomingName)) {
        stopThinkingBlock(state, results);
        stopTextBlock(state, results);

        const toolBlockIndex = state.nextBlockIndex++;
        let toolName = incomingName;
        if (toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
          toolName = toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length);
        }

        entry = {
          id: incomingId || fallbackToolCallId(toolBlockIndex),
          name: toolName,
          blockIndex: toolBlockIndex,
        };
        state.toolCalls.set(idx, entry);

        results.push({
          type: "content_block_start",
          index: toolBlockIndex,
          content_block: {
            type: CLAUDE_BLOCK.TOOL_USE,
            id: entry.id,
            name: toolName,
            input: {},
          },
        });
      } else if (entry && incomingName && !entry.name) {
        // Backfill a name that arrived after the block opened.
        let toolName = incomingName;
        if (toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
          toolName = toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length);
        }
        entry.name = toolName;
      }

      if (incomingArgs) {
        state.toolArgBuffers.set(
          idx,
          (state.toolArgBuffers.get(idx) || "") + incomingArgs
        );
      }
    }
  }

  // Finish
  if (choice.finish_reason) {
    stopThinkingBlock(state, results);
    stopTextBlock(state, results);

    for (const [idx, toolInfo] of state.toolCalls) {
      const buffered = state.toolArgBuffers?.get(idx) || "";
      // sanitizeToolArgs returns the raw string on parse failure; repair before
      // emitting so Claude Code never receives malformed partial_json.
      const argsJson = repairToolArgsJson(sanitizeToolArgs(toolInfo.name, buffered || "{}"));

      results.push({
        type: "content_block_delta",
        index: toolInfo.blockIndex,
        delta: { type: "input_json_delta", partial_json: argsJson }
      });
      results.push({
        type: "content_block_stop",
        index: toolInfo.blockIndex
      });
    }
    // Anti-Empty Guard: If the model produced 0 content blocks (neither text, thinking, nor tool call),
    // inject a single whitespace text delta to ensure Claude Code receives visible output and does not enter
    // the infinite retry loop: [Your previous response had no visible output...]
    if (state.nextBlockIndex === 0) {
      const emptyBlockIdx = state.nextBlockIndex++;
      results.push({
        type: "content_block_start",
        index: emptyBlockIdx,
        content_block: { type: CLAUDE_BLOCK.TEXT, text: "" }
      });
      results.push({
        type: "content_block_delta",
        index: emptyBlockIdx,
        delta: { type: "text_delta", text: " " }
      });
      results.push({
        type: "content_block_stop",
        index: emptyBlockIdx
      });
    }

    // Mark finish for later usage injection in stream.js
    state.finishReason = choice.finish_reason;

    // Use tracked usage (will be estimated in stream.js if not valid)
    const finalUsage = state.usage || { input_tokens: 0, output_tokens: 0 };
    results.push({
      type: "message_delta",
      delta: { stop_reason: convertFinishReason(choice.finish_reason) },
      usage: finalUsage
    });
    results.push({ type: "message_stop" });
  }

  return results.length > 0 ? results : null;
}

const convertFinishReason = (reason) => fromOpenAIFinish(reason, "claude");

// Register
register(FORMATS.OPENAI, FORMATS.CLAUDE, null, openaiToClaudeResponse);
