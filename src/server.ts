import { buildApp } from "./app.js";
import { parseListenPort, resolveBootstrapKey, resolveDatabasePath } from "./config.js";

const app = await buildApp({
  logger: true,
  databasePath: resolveDatabasePath(),
  bootstrapKey: resolveBootstrapKey(),
});
await app.listen({ host: "0.0.0.0", port: parseListenPort() });
