import { sweepStaleAttachments } from "./attachments/sweep.js";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
// ponytail: no rate limiting on /auth/* yet; add @fastify/rate-limit before public launch
const app = buildApp(env, true);
// ponytail: runs in this process; with several instances each one sweeps (harmless, deletes are conditional)
const sweep = setInterval(() => {
  sweepStaleAttachments(app.storage).catch((e) => app.log.error({ err: String(e?.message) }, "attachment sweep failed"));
}, 60 * 60 * 1000);
app.addHook("onClose", async () => clearInterval(sweep));
await app.listen({ port: env.port, host: "0.0.0.0" });
