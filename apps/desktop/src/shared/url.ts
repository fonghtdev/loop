/** Only web links leave the app, and only through the OS browser: no file:, javascript:, data:, custom schemes. */
export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 2048) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Whether a URL from the server (a LiveKit token response) points at the one origin the CSP lets us reach. */
export function isAllowedLivekitUrl(url: unknown, allowedOrigin: string): boolean {
  try {
    return typeof url === "string" && new URL(url).origin === new URL(allowedOrigin).origin;
  } catch {
    return false;
  }
}
