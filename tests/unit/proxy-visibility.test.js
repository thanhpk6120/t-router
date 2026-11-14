// Proxy visibility guards: the dashboard must be able to prove which proxy a
// provider uses, not just that a pool is bound. The exit IP is the proof.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const read = (relPath) => readFileSync(join(repoRoot, relPath), "utf8");

describe("exit-IP probe", () => {
  const proxyTest = read("src/lib/network/proxyTest.js");
  const route = read("src/app/api/proxy-pools/[id]/test/route.js");

  it("exists and rides the proxy dispatcher", () => {
    expect(proxyTest).toContain("export async function probeExitIp");
    expect(proxyTest).toContain("new ProxyAgent({ uri: normalizedProxyUrl })");
    // Two echo endpoints so one blocked host does not hide the IP.
    expect(proxyTest).toContain("api.ipify.org");
    expect(proxyTest).toContain("ifconfig.me/ip");
  });

  it("refuses to pretend Direct is a proxy", () => {
    expect(proxyTest).toContain('return { ok: false, error: "Direct is not a proxy" }');
  });

  it("is reported and persisted by the pool test route", () => {
    expect(route).toContain("probeExitIp");
    expect(route).toContain("lastExitIp");
    expect(route).toContain("exitIp,");
  });
});

describe("dashboard shows the proxy in use", () => {
  const card = read("src/shared/components/NoAuthProxyCard.js");
  const poolsPage = read("src/app/(dashboard)/dashboard/proxy-pools/page.js");

  it("the provider card summarises the effective proxy", () => {
    expect(card).toContain("Effective");
    // Precedence must match getProviderCredentials: an explicit pool wins, and
    // rotation is only what happens when the selector is empty.
    expect(card).toContain("const explicitPool = proxyPoolId && proxyPoolId !== NONE_PROXY_POOL_VALUE");
    expect(card).toContain("const usesRotation = !explicitPool && isRotation");
    expect(card).toContain("const effectiveLabel = usesRotation");
    expect(card).toContain("Check exit IP");
    expect(card).toContain("Exit IP via ${exitCheck.poolName}");
    // A per-connection pool wins over this setting; say so instead of lying.
    expect(card).toContain("overrides this setting for that connection");
  });

  it("the proxy pool card keeps the last exit IP", () => {
    expect(poolsPage).toContain("pool.lastExitIp");
    expect(poolsPage).toContain("data.exitIp");
  });
});
