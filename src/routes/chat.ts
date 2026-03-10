import path from "node:path";
import fs from "node:fs/promises";
import { Router } from "express";
import type { CreateAppDeps } from "../app.js";
import { makeRequireWorldMember } from "../middleware/authz.js";

function asParamString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}

export function makeChatRouter(deps: CreateAppDeps) {
  const router = Router();
  const { vault, authStore } = deps;
  const requireWorldMember = makeRequireWorldMember(deps.authStore);

    /**
     * GET /worlds/:worldId/chat/recent?since=<epochMs>&limit=<n>
     *
     * Returns chat messages recently exported by VaultSync from Foundry.
     * Reads flat files from:
     *   worlds/{worldId}/vaultsync/exports/chat/chat.{id}.{ts}.{rand}.json
     *
     * Vaulthero calls this to detect new chat messages written by Foundry
     * (e.g., after a combat roll, a player message, etc.).
     *
     * ?since   — return only files with a timestamp > since (default 0 = all)
     * ?limit   — max messages to return (default 50, max 200)
     */
    router.get("/:worldId/chat/recent", requireWorldMember, async (req, res, next) => {
      try {
        const worldId = asParamString(req.params.worldId);
        const since = Number(req.query.since ?? 0) || 0;
        const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);

        const dataRoot = (deps as any).foundryDataRoot as string | null | undefined;
        if (!dataRoot) {
          return res.status(503).json({
            ok: false,
            error: "foundryDataRoot not configured on this server",
          });
        }

        // VaultSync exports chat to: worlds/{worldId}/vaultsync/exports/chat/
        const chatDir = path.resolve(
          String(dataRoot),
          `worlds/${worldId}/vaultsync/exports/chat`
        );

        let dirFiles: string[];
        try {
          dirFiles = await fs.readdir(chatDir);
        } catch {
          // Directory doesn't exist yet — no chat messages exported
          return res.json({ ok: true, worldId, since, count: 0, messages: [] });
        }

        // File format: chat.{id}.{ts}.{rand}.json
        // parts: ["chat", id, ts, rand, "json"] — ts is parts[parts.length - 3]
        const candidates = dirFiles
          .filter((f) => f.startsWith("chat.") && f.endsWith(".json"))
          .map((name) => {
            const parts = name.split(".");
            const ts = parts.length >= 5 ? Number(parts[parts.length - 3]) : NaN;
            return { name, ts };
          })
          .filter(({ ts }) => Number.isFinite(ts) && ts > since)
          .sort((a, b) => a.ts - b.ts) // oldest-first so client gets them in order
          .slice(0, limit);

        const messages: any[] = [];
        for (const { name } of candidates) {
          try {
            const raw = await fs.readFile(path.join(chatDir, name), "utf-8");
            messages.push(JSON.parse(raw));
          } catch {
            // skip unreadable files
          }
        }

        return res.json({ ok: true, worldId, since, count: messages.length, messages });
      } catch (err) {
        next(err);
      }
    });

    /**
     * List available chat days:
     *  GET /worlds/:worldId/chat/days
     *
     * Mounted at: app.use("/worlds", router)
     * So routes here should be "/:worldId/..."
     */
    router.get("/:worldId/chat/days",requireWorldMember, async (req, res, next) => {
    try {
        const worldId = asParamString(req.params.worldId);

        const days = await vault.listChatDays(worldId);
        res.json({ ok: true, days });
    } catch (err) {
        next(err);
    }
    });

    /**
     * List available hours for a day (from manifests):
     *  GET /worlds/:worldId/chat/days/:day/hours
     *
     * Reads files:
     *  vault/worlds/:worldId/chat/manifests/YYYY-MM-DD/HH.json
     */
    router.get("/:worldId/chat/days/:day/hours",requireWorldMember, async (req, res, next) => {
    try {
        const worldId = asParamString(req.params.worldId);
        const day = asParamString(req.params.day);

        const hours = await vault.listChatShardHours(worldId, day);
        res.json({ ok: true, day, hours });
    } catch (err) {
        next(err);
    }
    });

    /**
     * Get shard manifest:
     *  GET /worlds/:worldId/chat/manifests/:day/:hour
     */
    router.get("/:worldId/chat/manifests/:day/:hour",requireWorldMember, async (req, res, next) => {
    try {
        const worldId = asParamString(req.params.worldId);
        const day = asParamString(req.params.day);
        const hour = asParamString(req.params.hour);

        const manifest = await vault.readChatShardManifest(worldId, { day, hour });
        if (!manifest) return res.status(404).json({ ok: false, error: "Shard manifest not found" });

        res.json({ ok: true, manifest });
    } catch (err) {
        next(err);
    }
    });

    /**
     * List chat events in a shard (paginated by timestamp):
     *  GET /worlds/:worldId/chat/events/:day/:hour?afterTs=0&limit=200
     */
    router.get("/:worldId/chat/events/:day/:hour",requireWorldMember, async (req, res, next) => {
    try {
        const worldId = asParamString(req.params.worldId);
        const day = asParamString(req.params.day);
        const hour = asParamString(req.params.hour);

        const afterTs = req.query.afterTs !== undefined ? Number(req.query.afterTs) : 0;
        const limit = req.query.limit !== undefined ? Number(req.query.limit) : 200;

        const { events, nextAfterTs } = await vault.listChatEvents(
        worldId,
        { day, hour },
        { afterTs, limit }
        );

        res.json({
        ok: true,
        day,
        hour,
        count: events.length,
        nextAfterTs,
        events
        });
    } catch (err) {
        next(err);
    }
    });

    /**
     * Get a single event file by filename:
     *  GET /worlds/:worldId/chat/events/:day/:hour/:file
     */
    router.get("/:worldId/chat/events/:day/:hour/:file",requireWorldMember, async (req, res, next) => {
    try {
        const worldId = asParamString(req.params.worldId);
        const day = asParamString(req.params.day);
        const hour = asParamString(req.params.hour);
        const file = asParamString(req.params.file);

        // Safety: only allow simple json filenames
        if (!/^\d+-[a-z]+-[A-Za-z0-9_-]+\.json$/.test(file)) {
        return res.status(400).json({ ok: false, error: "Invalid event filename" });
        }

        const dir = (vault as any).chatShardDir(worldId, { day, hour });
        const rel = `${dir}/${file}`;

        const exists = await vault.exists(rel);
        if (!exists) return res.status(404).json({ ok: false, error: "Event not found" });

        const evt = await vault.readJson<any>(rel);
        res.json({ ok: true, event: evt });
    } catch (err) {
        next(err);
    }
    });

    return router
}
