import pkg from "../../../../package.json" with { type: "json" };

const NPM_PACKAGE = "t-router-proxy";
const GITHUB_REPO = "thanhpk6120/t-router";
const VERSION_CACHE_TTL_MS = 300000; // 5 minutes cache

// Survive hot reload; one cache per process
const versionCache = (global.__proVersionCache ??= { value: null, fetchedAt: 0 });

// Fetch latest version from npm registry (fastest & most accurate after publish)
async function fetchLatestNpmVersion() {
  // 1. Direct latest tag from npm registry
  try {
    const res = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`, {
      headers: { "User-Agent": "t-router", Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.version) return String(data.version).replace(/^v/, "").trim();
    }
  } catch {}

  // 2. Fallback: package dist-tags from npm registry
  try {
    const res = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}`, {
      headers: { "User-Agent": "t-router", Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      const latest = data?.["dist-tags"]?.latest;
      if (latest) return String(latest).replace(/^v/, "").trim();
    }
  } catch {}

  // 3. Fallback: GitHub Releases
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { "User-Agent": "t-router", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      const tag = data?.tag_name;
      if (tag) return String(tag).replace(/^v/, "").trim();
    }
  } catch {}

  return null;
}

// "0.5.109-pro.13-t.1" -> { major: 0, minor: 5, patch: 109, pro: 13, t: 1 }
function parseVersion(v) {
  if (!v || typeof v !== "string") return null;
  const clean = v.replace(/^v/, "").trim();
  const m = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-pro\.(\d+))?(?:-t\.(\d+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pro: m[4] !== undefined ? Number(m[4]) : 0,
    t: m[5] !== undefined ? Number(m[5]) : 0,
  };
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  if (pa.pro !== pb.pro) return pa.pro > pb.pro ? 1 : -1;
  if (pa.t !== pb.t) return pa.t > pb.t ? 1 : -1;
  return 0;
}

async function getLatestVersionCached(forceRefresh = false) {
  if (!forceRefresh && versionCache.value && Date.now() - versionCache.fetchedAt < VERSION_CACHE_TTL_MS) {
    return versionCache.value;
  }
  const latest = await fetchLatestNpmVersion();
  if (latest) {
    versionCache.value = latest;
    versionCache.fetchedAt = Date.now();
  }
  return latest || versionCache.value;
}

export async function GET(request) {
  const url = new URL(request.url);
  const forceRefresh = url.searchParams.has("refresh") || url.searchParams.has("force");
  const latestVersion = await getLatestVersionCached(forceRefresh);
  const currentVersion = pkg.version;
  const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;

  return Response.json({
    currentVersion,
    latestVersion,
    hasUpdate,
    packageName: NPM_PACKAGE,
    installCmd: `npm i -g ${NPM_PACKAGE}@latest`,
    updateUrl: `https://www.npmjs.com/package/${NPM_PACKAGE}`,
  });
}
