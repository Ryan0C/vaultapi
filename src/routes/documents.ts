import { Router } from "express";
import type { CreateAppDeps } from "../app.js";
import { makeRequireWorldMember } from "../middleware/authz.js";
import { makeRequireDocPickerAccess } from "../middleware/docPolicy.js"; // your new middleware
import { forbidden, unauthorized } from "../utils/errors.js";

type CachedIndex = { ts: number; entries: any[] };

const INDEX_CACHE = new Map<string, CachedIndex>();
const INDEX_CACHE_MS = 30_000; // 30s is plenty, vaultsync updates are frequent

function asParamString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}

async function getCachedPackEntries(vault: any, worldId: string, packId: string): Promise<any[]> {
  const key = `${worldId}::${packId}`;
  const now = Date.now();

  const cached = INDEX_CACHE.get(key);
  if (cached && now - cached.ts < INDEX_CACHE_MS) return cached.entries;

  const index = await vault.readPackIndex(worldId, packId);
  const entries = getIndexEntries(index);

  INDEX_CACHE.set(key, { ts: now, entries });
  return entries;
}

function getIndexEntries(index: any): any[] {
  if (!index) return [];
  if (Array.isArray(index.entries)) return index.entries;
  if (Array.isArray(index.items)) return index.items;
  if (Array.isArray(index.docs)) return index.docs;
  if (Array.isArray(index.results)) return index.results;
  if (Array.isArray(index)) return index;
  return [];
}
function normalizeKind(k: string): string {
  const s = String(k ?? "").toLowerCase().trim();
  if (!s) return "";
  if (s === "weapon" || s === "equipment") return "items";
  if (s === "feat") return "feats";
  if (s === "spell") return "spells";
  return s;
}

