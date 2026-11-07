import { AI_PROVIDERS } from "@/shared/constants/providers";

export function usesAwsCredentialForm(provider) {
  return AI_PROVIDERS[provider]?.credentialForm === "aws";
}

function maskProxyUrl(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== "string") return proxyUrl;
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.password || parsed.username) {
      parsed.password = "******";
      return parsed.toString();
    }
  } catch {}
  return proxyUrl;
}

export function toProviderConnectionResponse(connection) {
  const { apiKey, accessToken, refreshToken, idToken, clientSecret, ...safe } = connection;

  if (safe.connectionProxyUrl) {
    safe.connectionProxyUrl = maskProxyUrl(safe.connectionProxyUrl);
  }

  if (safe.providerSpecificData && typeof safe.providerSpecificData === "object") {
    const { sessionToken, copilotToken, mimoPassToken, storageState, clientSecret: psClientSecret, ...restSpecific } = safe.providerSpecificData;
    safe.providerSpecificData = restSpecific;
  }

  return safe;
}
