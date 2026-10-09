import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
// ponytail: no rate limiting on /auth/* yet; add @fastify/rate-limit before public launch
const app = buildApp(env, true);
await app.listen({ port: env.port, host: "0.0.0.0" });
