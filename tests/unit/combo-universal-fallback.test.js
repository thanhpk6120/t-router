import { describe, expect, it, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("combo universal fallback — any error falls through to next candidate", () => {
  const errorStatuses = [400, 401, 403, 404, 405, 418, 422, 429, 500, 502, 503, 504, 520];

  for (const status of errorStatuses) {
    it(`falls back to next model on status ${status}`, async () => {
      const handleSingleModel = vi.fn(async (_body, modelStr) => (
        modelStr === "provider-a/m1"
          ? jsonResponse({ error: { message: `Error ${status}` } }, status)
          : jsonResponse({ choices: [{ message: { content: "served by m2" } }] }, 200)
      ));

      const result = await handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        models: ["provider-a/m1", "provider-b/m2"],
        handleSingleModel,
        log: silentLog,
        comboStrategy: "fallback",
      });

      expect(result.status).toBe(200);
      expect(handleSingleModel.mock.calls.map(([, m]) => m)).toEqual([
        "provider-a/m1",
        "provider-b/m2",
      ]);
      const body = await result.json();
      expect(body.choices[0].message.content).toBe("served by m2");
    });
  }

  it("falls back to next model on 499 when client is still connected", async () => {
    const handleSingleModel = vi.fn(async (_body, modelStr) => (
      modelStr === "provider-a/m1"
        ? jsonResponse({ error: { message: "Upstream connection closed" } }, 499)
        : jsonResponse({ choices: [{ message: { content: "served by m2" } }] }, 200)
    ));

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["provider-a/m1", "provider-b/m2"],
      handleSingleModel,
      log: silentLog,
      comboStrategy: "fallback",
      signal: { aborted: false },
    });

    expect(result.status).toBe(200);
    expect(handleSingleModel.mock.calls.map(([, m]) => m)).toEqual([
      "provider-a/m1",
      "provider-b/m2",
    ]);
  });

  it("stops combo and returns 499 when client explicitly aborted", async () => {
    const handleSingleModel = vi.fn(async () => (
      jsonResponse({ error: { message: "Request aborted" } }, 499)
    ));

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["provider-a/m1", "provider-b/m2"],
      handleSingleModel,
      log: silentLog,
      comboStrategy: "fallback",
      signal: { aborted: true },
    });

    expect(result.status).toBe(499);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("falls back to next model when model throws AbortError but client is not aborted", async () => {
    const handleSingleModel = vi.fn(async (_body, modelStr) => {
      if (modelStr === "provider-a/m1") {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      return jsonResponse({ choices: [{ message: { content: "served by m2" } }] }, 200);
    });

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["provider-a/m1", "provider-b/m2"],
      handleSingleModel,
      log: silentLog,
      comboStrategy: "fallback",
      signal: { aborted: false },
    });

    expect(result.status).toBe(200);
    expect(handleSingleModel.mock.calls.map(([, m]) => m)).toEqual([
      "provider-a/m1",
      "provider-b/m2",
    ]);
  });

  it("falls back to next model when model throws generic Error (network failure)", async () => {
    const handleSingleModel = vi.fn(async (_body, modelStr) => {
      if (modelStr === "provider-a/m1") {
        throw new TypeError("fetch failed: ECONNRESET");
      }
      return jsonResponse({ choices: [{ message: { content: "served by m2" } }] }, 200);
    });

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["provider-a/m1", "provider-b/m2"],
      handleSingleModel,
      log: silentLog,
      comboStrategy: "fallback",
    });

    expect(result.status).toBe(200);
    expect(handleSingleModel.mock.calls.map(([, m]) => m)).toEqual([
      "provider-a/m1",
      "provider-b/m2",
    ]);
  });

  it("returns request-scoped failure when all models fail", async () => {
    const handleSingleModel = vi.fn(async (_body, modelStr) => (
      modelStr === "provider-a/m1"
        ? jsonResponse({ error: { message: "Context length exceeded" } }, 400)
        : jsonResponse({ error: { message: "Internal server error" } }, 500)
    ));

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["provider-a/m1", "provider-b/m2"],
      handleSingleModel,
      log: silentLog,
      comboStrategy: "fallback",
    });

    expect(result.status).toBe(400);
    const body = await result.json();
    expect(body.error.message).toBe("Context length exceeded");
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });
});
