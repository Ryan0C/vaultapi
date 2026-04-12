// @ts-nocheck
// src/stores/itemsPacksStore.ts
import path from "node:path";
import fs from "node:fs/promises";
function isIndexFile(name) {
    return name === "index.json" || /^index\.\d+\.[a-z0-9]+\.json$/i.test(name);
}
function extractEpoch(name) {
    const m = name.match(/^index\.(\d+)\./);
    return m ? Number(m[1]) : 0;
}
function normalizeText(v) {
    return String(v ?? "").trim().toLowerCase();
}
function includesQuery(hay, q) {
    return !q || hay.includes(q);
}
const KNOWN_CLASS_TOKENS = new Set([
    "artificer",
    "bard",
    "cleric",
    "druid",
    "fighter",
    "monk",
    "paladin",
    "ranger",
    "rogue",
    "sorcerer",
    "warlock",
    "wizard",
]);
const CLASS_TOKEN_ALIASES = {
    "blood-hunter": "bloodhunter",
    "blood hunter": "bloodhunter",
    "wildheart": "barbarian",
};
function normalizeClassToken(v) {
    let raw = String(v ?? "").trim().toLowerCase();
    if (!raw)
        return "";
    raw = raw.replace(/\bclass\b/g, "").trim();
    raw = raw.replace(/[_\s]+/g, "-");
    raw = raw.replace(/^-+|-+$/g, "");
    raw = CLASS_TOKEN_ALIASES[raw] ?? raw;
    raw = raw.replace(/[^a-z-]/g, "");
    return raw;
}
function inferClassFromSubclassToken(v) {
    const raw = String(v ?? "").trim().toLowerCase();
    if (!raw)
        return "";
    const head = raw.split(/[.:/]/)[0] ?? "";
    return normalizeClassToken(head);
}
function inferClassesFromText(v) {
    const out = new Set();
    const text = String(v ?? "").toLowerCase();
    if (!text)
        return out;
    for (const cls of KNOWN_CLASS_TOKENS) {
        const listRe = new RegExp(`\\b${cls}\\s+spell\\s+list\\b`, "i");
        const spellsRe = new RegExp(`\\b${cls}\\s+spells\\b`, "i");
        if (listRe.test(text) || spellsRe.test(text))
            out.add(cls);
    }
    const classesLine = text.match(/\bclasses?\s*:\s*([^<\n\r.]+)/i)?.[1] ?? "";
    if (classesLine) {
        for (const part of classesLine.split(/[;,/]/g)) {
            const cls = normalizeClassToken(part);
            if (cls)
                out.add(cls);
        }
    }
    return out;
}
function normalizedTypeSet(entry) {
    const out = new Set();
    const direct = normalizeText(entry?.type);
    if (direct)
        out.add(direct);
    const sysType = normalizeText(entry?.system?.type?.value);
    if (sysType)
        out.add(sysType);
    return out;
}
function typeMatches(entry, wantedTypeRaw) {
    const wanted = normalizeText(wantedTypeRaw);
    if (!wanted)
        return true;
    const types = normalizedTypeSet(entry);
    if (!types.size)
        return false;
    if (wanted === "species" || wanted === "race") {
        return types.has("species") || types.has("race");
    }
    return types.has(wanted);
}
function typeSetMatches(types, wantedTypeRaw) {
    const wanted = normalizeText(wantedTypeRaw);
    if (!wanted)
        return true;
    if (!types.size)
        return false;
    if (wanted === "species" || wanted === "race") {
        return types.has("species") || types.has("race");
    }
    return types.has(wanted);
}
export class ItemsPacksStore {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    // ------------------------------------------------------------------
    // In-memory cache
    // Pack indexes are large JSON files that rarely change during a session.
    // Caching for 30 seconds eliminates repeated disk reads for burst
    // item-lookup patterns (e.g., vaulthero retrying a search).
    // ------------------------------------------------------------------
    _cache = new Map();
    _searchCache = new Map();
    _compiledCache = new Map();
    _builderChoicesCache = new Map();
    _latestPackIndexFile = new Map();
    CACHE_TTL_MS = 5 * 60_000; // 5 minutes
    SEARCH_CACHE_TTL_MS = 30_000; // 30 seconds
    _cacheGet(key) {
        const e = this._cache.get(key);
        if (!e)
            return undefined;
        if (Date.now() > e.exp) {
            this._cache.delete(key);
            return undefined;
        }
        return e.value;
    }
    _cacheSet(key, value) {
        this._cache.set(key, { value, exp: Date.now() + this.CACHE_TTL_MS });
    }
    _compiledGet(key) {
        const e = this._compiledCache.get(key);
        if (!e)
            return undefined;
        if (Date.now() > e.exp) {
            this._compiledCache.delete(key);
            return undefined;
        }
        return e.value;
    }
    _compiledSet(key, value) {
        this._compiledCache.set(key, { value, exp: Date.now() + this.CACHE_TTL_MS });
    }
    invalidatePack(worldId, packId) {
        const packPrefix = `${worldId}:${packId}:`;
        for (const k of this._cache.keys()) {
            if (k.startsWith(packPrefix))
                this._cache.delete(k);
        }
        for (const k of this._searchCache.keys()) {
            if (k.startsWith(packPrefix))
                this._searchCache.delete(k);
        }
        for (const k of this._compiledCache.keys()) {
            if (k.startsWith(packPrefix))
                this._compiledCache.delete(k);
        }
        this._builderChoicesCache.delete(`${worldId}:builderChoices`);
    }
    /** Invalidate all cache entries for a world (call when a pack is re-exported). */
    invalidateWorld(worldId) {
        const prefix = `${worldId}:`;
        for (const k of this._cache.keys()) {
            if (k.startsWith(prefix))
                this._cache.delete(k);
        }
        for (const k of this._searchCache.keys()) {
            if (k.startsWith(prefix))
                this._searchCache.delete(k);
        }
        for (const k of this._compiledCache.keys()) {
            if (k.startsWith(prefix))
                this._compiledCache.delete(k);
        }
        for (const k of this._builderChoicesCache.keys()) {
            if (k.startsWith(prefix))
                this._builderChoicesCache.delete(k);
        }
        for (const k of this._latestPackIndexFile.keys()) {
            if (k.startsWith(prefix))
                this._latestPackIndexFile.delete(k);
        }
    }
    abs(rel) {
        const cleaned = String(rel ?? "").replace(/^\/+/, "");
        const out = path.resolve(this.opts.foundryDataRoot, cleaned);
        const root = path.resolve(this.opts.foundryDataRoot);
        if (!out.startsWith(root + path.sep) && out !== root) {
            throw new Error(`ItemsPacksStore: path escapes root: ${rel}`);
        }
        return out;
    }
    async readJson(rel) {
        const txt = await fs.readFile(this.abs(rel), "utf-8");
        return JSON.parse(txt);
    }
    packsRoot(worldId) {
        return `worlds/${worldId}/vaultsync/exports/items/packs`;
    }
    async listPackIds(worldId) {
        const cacheKey = `${worldId}:packIds`;
        const cached = this._cacheGet(cacheKey);
        if (cached !== undefined)
            return cached;
        const rel = this.packsRoot(worldId);
        let result;
        try {
            const ents = await fs.readdir(this.abs(rel), { withFileTypes: true });
            result = ents.filter((e) => e.isDirectory()).map((e) => e.name).sort();
        }
        catch {
            result = [];
        }
        this._cacheSet(cacheKey, result);
        return result;
    }
    async readLatestPackIndex(worldId, packId) {
        const wid = String(worldId ?? "").trim();
        const pid = String(packId ?? "").trim();
        if (!wid || !pid)
            return null;
        const cacheKey = `${wid}:${pid}:index`;
        const relDir = `${this.packsRoot(wid)}/${pid}`;
        let names;
        try {
            names = await fs.readdir(this.abs(relDir));
        }
        catch {
            return null;
        }
        const candidates = names.filter(isIndexFile);
        const fileMarkerKey = `${wid}:${pid}:indexFile`;
        if (!candidates.length) {
            this._latestPackIndexFile.delete(fileMarkerKey);
            this.invalidatePack(wid, pid);
            return null;
        }
        candidates.sort((a, b) => extractEpoch(b) - extractEpoch(a) || b.localeCompare(a));
        const latest = candidates[0];
        const prevLatest = this._latestPackIndexFile.get(fileMarkerKey);
        if (prevLatest && prevLatest !== latest) {
            this.invalidatePack(wid, pid);
        }
        const cached = this._cacheGet(cacheKey);
        if (cached !== undefined && prevLatest === latest)
            return cached;
        const result = await this.readJson(`${relDir}/${latest}`);
        this._latestPackIndexFile.set(fileMarkerKey, latest);
        // Only cache successful reads; null means pack doesn't exist yet
        if (result != null)
            this._cacheSet(cacheKey, result);
        return result;
    }
    async getPackMeta(worldId, packId) {
        const idx = await this.readLatestPackIndex(worldId, packId);
        if (!idx)
            return null;
        const p = idx?.pack ?? {};
        return {
            id: String(p?.collection ?? packId),
            label: p?.label != null ? String(p.label) : null,
            package: p?.package != null ? String(p.package) : null,
            type: p?.type != null ? String(p.type) : null,
            count: Number(idx?.count ?? (Array.isArray(idx?.entries) ? idx.entries.length : 0)) || 0,
            generatedAt: idx?.generatedAt != null ? String(idx.generatedAt) : null,
        };
    }
    compileEntries(entries) {
        return entries.map((e) => {
            const name = String(e?.name ?? "");
            const sys = e?.system ?? {};
            const vhSpell = e?.vh?.spell ?? {};
            const classes = Array.isArray(vhSpell?.classes)
                ? vhSpell.classes
                    .map((x) => normalizeClassToken(x))
                    .filter(Boolean)
                : [];
            const subclasses = Array.isArray(vhSpell?.subclasses)
                ? vhSpell.subclasses
                    .map((x) => String(x).toLowerCase().trim())
                    .filter(Boolean)
                : [];
            const classesFromSubclasses = subclasses
                .map((x) => inferClassFromSubclassToken(x))
                .filter(Boolean);
            const classesFromText = Array.from(inferClassesFromText([
                sys?.description?.value,
                sys?.description?.chat,
                vhSpell?.source,
            ].join(" ")));
            const resolvedClasses = Array.from(new Set([...classes, ...classesFromSubclasses, ...classesFromText]));
            const hay = [
                name,
                sys?.identifier,
                ...resolvedClasses,
                ...subclasses,
                vhSpell?.source,
                sys?.description?.value,
                sys?.description?.chat,
            ]
                .map((v) => String(v ?? "").toLowerCase())
                .join(" ");
            return {
                raw: e,
                name,
                typeSet: normalizedTypeSet(e),
                level: Number.isFinite(Number(vhSpell?.level))
                    ? Number(vhSpell.level)
                    : Number.isFinite(Number(sys?.level))
                        ? Number(sys.level)
                        : undefined,
                school: String(vhSpell?.school ?? sys?.school ?? "").toLowerCase(),
                classes: new Set(resolvedClasses),
                subclasses: new Set(subclasses),
                concentration: typeof vhSpell?.concentration === "boolean" ? vhSpell.concentration : undefined,
                ritual: typeof vhSpell?.ritual === "boolean" ? vhSpell.ritual : undefined,
                hay,
            };
        });
    }
    async getCompiledEntries(worldId, packId) {
        const idx = await this.readLatestPackIndex(worldId, packId);
        const entries = Array.isArray(idx?.entries) ? idx.entries : [];
        const compiledKey = `${worldId}:${packId}:compiled`;
        let compiled = this._compiledGet(compiledKey);
        if (!compiled) {
            compiled = this.compileEntries(entries);
            this._compiledSet(compiledKey, compiled);
        }
        return compiled;
    }
    async readBuilderChoices(worldId) {
        let packIds;
        try {
            const rel = this.packsRoot(worldId);
            const ents = await fs.readdir(this.abs(rel), { withFileTypes: true });
            packIds = ents.filter((e) => e.isDirectory()).map((e) => e.name).sort();
        }
        catch {
            packIds = [];
        }
        for (const packId of packIds) {
            await this.readLatestPackIndex(worldId, packId);
        }
        const signature = packIds
            .map((packId) => `${packId}:${this._latestPackIndexFile.get(`${worldId}:${packId}:indexFile`) ?? "none"}`)
            .join("|");
        const cacheKey = `${worldId}:builderChoices`;
        const cached = this._builderChoicesCache.get(cacheKey);
        if (cached && cached.exp > Date.now() && cached.signature === signature)
            return cached.value;
        const classes = [];
        const subclasses = [];
        const species = [];
        const backgrounds = [];
        for (const packId of packIds) {
            const compiled = await this.getCompiledEntries(worldId, packId);
            for (const row of compiled) {
                const entry = row.raw;
                const name = String(row.name ?? "").trim();
                if (!name)
                    continue;
                const typeSet = row.typeSet;
                const base = {
                    packId,
                    uuid: String(entry?.uuid ?? ""),
                    _id: entry?._id,
                    name,
                    type: entry?.type != null ? String(entry.type) : undefined,
                    img: entry?.img != null ? String(entry.img) : undefined,
                    system: {
                        identifier: entry?.system?.identifier,
                        classIdentifier: entry?.system?.classIdentifier,
                        description: { value: entry?.system?.description?.value },
                    },
                };
                if (typeSet.has("class"))
                    classes.push(base);
                else if (typeSet.has("subclass"))
                    subclasses.push(base);
                else if (typeSet.has("background"))
                    backgrounds.push(base);
                else if (typeSet.has("species") || typeSet.has("race"))
                    species.push(base);
            }
        }
        const value = { classes, subclasses, species, backgrounds };
        this._builderChoicesCache.set(cacheKey, {
            value,
            signature,
            exp: Date.now() + this.CACHE_TTL_MS,
        });
        return value;
    }
    async searchPackEntries(args) {
        const q = normalizeText(args.q);
        const limit = Math.max(1, Math.min(Number(args.limit ?? 50), 200));
        const cacheKey = [
            args.worldId,
            args.packId,
            q || "__q__",
            normalizeText(args.type) || "__type__",
            normalizeText(args.level) || "__level__",
            normalizeText(args.cls) || "__cls__",
            normalizeText(args.subclass) || "__subclass__",
            normalizeText(args.school) || "__school__",
            args.concentration == null ? "__conc__" : String(!!args.concentration),
            args.ritual == null ? "__ritual__" : String(!!args.ritual),
            String(limit),
        ].join(":");
        const cached = this._searchCache.get(cacheKey);
        if (cached && cached.exp > Date.now())
            return cached.value;
        const compiled = await this.getCompiledEntries(args.worldId, args.packId);
        const hits = [];
        for (const row of compiled) {
            const e = row.raw;
            const name = row.name;
            if (!name)
                continue;
            const sys = e?.system ?? {};
            const vhSpell = e?.vh?.spell ?? {};
            if (!typeSetMatches(row.typeSet, args.type))
                continue;
            if (args.level != null && Number(row.level ?? -999) !== Number(args.level)) {
                continue;
            }
            if (args.school) {
                if (row.school !== String(args.school).toLowerCase())
                    continue;
            }
            if (args.cls) {
                const want = normalizeClassToken(args.cls);
                const classIdentifier = normalizeClassToken(sys?.classIdentifier ?? "");
                if (!row.classes.has(want) && classIdentifier !== want)
                    continue;
            }
            if (args.subclass) {
                if (!row.subclasses.has(String(args.subclass).toLowerCase()))
                    continue;
            }
            if (args.concentration != null) {
                const conc = row.concentration ?? false;
                if (conc !== args.concentration)
                    continue;
            }
            if (args.ritual != null) {
                const rit = row.ritual ?? false;
                if (rit !== args.ritual)
                    continue;
            }
            if (q) {
                if (!row.hay.includes(q))
                    continue;
            }
            const resolvedClasses = Array.from(row.classes).sort();
            hits.push({
                uuid: String(e?.uuid ?? ""),
                _id: e?._id,
                name,
                type: e?.type != null ? String(e.type) : undefined,
                img: e?.img != null ? String(e.img) : undefined,
                system: {
                    level: sys?.level,
                    school: sys?.school,
                    activation: sys?.activation,
                    range: sys?.range,
                    duration: sys?.duration,
                    target: sys?.target,
                    components: sys?.components,
                    materials: sys?.materials,
                    description: { value: sys?.description?.value },
                    source: sys?.source,
                    identifier: sys?.identifier,
                    classIdentifier: sys?.classIdentifier,
                    price: sys?.price,
                },
                vh: {
                    ...(e?.vh ?? {}),
                    spell: {
                        ...(e?.vh?.spell ?? {}),
                        classes: resolvedClasses,
                        subclasses: Array.from(row.subclasses).sort(),
                    },
                },
            });
            if (hits.length >= limit)
                break;
        }
        this._searchCache.set(cacheKey, {
            value: hits,
            exp: Date.now() + this.SEARCH_CACHE_TTL_MS,
        });
        return hits;
    }
}
//# sourceMappingURL=itemsPacksStore.js.map