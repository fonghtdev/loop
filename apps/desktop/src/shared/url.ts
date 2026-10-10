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
