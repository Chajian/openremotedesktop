import { html } from "../dashboard/ui/html.js";

const geminiCallbackOrigin = "https://oauth-redirect.googleusercontent.com";
const responseParameterNames = new Set(["code", "error", "state", "iss"]);

export type ConsentOutcome = "approved" | "denied";

/** Called only after the OAuth library has validated the registered redirect URI. */
export function usesGeminiNavigation(redirectUri: string | undefined, enabled: boolean): boolean {
  if (!enabled || !redirectUri || /[\u0000-\u0020\u007f]/.test(redirectUri)) return false;
  try {
    const url = new URL(redirectUri);
    return url.origin === geminiCallbackOrigin &&
      url.pathname.startsWith("/r/") && url.pathname.length > 3 &&
      !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

/** Check the existing OAuth response without regenerating or reserializing it. */
export function validateGeminiLocation(
  redirectUri: string,
  location: unknown,
  outcome: ConsentOutcome,
  issuer: string,
  state: string | undefined,
): string {
  const invalid = () => new Error("Invalid OAuth callback response");
  if (!usesGeminiNavigation(redirectUri, true) ||
      typeof location !== "string" || /[\u0000-\u0020\u007f]/.test(location)) throw invalid();
  const expected = new URL(redirectUri);
  const actual = new URL(location);
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname ||
      actual.username || actual.password || actual.hash) throw invalid();

  const remaining = new URLSearchParams(actual.search);
  for (const name of new Set(expected.searchParams.keys())) {
    // Reserved OAuth response parameters cannot also be fixed callback parameters.
    if (responseParameterNames.has(name) ||
        JSON.stringify(remaining.getAll(name)) !== JSON.stringify(expected.searchParams.getAll(name))) {
      throw invalid();
    }
    remaining.delete(name);
  }
  const resultName = outcome === "approved" ? "code" : "error";
  const resultValues = remaining.getAll(resultName);
  if (resultValues.length !== 1 || !resultValues[0] ||
      (outcome === "denied" && resultValues[0] !== "access_denied")) throw invalid();
  if (remaining.getAll("iss").length !== 1 || remaining.get("iss") !== issuer) throw invalid();
  if (state === undefined ? remaining.has("state") :
      remaining.getAll("state").length !== 1 || remaining.get("state") !== state) throw invalid();
  for (const name of remaining.keys()) {
    if (name !== resultName && name !== "iss" && name !== "state") throw invalid();
  }
  return location;
}

export function renderGeminiNavigation(location: string, outcome: ConsentOutcome): string {
  const heading = outcome === "approved" ? "Authorization approved" : "Authorization denied";
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${location}">
<title>Returning to Gemini</title></head>
<body><main><p>OpenRemote</p><h1>${heading}</h1>
<p>Returning you to Gemini...</p>
<a href="${location}" rel="noreferrer">Continue to Gemini</a>
</main></body></html>`.toString();
}