function expandKind(kind: string | null): string[] {
  const k = kind ? normalizeKind(kind) : "";
  if (!k) return []; // means "any allowed kind"

  // If you ask for feats, also search likely “feature” packs.
  if (k === "feats") return ["feats", "classfeatures", "features", "options"];

  // Items might be split across items/equipment/tradegoods
  if (k === "items") return ["items", "equipment", "equipment24", "tradegoods"];

  return [k];
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function scoreName(name: string, q: string): number {
  const n = name.toLowerCase();
  const qq = q.toLowerCase();

  if (n === qq) return 1000;
  if (n.startsWith(qq)) return 700;
  if (n.includes(qq)) return 400;

  // token overlap
  const nt = new Set(tokenize(n));
  const qt = tokenize(qq);
  if (!qt.length) return 0;

  let hit = 0;
  for (const t of qt) if (nt.has(t)) hit++;

  // weight token match, but keep below substring
  return hit ? 200 + hit * 10 : 0;
}

function getVaultUserId(req: any): string | null {
  if (req.auth?.kind === "apiKey" && req.auth?.superuser) return null;
  return req.session?.userId ?? null;
}
function isApiKeySuperuser(req: any): boolean {
  return req.auth?.kind === "apiKey" && !!req.auth?.superuser;
}
function uniqStrings(xs: unknown): string[] {
  if (!Array.isArray(xs)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of xs) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
function packIdFromCompendiumUuid(uuid: string): string | null {
  // Expect: Compendium.<packId>.<DocumentName>.<docId>
  // where packId itself contains a dot (package.collection)
  // Example: Compendium.dnd5e.spells.Item.XXXX
  if (!uuid.startsWith("Compendium.")) return null;
  const rest = uuid.slice("Compendium.".length);
  const parts = rest.split(".");
  if (parts.length < 4) return null;

  // packId is first two parts: "<package>.<collection>"
  // (This matches Foundry compendium collection format)
  return `${parts[0]}.${parts[1]}`;
}

async function computeAllowedUuidsForUser(args: {
  deps: CreateAppDeps;
  worldId: string;
  userId: string;
}): Promise<Set<string> | null> {
  const { deps, worldId, userId } = args;
  const { vault, authStore } = deps;

  if (authStore.isWorldDm(worldId, userId)) return null;

  const links = authStore.listActorsForUserInWorld(worldId, userId);
  const allowedActorIds = new Set(links.map((l) => String(l.actorId)));

  const refs = await vault.readActorDocRefsManifest(worldId);
  const actors = Array.isArray(refs?.actors) ? refs.actors : [];

  const out = new Set<string>();
  for (const a of actors) {
    const actorId = String(a?.actorId ?? "");
    if (!allowedActorIds.has(actorId)) continue;
    const uuids = Array.isArray(a?.uuids) ? a.uuids : [];
    for (const u of uuids) if (typeof u === "string") out.add(u);
  }

  return out;
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

export function makeDocsRouter(deps: CreateAppDeps) {
  const router = Router();
  const { vault, authStore } = deps;

  const requireWorldMember = makeRequireWorldMember(authStore);
  const requireDocPickerAccess = makeRequireDocPickerAccess(deps);

  /**
   * GET /worlds/:worldId/packs
   * Returns pack manifest used by the client to know what indexes exist.
   */
  router.get("/:worldId/packs", requireWorldMember, async (req, res, next) => {
    try {
      const worldId = asParamString(req.params.worldId);
      const manifest = await vault.readPacksManifest(worldId);
      return res.json(manifest ?? { worldId, count: 0, packs: [], generatedAt: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /worlds/:worldId/packs/:packId/index
   */
  router.get("/:worldId/packs/:packId/index", requireWorldMember, async (req, res, next) => {
    try {
      const worldId = asParamString(req.params.worldId);
      const packId = asParamString(req.params.packId);
      const idx = await vault.readPackIndex(worldId, packId);
      if (!idx) return res.status(404).json({ ok: false, error: "Pack index not found" });
      return res.json({ ok: true, index: idx });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /worlds/:worldId/search
   * Query params:
   *  - q: string (required)
   *  - kind: string (optional) e.g. "spells"
   *  - limit: number (optional, default 50, max 200)
   *
   * Uses indexes only (no descriptions). Intended for picker UI.
   * Gated by requireDocPickerAccess (policy+role).
   */
router.get("/:worldId/search", requireWorldMember, requireDocPickerAccess, async (req, res, next) => {
  try {
    const worldId = asParamString(req.params.worldId);

    const qRaw = String((req.query as any)?.q ?? "");
    const q = normalizeQuery(qRaw);
    if (!q) return res.status(400).json({ ok: false, error: "Missing q" });

    const kindParam = String((req.query as any)?.kind ?? "").trim() || null;
    const kindList = expandKind(kindParam);
    const limit = Math.max(1, Math.min(Number((req.query as any)?.limit ?? 50), 200));

    const anyReq = req as any;

    const isSuper = isApiKeySuperuser(anyReq);
    const userId = isSuper ? null : getVaultUserId(anyReq);
    if (!isSuper && !userId) return next(unauthorized("Login required"));

    const isDm = isSuper || (userId ? authStore.isWorldDm(worldId, userId) : false);

    const policy = await vault.readPolicyMeta(worldId);
    const picker = policy?.docPolicy?.picker ?? {};
    const allowedKinds: string[] = Array.isArray(picker.allowedKinds) ? picker.allowedKinds : [];

    // If caller asked for specific kind(s), ensure at least one is allowed
    if (kindList.length && allowedKinds.length) {
      const okAny = kindList.some(k => allowedKinds.includes(k));
      if (!okAny) return next(forbidden("Search kind not permitted by policy"));
    }

    const packsManifest = await vault.readPacksManifest(worldId);
    const packs = Array.isArray(packsManifest?.packs) ? packsManifest.packs : [];

    const playerAccess = String(picker.playerAccess ?? "dmOnly");
    const playerPackAllowlist: string[] = Array.isArray(picker.playerPackAllowlist) ? picker.playerPackAllowlist : [];

    // Which packs can we search?
    const searchablePacks = packs.filter((p: any) => {
      const pKind = String(p?.kind ?? "");
      if (allowedKinds.length && !allowedKinds.includes(pKind)) return false;

      if (kindList.length && !kindList.includes(pKind)) return false;

      if (isDm) return true;

      if (!picker.enabled) return false;
      if (playerAccess === "dmOnly") return false;

      if (playerAccess === "srdOnly" || playerAccess === "allowlisted") {
        return playerPackAllowlist.includes(String(p?.id ?? ""));
      }

      return false;
    });

    const hits: any[] = [];

    for (const p of searchablePacks) {
      const packId = String(p?.id ?? "");
      if (!packId) continue;

      const entries = await getCachedPackEntries(vault, worldId, packId);

      for (const e of entries) {
        const name = String(e?.name ?? "");
        if (!name) continue;

        const s = scoreName(name, q);
        if (s <= 0) continue;

        const uuid = String(e?.uuid ?? e?.id ?? "");
        if (!uuid) continue;

        hits.push({
          uuid,
          name,
          score: s,
          packId,
          packLabel: String(p?.label ?? ""),
          kind: String(p?.kind ?? ""),
          itemType: e?.itemType ?? e?.type ?? null
        });
      }
    }

    // best score first, then name
    hits.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));

    const out = hits.slice(0, limit);

    return res.json({
      ok: true,
      worldId,
      q: qRaw,
      kind: kindParam,
      count: out.length,
      hits: out
    });
  } catch (err) {
    next(err);
  }
});

  /**
   * GET /worlds/:worldId/docs?uuid=...
   * Reads an already-exported document snapshot.
   */
  router.get("/:worldId/docs", requireWorldMember, async (req, res, next) => {
    try {
      const worldId = asParamString(req.params.worldId);
      const uuid = String((req.query as any)?.uuid ?? "");
      if (!uuid) return res.status(400).json({ ok: false, error: "Missing uuid query param" });

      const anyReq = req as any;

      // DM/superuser allowed; otherwise require login and sheet-scope permission via actor-doc-refs allowlist
      if (!isApiKeySuperuser(anyReq)) {
        const userId = getVaultUserId(anyReq);
        if (!userId) return next(unauthorized("Login required"));

        const allowed = await computeAllowedUuidsForUser({ deps, worldId, userId });
        if (allowed && !allowed.has(uuid)) return next(forbidden("Document access denied"));
      }

      const doc = await vault.readDoc(worldId, uuid);
      if (!doc) return res.status(404).json({ ok: false, error: "Document not found" });

      return res.json({ ok: true, doc });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /worlds/:worldId/docs/hydrate
   * Body: { uuids: string[], mode?: "sheet"|"picker" }
   *
   * - sheet: player can only request UUIDs from their allowed actor-doc-refs set
   * - picker: gated by policy middleware + allowlisted packs/kinds
   */
  router.post("/:worldId/docs/hydrate", requireWorldMember, async (req, res, next) => {
    try {
      const worldId = asParamString(req.params.worldId);
      const anyReq = req as any;

      const mode = String(req.body?.mode ?? "sheet");

      const isSuper = isApiKeySuperuser(anyReq);
      const userId = isSuper ? null : getVaultUserId(anyReq);
      if (!isSuper && !userId) return next(unauthorized("Login required"));

      const isDm = isSuper || (userId ? authStore.isWorldDm(worldId, userId) : false);

      const requested = uniqStrings(req.body?.uuids);

      // Determine permitted UUIDs
      let permitted: string[] = [];

      if (isDm) {
        permitted = requested;
      } else if (mode === "sheet") {
        const allowed = await computeAllowedUuidsForUser({ deps, worldId, userId: userId! });
        permitted = requested.filter((u) => allowed?.has(u));
        if (permitted.length !== requested.length) return next(forbidden("Some requested documents are not permitted"));
      } else if (mode === "picker") {
        // Enforce picker policy (same logic as middleware, but we already used requireWorldMember here).
        // If you prefer, split picker hydration into its own route and attach requireDocPickerAccess.
        const policy = await vault.readPolicyMeta(worldId);
        const picker = policy?.docPolicy?.picker ?? {};
        if (!picker?.enabled) return next(forbidden("Picker access disabled"));

        const playerAccess = String(picker.playerAccess ?? "dmOnly");
        const allowPacks: string[] = Array.isArray(picker.playerPackAllowlist) ? picker.playerPackAllowlist : [];

        if (playerAccess === "dmOnly") return next(forbidden("Picker access is DM-only"));

        // Only permit UUIDs from allowlisted packs
        permitted = requested.filter((uuid) => {
          const packId = packIdFromCompendiumUuid(uuid);
          if (!packId) return false;
          return allowPacks.includes(packId);
        });

        if (permitted.length !== requested.length) return next(forbidden("Some requested documents are outside the allowed packs"));
      } else {
        return res.status(400).json({ ok: false, error: "Invalid mode (use sheet|picker)" });
      }

      // Return what we already have + request missing
      const docsByUuid: Record<string, any> = {};
      const missing: string[] = [];

      for (const uuid of permitted) {
        const doc = await vault.readDoc(worldId, uuid);
        if (doc) docsByUuid[uuid] = doc;
        else missing.push(uuid);
      }

      let requestId: string | null = null;
      if (missing.length) {
        const reqInfo = await vault.requestDocs(worldId, missing);
        requestId = reqInfo.requestId;
      }
      
      return res.json({ ok: true, worldId, mode, docsByUuid, missing, requestId });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /worlds/:worldId/docs/requests/:requestId
   * Poll for ack written by vault-sync watcher.
   */
  router.get("/:worldId/docs/requests/:requestId", requireWorldMember, async (req, res, next) => {
    try {
      const worldId = asParamString(req.params.worldId);
      const requestId = asParamString(req.params.requestId);
      const ack = await vault.readDocRequestAck(worldId, requestId);
      if (!ack) return res.status(404).json({ ok: false, pending: true });
      return res.json({ ok: true, ack });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
