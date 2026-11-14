import { describe, expect, it } from "vitest";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";

const RUNTIME = "https://runtime.us-east-1.kiro.dev/generateAssistantResponse";
const CODEWHISPERER = "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse";
const Q = "https://q.us-east-1.amazonaws.com/generateAssistantResponse";

function credentials(authMethod, region = "us-east-1") {
  return { providerSpecificData: { authMethod, region } };
}

describe("Kiro auth-aware endpoint routing", () => {
  const executor = new KiroExecutor();

  it("routes API-key inference through Amazon Q before other surfaces", () => {
    expect(executor.getOrderedBaseUrls(credentials("api_key"))).toEqual([
      Q,
      CODEWHISPERER,
      RUNTIME,
    ]);
  });

  it("routes Builder ID OAuth through Amazon Q first (runtime path deprecated)", () => {
    expect(executor.getOrderedBaseUrls(credentials("builder-id"))).toEqual([
      Q,
      CODEWHISPERER,
      RUNTIME,
    ]);
  });

  it("routes external IdP through Amazon Q first", () => {
    expect(executor.getOrderedBaseUrls(credentials("external_idp"))).toEqual([
      Q,
      CODEWHISPERER,
      RUNTIME,
    ]);
  });

  it("keeps us-east-1 hosts when the requested region has no service surface", () => {
    // eu-west-1 is not a covered region for any of the three hosts. Splicing it
    // into the hostname would send the bearer token to a host that does not run
    // the service, so the hosts stay on us-east-1 (the hardcoded baseUrls).
    expect(executor.getOrderedBaseUrls(credentials("idc", "eu-west-1"))).toEqual([
      Q,
      CODEWHISPERER,
      RUNTIME,
    ]);
  });

  it("regionalizes only the AWS hosts, in the regions they actually run in", () => {
    // eu-central-1 is covered for q but not for codewhisperer, so only q moves.
    // runtime.*.kiro.dev is not an AWS host (regionalize skips anything outside
    // amazonaws.com), so it stays on the hardcoded us-east-1 URL.
    expect(executor.getOrderedBaseUrls(credentials("idc", "eu-central-1"))).toEqual([
      "https://q.eu-central-1.amazonaws.com/generateAssistantResponse",
      CODEWHISPERER,
      RUNTIME,
    ]);
  });

  it("retries only endpoint/auth-surface failures, not payload-invalid 400s", () => {
    expect(executor.shouldRetry(400, 0)).toBe(false);
    expect(executor.shouldRetry(401, 1)).toBe(true);
    expect(executor.shouldRetry(403, 2)).toBe(false);
    expect(executor.shouldRetry(422, 0)).toBe(false);
  });

  it("builds endpoint-specific headers", () => {
    const auth = { accessToken: "test-key", providerSpecificData: { authMethod: "api_key" } };
    const qHeaders = executor.buildHeaders(auth, true, Q);
    const codeWhispererHeaders = executor.buildHeaders(auth, true, CODEWHISPERER);
    const runtimeHeaders = executor.buildHeaders(auth, true, RUNTIME);

    expect(qHeaders.TokenType).toBe("API_KEY");
    expect(qHeaders["X-Amz-Target"]).toBeUndefined();
    expect(codeWhispererHeaders["X-Amz-Target"]).toBe(
      "AmazonCodeWhispererStreamingService.GenerateAssistantResponse"
    );
    expect(runtimeHeaders["X-Amz-Target"]).toBeUndefined();
  });
});
