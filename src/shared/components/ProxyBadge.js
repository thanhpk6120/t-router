"use client";

import PropTypes from "prop-types";
import Badge from "./Badge";

/**
 * Proxy badge — renders ONLY when the traffic is actually proxied.
 *
 * The rule is deliberate and comes from the operator: "nếu không dùng proxy thì
 * không hiện". A direct request must render nothing at all — no "direct" badge,
 * no empty placeholder — because an always-present indicator trains the eye to
 * ignore it and then a real proxy is indistinguishable from the default.
 *
 * `descriptor` is the shape produced by @/lib/network/effectiveProxy and, for
 * per-request rows, by getResponseProxyInfo in open-sse/utils/proxyProvenance.js.
 * Missing / `proxied: false` ⇒ returns null.
 */

function shortHost(host) {
  return String(host || "")
    .replace(/^https?:\/\//, "")
    .replace(/^socks[45]?:\/\//, "");
}

export default function ProxyBadge({ descriptor, size = "sm", showHost = true, compact = false, className = "" }) {
  if (!descriptor?.proxied) return null;

  const label = descriptor.poolName || descriptor.poolId || "proxy";
  const host = shortHost(descriptor.host);
  const candidates = Number(descriptor.poolCount || descriptor.candidateCount || 0);
  const isRotation = descriptor.strategy && descriptor.strategy !== "none";

  const titleParts = [`Proxy: ${label}`];
  if (host) titleParts.push(host);
  if (descriptor.type) titleParts.push(`type ${descriptor.type}`);
  if (isRotation) titleParts.push(`rotation ${descriptor.strategy}`);
  if (candidates > 1) titleParts.push(`${candidates} candidate${candidates === 1 ? "" : "s"}`);
  if (descriptor.rotateLink) titleParts.push("rotating exit IP");
  if (descriptor.attempts > 1) titleParts.push(`attempt ${descriptor.attempts} (earlier proxies failed)`);
  // Connection-pinned: the pool comes from the connection rows, not from a
  // provider override or the rotation strategy — worth naming, because the two
  // are configured in different places and the operator will go looking.
  if (descriptor.source === "connection") titleParts.push("pinned on connection");
  if (descriptor.source === "connection-mixed") {
    titleParts.push("connections are pinned to different pools");
    if (descriptor.connectionCount) titleParts.push(`${descriptor.connectionCount} live connections`);
    if (descriptor.unboundCount) titleParts.push(`${descriptor.unboundCount} unbound`);
  }

  const text = host && showHost ? host : label;
  const title = titleParts.join(" · ");

  if (compact) {
    return (
      <span
        className={`inline-flex max-w-[160px] min-w-0 items-center truncate rounded bg-blue-500/10 px-1.5 py-px font-mono text-[10px] font-medium leading-tight text-blue-600 dark:text-blue-400 ${className}`.trim()}
        title={title}
      >
        {text}
      </span>
    );
  }

  return (
    <span className={className} title={title}>
      <Badge variant="info" size={size}>
        <span className="truncate font-mono">{text}</span>
      </Badge>
    </span>
  );
}

ProxyBadge.propTypes = {
  descriptor: PropTypes.shape({
    proxied: PropTypes.bool,
    poolId: PropTypes.string,
    poolName: PropTypes.string,
    host: PropTypes.string,
    type: PropTypes.string,
    strategy: PropTypes.string,
    poolCount: PropTypes.number,
    candidateCount: PropTypes.number,
    attempts: PropTypes.number,
    rotateLink: PropTypes.bool,
    source: PropTypes.string,
    connectionCount: PropTypes.number,
    unboundCount: PropTypes.number,
  }),
  size: PropTypes.oneOf(["sm", "md", "lg"]),
  showHost: PropTypes.bool,
  compact: PropTypes.bool,
  className: PropTypes.string,
};

/**
 * "Proxies failed, request left direct" badge. Separate from ProxyBadge on
 * purpose: this is the one case the operator must see even though no proxy was
 * used, because it means a configured proxy did NOT protect the request.
 */
export function ProxyFallbackBadge({ descriptor, compact = false, className = "" }) {
  if (!descriptor?.fallbackDirect) return null;
  const title = descriptor.reason ? `All proxies failed: ${descriptor.reason}` : "All proxies failed";
  if (compact) {
    return (
      <span
        className={`inline-flex max-w-full min-w-0 items-center truncate rounded bg-yellow-500/10 px-1.5 py-px text-[10px] font-medium leading-tight text-yellow-600 dark:text-yellow-400 ${className}`.trim()}
        title={title}
      >
        direct (proxy failed)
      </span>
    );
  }
  return (
    <span className={className} title={title}>
      <Badge variant="warning" size="sm">
        direct (proxy failed)
      </Badge>
    </span>
  );
}

ProxyFallbackBadge.propTypes = {
  descriptor: PropTypes.shape({
    fallbackDirect: PropTypes.bool,
    reason: PropTypes.string,
  }),
  compact: PropTypes.bool,
  className: PropTypes.string,
};

/**
 * "Proxy refused the request" badge — the request never left, because strict
 * mode or direct-disabled was set. Deliberately an error colour: unlike
 * ProxyFallbackBadge this is a request the operator configured to be *blocked*,
 * and seeing it here is how they learn their proxy pool is down.
 */
export function ProxyBlockedBadge({ descriptor, compact = false, className = "" }) {
  if (!descriptor || descriptor.proxied) return null;
  if (!descriptor.strictProxy && !descriptor.directDisabled) return null;
  const why = descriptor.strictProxy ? "strict proxy" : "direct disabled";
  const title = descriptor.reason ? `Request blocked (${why}): ${descriptor.reason}` : `Request blocked (${why})`;
  if (compact) {
    return (
      <span
        className={`inline-flex max-w-full min-w-0 items-center truncate rounded bg-red-500/10 px-1.5 py-px text-[10px] font-medium leading-tight text-red-600 dark:text-red-400 ${className}`.trim()}
        title={title}
      >
        blocked (proxy failed)
      </span>
    );
  }
  return (
    <span className={className} title={title}>
      <Badge variant="error" size="sm">
        blocked (proxy failed)
      </Badge>
    </span>
  );
}

ProxyBlockedBadge.propTypes = {
  descriptor: PropTypes.shape({
    proxied: PropTypes.bool,
    strictProxy: PropTypes.bool,
    directDisabled: PropTypes.bool,
    reason: PropTypes.string,
  }),
  compact: PropTypes.bool,
  className: PropTypes.string,
};

/**
 * "Connections are pinned to a pool that no longer exists" badge.
 *
 * Distinct from ProxyBlockedBadge: nothing refused the request. The connection
 * rows carry a proxyPoolId, `resolveConnectionProxyConfig` cannot find an active
 * pool for it, and the request therefore leaves over the real IP while the
 * operator believes it is proxied. Silent IP leak is exactly the failure a proxy
 * badge exists to surface, so this renders even though `proxied` is false.
 */
export function ProxyMissingBadge({ descriptor, compact = false, className = "" }) {
  if (!descriptor?.poolMissing) return null;
  const title = descriptor.reason
    ? `Not proxied: ${descriptor.reason}`
    : "Connections are pinned to a proxy pool that is missing or inactive";
  const label = descriptor.poolName ? `${descriptor.poolName} (missing)` : "proxy missing";
  if (compact) {
    return (
      <span
        className={`inline-flex max-w-full min-w-0 items-center truncate rounded bg-red-500/10 px-1.5 py-px text-[10px] font-medium leading-tight text-red-600 dark:text-red-400 ${className}`.trim()}
        title={title}
      >
        {label}
      </span>
    );
  }
  return (
    <span className={className} title={title}>
      <Badge variant="error" size="sm">
        {label}
      </Badge>
    </span>
  );
}

ProxyMissingBadge.propTypes = {
  descriptor: PropTypes.shape({
    poolMissing: PropTypes.bool,
    poolName: PropTypes.string,
    reason: PropTypes.string,
  }),
  compact: PropTypes.bool,
  className: PropTypes.string,
};
