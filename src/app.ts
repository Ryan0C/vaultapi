// src/app.ts
import express from "express";
import cors from "cors";
import session, { type SessionOptions } from "express-session";

import { makeAuthMiddleware } from "./plugins/auth.js";
import { HttpError } from "./utils/errors.js";

import type { VaultStore } from "./services/vaultStore.js";
import type { AuthStore } from "./services/authStore.js";
import type { Logger } from "./services/logger.js";
import type { WorldStore } from "./stores/worldStore.js";
import type { ActorsStore } from "./stores/actorsStore.js"; 

import { makeHealthRouter } from "./routes/health.js";
import { makeWorldsRouter } from "./routes/worlds.js";
import { makeActorsRouter } from "./routes/actors.js";
import { makeChatRouter } from "./routes/chat.js";
import { makeImportsRouter } from "./routes/imports.js";
import { makeWorldInvitesRouter } from "./routes/worldInvites.js";
import { makeInvitesRedeemRouter } from "./routes/invites.js";
import { makeMeRouter } from "./routes/me.js";
import { makeAuthRouter } from "./routes/auth.js";
import { makeAdminUsersRouter } from "./routes/adminUsers.js";
import { makeMediaRouter } from "./routes/media.js";
import { makeDocsRouter } from "./routes/documents.js";
import { makeJournalRouter } from "./routes/journals.js";
import { makeCommandsRouter } from "./routes/commands.js";
import { makeEventsRouter } from "./routes/eventsRouter.js";
import { makeUploadsRouter } from "./routes/uploads.js";
import { makeQuestRouter } from "./routes/questsRouter.js";
import { makeIntelRouter } from "./routes/intelRouter.js";
import { makePacksRouter } from "./routes/packs.js";
import { makeVendorsRouter } from "./routes/vendors.js";
import type { ItemsPacksStore } from "./stores/itemsPacksStore.js";
import type { ImportsStore } from "./stores/importStore.js";

export type CreateAppDeps = {
  vault: VaultStore;
  vaultRoot: string;
  apiKey: string;

  authStore: AuthStore;
  worldStore: WorldStore;
  actorsStore: ActorsStore;
  importsStore: ImportsStore;
  allowUnauthedPaths?: string[];
  sessionConfig?: SessionOptions;
  logger: Logger;

  corsOrigins?: string[];
  corsAllowCredentials?: boolean;
  foundryDataRoot?: string | null;
  foundryPublicRoot?: string | null;

  // ✅ NEW (optional override)
  itemsPacksStore?: ItemsPacksStore;
};

export function createApp(deps: CreateAppDeps) {
  const app = express();
  app.set("trust proxy", 1);

    app.use(
    cors({
        origin: (origin, callback) => {
        // allow non-browser tools (curl, Postman)
        if (!origin) return callback(null, true);

        if (!deps.corsOrigins || deps.corsOrigins.length === 0) {
            return callback(null, true); // allow all if not configured
        }

        if (deps.corsOrigins.includes(origin)) {
            return callback(null, true);
        }

        return callback(new Error("Not allowed by CORS"));
        },
        credentials: deps.corsAllowCredentials ?? true
    })
    );
  app.use(express.json({ limit: "5mb" }));

  // Sessions MUST come before auth middleware (if your auth reads req.session)
  if (deps.sessionConfig) {
    app.use(session(deps.sessionConfig));
  }

  // Request logging (do this before routes so all requests get timed)
  app.use((req, res, next) => {
    const start = Date.now();

    res.on("finish", () => {
      deps.logger.info("request.complete", {
        method: req.method,
        path: req.originalUrl ?? req.path,
        status: res.statusCode,
        durationMs: Date.now() - start
      });
    });

    next();
  });

  // Auth middleware (api key and/or session)
  app.use(
    makeAuthMiddleware({
      apiKey: deps.apiKey,
      allowUnauthedPaths: deps.allowUnauthedPaths ?? [
        "/health",
        "/health/deep",
        "/auth/login",
        "/auth/reset-password",
        "/invites/redeem",
        "/auth/me",
        "/me"
      ]
    })
  );

  // Routes
  app.use("/health", makeHealthRouter(deps));
  app.use("/admin", makeAdminUsersRouter(deps));
  app.use("/auth", makeAuthRouter(deps));
  app.use("/invites", makeInvitesRedeemRouter(deps)); // /invites/redeem
  app.use("/me", makeMeRouter(deps));
  app.use('/worlds', makePacksRouter(deps))
  app.use("/worlds", makeWorldInvitesRouter(deps));   // /worlds/:worldId/invites

  app.use("/worlds", makeWorldsRouter(deps));
  app.use("/worlds", makeActorsRouter(deps));
  app.use("/worlds", makeImportsRouter(deps));
  app.use("/worlds", makeChatRouter(deps));
  app.use("/media", makeMediaRouter(deps));
  app.use("/worlds", makeDocsRouter(deps));
  app.use("/worlds", makeJournalRouter(deps));
  app.use("/worlds", makeCommandsRouter(deps));
  app.use("/worlds", makeEventsRouter(deps));
  app.use('/worlds', makeUploadsRouter(deps))
  app.use('/worlds', makeQuestRouter(deps))
  app.use('/worlds', makeIntelRouter(deps))
  app.use('/worlds', makeVendorsRouter(deps))
  // Error handler (keep last)
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    deps.logger.error("request.error", {
      method: req.method,
      path: req.originalUrl ?? req.path,
      error: err instanceof Error ? err.message : String(err)
    });

    if (err instanceof HttpError) {
      return res.status(err.status).json({
        ok: false,
        error: err.message,
        details: err.details
      });
    }

    return res.status(500).json({
      ok: false,
      error: "Internal Server Error"
    });
  });

  return app;
}