import type { FastifyPluginAsync } from "fastify";
import type { SqliteDatabase } from "../../db.js";
import type { MeData } from "../../types.js";
import { requireKey } from "../auth.js";
import { newRequestId, sendOk } from "../envelope.js";

export const ME_PATH = "/v1/me" as const;

export type MeRoutesOptions = {
  db: SqliteDatabase;
};

export const meRoutes: FastifyPluginAsync<MeRoutesOptions> = async (app, opts) => {
  app.get(ME_PATH, async (request, reply) => {
    const requestId = newRequestId();
    const key = requireKey(opts.db, request, reply, requestId);
    if (key === null) {
      return reply;
    }
    const data: MeData = {
      id: key.id,
      prefix: key.prefix,
      plan: key.plan,
      creditsRemaining: key.credits,
      rpm: key.rpm,
    };
    return sendOk(reply, data, { requestId, creditsCharged: 0 });
  });
};
