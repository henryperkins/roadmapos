import { buildApp } from "./app.js";
import { configFromEnv } from "./config.js";

const app = await buildApp(configFromEnv());
await app.listen({ host: "0.0.0.0", port: Number(process.env.CONTROL_PLANE_PORT ?? 4000) });
