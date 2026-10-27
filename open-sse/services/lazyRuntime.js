// Lazy loader for heavy optional runtime deps (playwright-core, wreq-js).
//
// They are devDependencies only, so end-user installs stay small. On first
// use the package is downloaded into <DATA_DIR>/runtime (same pattern as
// cli/hooks/sqliteRuntime.js) and imported from there. Resolution order:
// app node_modules (dev / traced standalone) → runtime dir → npm install.
//
// Never throws at import time of THIS module — failures surface from
// loadRuntimeDep() with a manual-install hint.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getWritableDataDir } from "../utils/writableDataDir.js";

// Keep in sync with package.json devDependencies.
const LAZY_DEP_VERSIONS = {
  "playwright-core": "^1.62.1",
  "wreq-js": "^3.2.0",
};

function getRuntimeDir() {
  return path.join(getWritableDataDir(), "runtime");
}

function isModuleMissing(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || "");
  return (
    code === "MODULE_NOT_FOUND" ||
    code === "ERR_MODULE_NOT_FOUND" ||
    msg.includes("Cannot find module") ||
    msg.includes("Failed to load")
  );
}

function getNativeRequire(fromPath) {
  try {
    const req = typeof __non_webpack_require__ === "function"
      ? __non_webpack_require__
      : eval("require");
    const mod = req("node:module") || req("module");
    if (typeof mod?.createRequire === "function") {
      return mod.createRequire(fromPath);
    }
  } catch {}
  return null;
}

function resolvePackageEntry(baseDir, pkg) {
  const pkgDir = path.join(baseDir, "node_modules", pkg);
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    return null;
  }
  try {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    let entry = null;
    if (pkgJson.exports) {
      if (typeof pkgJson.exports === "string") {
        entry = pkgJson.exports;
      } else if (typeof pkgJson.exports === "object" && pkgJson.exports !== null) {
        const dot = pkgJson.exports["."] || pkgJson.exports;
        if (typeof dot === "string") {
          entry = dot;
        } else if (typeof dot === "object" && dot !== null) {
          entry = dot.import || dot.default || dot.node || dot.require;
          if (typeof entry === "object" && entry !== null) {
            entry = entry.default || entry.import;
          }
        }
      }
    }
    if (!entry || typeof entry !== "string") {
      entry = pkgJson.module || pkgJson.main || "index.js";
    }
    const resolved = path.resolve(pkgDir, entry);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
    for (const ext of [".js", ".cjs", ".mjs", "/index.js"]) {
      const candidate = path.resolve(pkgDir, entry + ext);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
    return resolved;
  } catch {
    return null;
  }
}

function resolvePackagePath(dir, pkg) {
  const directPath = resolvePackageEntry(dir, pkg);
  if (directPath) return directPath;

  const nativeReq = getNativeRequire(path.join(dir, "package.json"));
  if (nativeReq && typeof nativeReq.resolve === "function") {
    try {
      return nativeReq.resolve(pkg);
    } catch {}
  }
  return null;
}

function npmInstall(pkg, version) {
  const cwd = getRuntimeDir();
  fs.mkdirSync(cwd, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "--no-audit", "--no-fund", "--prefer-online", `${pkg}@${version}`];
  return new Promise((resolve) => {
    const child = spawn(npm, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ ok: false, stderr: String(error.message || error) }));
    child.on("close", (status) => resolve({ ok: status === 0, stderr }));
  });
}

const inflight = new Map();

async function load(pkg) {
  // 1) Resolvable from the app install (dev machine / traced standalone).
  try {
    return await import(/* webpackIgnore: true */ pkg);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }

  // 2) Already present in the runtime dir from a previous install.
  const dir = getRuntimeDir();
  const existingPath = resolvePackagePath(dir, pkg);
  if (existingPath) {
    try {
      return await import(pathToFileURL(existingPath).href);
    } catch (error) {
      if (!isModuleMissing(error)) throw error;
    }
  }

  // 3) Download on demand, then import from the runtime dir.
  const version = LAZY_DEP_VERSIONS[pkg] || "latest";
  const res = await npmInstall(pkg, version);
  if (!res.ok) {
    const reason = (res.stderr.match(/npm ERR! ?(.+)/) || [])[1] || res.stderr.split("\n").filter(Boolean).pop() || "unknown npm error";
    throw new Error(
      `${pkg} is missing and the on-demand install failed (${String(reason).slice(0, 160)}) — ` +
      `install it manually: cd "${dir}" && npm install ${pkg}@${version}`
    );
  }

  const installedPath = resolvePackagePath(dir, pkg);
  if (!installedPath) {
    throw new Error(`${pkg} was installed into "${dir}" but could not be resolved.`);
  }
  return import(pathToFileURL(installedPath).href);
}
export function loadRuntimeDep(pkg) {
  if (!inflight.has(pkg)) {
    inflight.set(pkg, load(pkg).finally(() => inflight.delete(pkg)));
  }
  return inflight.get(pkg);
}
