// Test 1: Developer role and multiple system messages
import { openaiToAntigravityRequest } from "../open-sse/translator/request/openai-to-gemini.js";
import { geminiToOpenAIResponse } from "../open-sse/translator/response/gemini-to-openai.js";
import { storeGeminiThoughtSignature, getGeminiThoughtSignatureSync } from "../open-sse/services/thoughtSignatureStore.js";

let passed = 0;

// Test 1: developer role & multiple system messages
const body = {
  messages: [
    { role: "developer", content: "OMP_CORE_DEV_PROMPT" },
    { role: "system", content: "GLOBAL_RULES_PROMPT" },
    { role: "user", content: "hello" }
  ]
};

const res = openaiToAntigravityRequest("gemini-3.8-flash", body, true);
const sysParts = res.request?.systemInstruction?.parts || [];
console.log("sysParts count:", sysParts.length);
if (sysParts.length === 2 && sysParts[0].text === "OMP_CORE_DEV_PROMPT" && sysParts[1].text === "GLOBAL_RULES_PROMPT") {
  console.log("PASS 1: Developer role and system message accumulation verified!");
  passed++;
} else {
  console.error("FAIL 1: sysParts:", sysParts);
}

// Test 2: Signature compatibility across model aliases
const callId = "test_sig_call_001";
const sig = "sig_content_xyz_999";
storeGeminiThoughtSignature(callId, sig, null, "gemini-3.8-flash");
const gotSig = getGeminiThoughtSignatureSync(callId, null, "claude-sonnet-5");
if (gotSig === sig) {
  console.log("PASS 2: Thought signature retrieved across claude-sonnet-5 -> gemini-3.8-flash!");
  passed++;
} else {
  console.error("FAIL 2: Got signature:", gotSig);
}

// Test 3: Leaked tool call recovery
const state = { messageId: "msg_1", model: "claude-sonnet-5", functionIndex: 0, geminiToolCallCount: 0 };
const chunk = {
  response: {
    candidates: [{
      content: {
        parts: [{
          text: "[Pre-flight] Tier: 1 | Skills: None | Plugins/MCP: None | Rationale: So sánh}call:default_api:bash{command:node -e 'console.log(123)',i:Test}"
        }]
      }
    }]
  }
};
const resChunks = geminiToOpenAIResponse(chunk, state);
const tc = resChunks?.find(c => c.choices?.[0]?.delta?.tool_calls?.length > 0)?.choices[0].delta.tool_calls[0];
console.log("Salvaged tool call:", tc);
if (tc && tc.function.name === "bash" && tc.function.arguments.includes("console.log(123)")) {
  console.log("PASS 3: Leaked tool call successfully salvaged into OpenAI tool_calls delta!");
  passed++;
} else {
  console.error("FAIL 3: Tool call not salvaged");
}

console.log(`\nFinal: ${passed}/3 checks passed!`);
if (passed === 3) process.exit(0);
else process.exit(1);
