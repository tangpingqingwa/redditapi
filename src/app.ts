import Fastify, { type FastifyInstance } from "fastify";
import { createFixtureAdapter } from "./adapters/reddit/fixture.js";
import { maybeBootstrapKey } from "./billing/keys.js";
import type { RedditAdapter } from "./core/thread.js";
import { openDatabase, type SqliteDatabase } from "./db.js";
import { healthRoutes } from "./http/routes/health.js";
import { meRoutes } from "./http/routes/me.js";
import { threadRoutes } from "./http/routes/threads.js";

declare module "fastify" {
  interface FastifyInstance {
    sqlite: SqliteDatabase;
  }
}

export type BuildAppOptions = {
  logger?: boolean;
  db?: SqliteDatabase;
  databasePath?: string;
  bootstrapKey?: string;
  reddit?: RedditAdapter;
};

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const db = options.db ?? openDatabase(options.databasePath ?? ":memory:");
  if (options.db === undefined) {
    maybeBootstrapKey(db, options.bootstrapKey);
  }
  const reddit = options.reddit ?? createFixtureAdapter();

  app.decorate("sqlite", db);
  app.addHook("onClose", async () => {
    db.close();
  });

  await app.register(healthRoutes);
  await app.register(meRoutes, { db });
  await app.register(threadRoutes, { db, reddit });
  return app;
}
