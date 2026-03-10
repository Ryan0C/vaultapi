// src/routes/journals.ts
import { Router } from "express";
import { makeRequireWorldMember } from "../middleware/authz.js";
const INDEX_CACHE = new Map();
const INDEX_CACHE_MS = 30_000;
const VS_JOURNAL_PACKS = new Set([
    "world.vaultsync-party-quests",
    "world.vaultsync-player-quests",
    "world.vaultsync-intel",
]);
function asParamString(value) {
    if (Array.isArray(value))
        return String(value[0] ?? "").trim();
    return String(value ?? "").trim();
}
function isAllowedJournalPack(packId) {
    return VS_JOURNAL_PACKS.has(String(packId ?? ""));
}
async function getCachedTemplates(worldStore, worldId, packId) {
    const key = `${worldId}::${packId}`;
    const now = Date.now();
    const cached = INDEX_CACHE.get(key);
    if (cached && now - cached.ts < INDEX_CACHE_MS)
        return cached.result;
    const result = await worldStore.listJournalTemplates(worldId, packId);
    INDEX_CACHE.set(key, { ts: now, result });
    return result;
}
export function makeJournalRouter(deps) {
    const router = Router();
    const { authStore, worldStore } = deps;
    const requireWorldMember = makeRequireWorldMember(authStore);
    /**
     * GET /worlds/:worldId/journals/packs
     */
    router.get("/:worldId/journals/packs", requireWorldMember, async (req, res, next) => {
        try {
            const worldId = asParamString(req.params.worldId);
            const manifest = await worldStore.readPacksManifest(worldId);
            const packs = Array.isArray(manifest?.packs) ? manifest.packs : [];
            const out = packs
                .filter((p) => isAllowedJournalPack(String(p?.id ?? "")))
                .map((p) => ({
                id: String(p?.id ?? ""),
                label: String(p?.label ?? ""),
                documentName: String(p?.documentName ?? ""),
                private: !!p?.private,
                locked: !!p?.locked,
            }))
                .sort((a, b) => a.id.localeCompare(b.id));
            return res.json({ ok: true, worldId, count: out.length, packs: out });
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * GET /worlds/:worldId/journals/:packId/index
     */
    router.get("/:worldId/journals/:packId/index", requireWorldMember, async (req, res, next) => {
        try {
            const worldId = asParamString(req.params.worldId);
            const packId = asParamString(req.params.packId);
            if (!isAllowedJournalPack(packId)) {
                return res.status(404).json({ ok: false, error: "Unknown journal pack" });
            }
            const listing = await getCachedTemplates(worldStore, worldId, packId);
            // If pack exists but has no index, return empty listing (instead of 404)
            if (!listing) {
                return res.json({
                    ok: true,
                    worldId,
                    packId,
                    label: null,
                    count: 0,
                    entries: [],
                });
            }
            return res.json({
                ok: true,
                worldId,
                packId,
                label: listing.label ?? null,
                count: Array.isArray(listing.entries) ? listing.entries.length : 0,
                entries: listing.entries ?? [],
            });
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * GET /worlds/:worldId/journals/:packId/payloads/:docId
     */
    router.get("/:worldId/journals/:packId/payloads/:docId", requireWorldMember, async (req, res, next) => {
        try {
            const worldId = asParamString(req.params.worldId);
            const packId = asParamString(req.params.packId);
            const docId = asParamString(req.params.docId);
            if (!isAllowedJournalPack(packId)) {
                return res.status(404).json({ ok: false, error: "Unknown journal pack" });
            }
            const payload = await worldStore.readJournalPayload(worldId, packId, docId);
            if (!payload)
                return res.status(404).json({ ok: false, error: "Journal payload not found" });
            return res.json({ ok: true, worldId, packId, docId, payload });
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * Back-compat: old payload URL style.
     * Keep AFTER /index and /payloads
     */
    router.get("/:worldId/journals/:packId/:docId", requireWorldMember, async (req, res, next) => {
        try {
            const worldId = asParamString(req.params.worldId);
            const packId = asParamString(req.params.packId);
            const docId = asParamString(req.params.docId);
            if (!isAllowedJournalPack(packId)) {
                return res.status(404).json({ ok: false, error: "Unknown journal pack" });
            }
            const payload = await worldStore.readJournalPayload(worldId, packId, docId);
            if (!payload)
                return res.status(404).json({ ok: false, error: "Journal payload not found" });
            return res.json({ ok: true, worldId, packId, docId, payload });
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * GET /worlds/:worldId/journals/meta/delete
     */
    router.get("/:worldId/journals/meta/delete", requireWorldMember, async (req, res, next) => {
        try {
            const worldId = asParamString(req.params.worldId);
            const manifest = await worldStore.readDeleteManifest(worldId);
            if (!manifest) {
                return res.json({
                    ok: true,
                    worldId,
                    schema: "vaultsync.delete-manifest.v1",
                    generatedAt: new Date().toISOString(),
                    keep: [],
                    delete: [],
                });
            }
            return res.json({ ok: true, worldId, manifest });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=journals.js.map