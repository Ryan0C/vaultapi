export function asParamString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}

export function unwrapActorSnapshot(actor: any, actorIdHint?: string): any {
  if (!actor || typeof actor !== "object") return actor;
  const unwrapped =
    (actor.foundry && typeof actor.foundry === "object" ? actor.foundry : null) ??
    (actor.data && typeof actor.data === "object" ? actor.data : null) ??
    actor;

  if (!unwrapped || typeof unwrapped !== "object") return unwrapped;
  const out = { ...(unwrapped as Record<string, unknown>) } as any;
  if (!out.id && typeof out._id === "string") out.id = out._id;
  if (!out._id && typeof out.id === "string") out._id = out.id;
  if (!out.id && actorIdHint) out.id = actorIdHint;
  if (!out._id && actorIdHint) out._id = actorIdHint;
  return out;
}

function readNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function resolveItemName(raw: any, items: any[], types: string[]): string {
  if (!raw) return "";
  const normalizedTypes = new Set(types.map((t) => String(t).toLowerCase()));
  const actorItems = Array.isArray(items) ? items : [];

  if (typeof raw === "string") {
    const byId = actorItems.find((it: any) =>
      normalizedTypes.has(String(it?.type ?? "").toLowerCase()) &&
      String(it?._id ?? it?.id ?? "").trim() === raw
    );
    if (byId?.name) return String(byId.name).trim();
    return raw.trim();
  }

  const embeddedId = String(raw?._id ?? raw?.id ?? "").trim();
  if (embeddedId) {
    const byId = actorItems.find((it: any) =>
      normalizedTypes.has(String(it?.type ?? "").toLowerCase()) &&
      String(it?._id ?? it?.id ?? "").trim() === embeddedId
    );
    if (byId?.name) return String(byId.name).trim();
  }

  return String(raw?.name ?? raw?.label ?? raw?.value ?? "").trim();
}

export function actorLevel(actor: any): number | null {
  const direct = readNumber(actor?.system?.details?.level);
  if (direct != null) return Math.max(0, Math.trunc(direct));

  const classItems = (Array.isArray(actor?.items) ? actor.items : []).filter(
    (it: any) => String(it?.type ?? "").toLowerCase() === "class"
  );
  if (!classItems.length) return null;

  let total = 0;
  for (const item of classItems) {
    const level = readNumber(item?.system?.levels ?? item?.system?.level ?? 0) ?? 0;
    total += Math.max(0, Math.trunc(level));
  }
  return total > 0 ? total : null;
}

export function actorSpecies(actor: any): string {
  const items = Array.isArray(actor?.items) ? actor.items : [];
  const raw = actor?.system?.details?.species ?? actor?.system?.details?.race ?? "";
  return resolveItemName(raw, items, ["species", "race"]);
}

export function actorClass(actor: any): string {
  const direct = String(actor?.system?.details?.class ?? "").trim();
  if (direct) return direct;

  const names = (Array.isArray(actor?.items) ? actor.items : [])
    .filter((it: any) => String(it?.type ?? "").toLowerCase() === "class")
    .map((it: any) => String(it?.name ?? "").trim())
    .filter(Boolean);
  return names.join(" / ");
}

export function actorImage(actor: any): string {
  return String(
    actor?.img ??
    actor?.prototypeToken?.texture?.src ??
    actor?.prototypeToken?.src ??
    ""
  ).trim();
}

function actorLocation(actor: any): string {
  return String(actor?.flags?.vaulthero?.location ?? "").trim();
}

function actorDeceased(actor: any): boolean {
  const hpVal = readNumber(actor?.system?.attributes?.hp?.value);
  const hpMax = readNumber(actor?.system?.attributes?.hp?.max);
  if (hpVal != null && hpMax != null && hpMax > 0 && hpVal <= 0) return true;

  const effects = Array.isArray(actor?.effects) ? actor.effects : [];
  return effects.some((effect: any) => {
    const status =
      String(effect?.flags?.core?.statusId ?? "").toLowerCase() ||
      String(Array.isArray(effect?.statuses) ? effect.statuses[0] ?? "" : "").toLowerCase() ||
      String(effect?.label ?? effect?.name ?? "").toLowerCase();
    return status.includes("dead") || status.includes("deceased") || status.includes("defeated");
  });
}

function actorOwnerFallback(actor: any): string {
  const ownership = actor?.ownership;
  if (ownership && Number((ownership as any).default ?? 0) >= 3) return "All Players";
  return "Unknown";
}

export function summarizePartyActor(actor: any, worldId: string, authStore: any) {
  const unwrapped = unwrapActorSnapshot(actor);
  const actorId = String(unwrapped?.id ?? unwrapped?._id ?? "").trim();
  if (!actorId) return null;
  if (String(unwrapped?.type ?? "").toLowerCase() !== "character") return null;

  const owners = authStore.listUsersForActorInWorld(worldId, actorId);
  const ownerNames = owners
    .map((owner: any) => String(owner?.displayName ?? owner?.username ?? "").trim())
    .filter(Boolean);

  return {
    id: actorId,
    name: String(unwrapped?.name ?? actorId).trim() || actorId,
    img: actorImage(unwrapped),
    level: actorLevel(unwrapped),
    species: actorSpecies(unwrapped),
    className: actorClass(unwrapped),
    ownerIds: owners.map((owner: any) => String(owner?.userId ?? "").trim()).filter(Boolean),
    ownerNames: ownerNames.length ? Array.from(new Set(ownerNames)).join(", ") : actorOwnerFallback(unwrapped),
    activeMember: Boolean(unwrapped?.flags?.vaulthero?.party?.activeMember),
    deceased: actorDeceased(unwrapped),
    location: actorLocation(unwrapped),
  };
}

export function isCharacterSnapshot(actor: any): boolean {
  const unwrapped = unwrapActorSnapshot(actor);
  return String(unwrapped?.type ?? "").toLowerCase() === "character";
}
