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
// ponytail: runs in this process; every instance runs it (removals are idempotent). Rights revoked while LiveKit
// was unreachable, or a rejoin on a token issued before the revocation, last at most one interval.
const reconcile = setInterval(() => void app.voice.reconcile(), 60 * 1000);
app.addHook("onClose", async () => clearInterval(reconcile));
await app.listen({ port: env.port, host: "0.0.0.0" });
