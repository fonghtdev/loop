// Release builds bake the server addresses into the app (src/shared/config.ts), whose defaults point at localhost.
// This stops a release from shipping with them. LOOP_ALLOW_LOCAL=1 bypasses it for local test builds.
import { fileURLToPath } from "node:url";

const REQUIRED = [
  ["VITE_API_URL", "https:"],
  ["VITE_STORAGE_ORIGIN", "https:"],
  ["VITE_LIVEKIT_ORIGIN", "wss:"],
];
const LOCAL = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$)|\.local$/i;

/** @returns {string[]} one message per problem (empty = fine). */
export function checkReleaseEnv(env) {
  if (env.LOOP_ALLOW_LOCAL === "1") return [];
  const problems = [];
  for (const [name, protocol] of REQUIRED) {
    let url;
    try {
      url = new URL(env[name] ?? "");
    } catch {
      problems.push(`${name} chưa đặt hoặc không phải URL (cần ${protocol}//...)`);
      continue;
    }
    if (url.protocol !== protocol) problems.push(`${name} phải dùng ${protocol}// (đang là ${url.protocol}//)`);
    else if (LOCAL.test(url.hostname)) problems.push(`${name} đang trỏ về máy cục bộ (${url.hostname})`);
  }
  const update = env.VITE_UPDATE_URL;
  if (update && !/^https:\/\//.test(update)) problems.push("VITE_UPDATE_URL (nếu có) phải là https://");
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkReleaseEnv(process.env);
  if (problems.length) {
    console.error(`Không đóng gói bản phát hành:\n- ${problems.join("\n- ")}\nĐặt các biến VITE_* trỏ tới máy chủ thật, hoặc LOOP_ALLOW_LOCAL=1 cho bản thử cục bộ.`);
    process.exit(1);
  }
}
