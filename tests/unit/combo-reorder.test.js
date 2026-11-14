import { describe, expect, it, vi, beforeEach } from "vitest";
import { sortCombosByOrder } from "../../src/lib/comboOrder.js";

const mockGetCombos = vi.fn();
const mockGetSettings = vi.fn();
const mockUpdateSettings = vi.fn();

vi.mock("@/lib/localDb", () => ({
  getCombos: mockGetCombos,
  getSettings: mockGetSettings,
  updateSettings: mockUpdateSettings,
  createCombo: vi.fn(),
  getComboByName: vi.fn(),
  normalizeRoutableMembers: vi.fn(),
  getInjectVariants: vi.fn(),
  getModelAliases: vi.fn(),
}));

describe("sortCombosByOrder", () => {
  const sample = [
    { id: "c1", name: "alpha", models: ["a/1"] },
    { id: "c2", name: "beta", models: ["b/1"] },
    { id: "c3", name: "gamma", models: ["c/1"] },
  ];

  it("reorders combos according to persisted IDs", () => {
    expect(sortCombosByOrder(sample, ["c3", "c1", "c2"]).map((c) => c.id)).toEqual(["c3", "c1", "c2"]);
  });

  it("places newly added combos after ordered ones while preserving relative order", () => {
    const withNew = [...sample, { id: "c4", name: "delta", models: [] }];
    expect(sortCombosByOrder(withNew, ["c2"]).map((c) => c.id)).toEqual(["c2", "c1", "c3", "c4"]);
  });

  it("falls back to combo name when ID is absent in order", () => {
    expect(sortCombosByOrder(sample, ["gamma", "alpha"]).map((c) => c.id)).toEqual(["c3", "c1", "c2"]);
  });

  it("handles empty, missing, or malformed inputs safely", () => {
    expect(sortCombosByOrder(sample, [])).toEqual(sample);
    expect(sortCombosByOrder(sample, null)).toEqual(sample);
    expect(sortCombosByOrder(sample, [123, "", "c2", "c2"]).map((c) => c.id)).toEqual(["c2", "c1", "c3"]);
    expect(sortCombosByOrder([], ["c1"])).toEqual([]);
    expect(sortCombosByOrder(null, ["c1"])).toEqual([]);
  });
});

describe("combos reorder API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /api/combos/reorder validates comboIds and persists deduplicated order", async () => {
    const { POST } = await import("../../src/app/api/combos/reorder/route.js");

    const badReq = new Request("http://localhost/api/combos/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comboIds: "not-an-array" }),
    });
    const badRes = await POST(badReq);
    expect(badRes.status).toBe(400);
    expect(mockUpdateSettings).not.toHaveBeenCalled();

    mockUpdateSettings.mockResolvedValueOnce({});
    const okReq = new Request("http://localhost/api/combos/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comboIds: ["c3", " ", "c1", "c3", 42, "c2"] }),
    });
    const okRes = await POST(okReq);
    const data = await okRes.json();
    expect(okRes.status).toBe(200);
    expect(data).toEqual({ success: true, count: 3 });
    expect(mockUpdateSettings).toHaveBeenCalledWith({ comboOrder: ["c3", "c1", "c2"] });
  });

  it("GET /api/combos returns combos sorted by settings.comboOrder and fails open on settings error", async () => {
    const { GET } = await import("../../src/app/api/combos/route.js");
    const raw = [
      { id: "c1", name: "one" },
      { id: "c2", name: "two" },
      { id: "c3", name: "three" },
    ];
    mockGetCombos.mockResolvedValue(raw);
    mockGetSettings.mockResolvedValueOnce({ comboOrder: ["c2", "c3", "c1"] });

    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.combos.map((c) => c.id)).toEqual(["c2", "c3", "c1"]);

    mockGetSettings.mockRejectedValueOnce(new Error("settings unavailable"));
    const fallbackRes = await GET();
    const fallbackJson = await fallbackRes.json();
    expect(fallbackRes.status).toBe(200);
    expect(fallbackJson.combos.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });
});
