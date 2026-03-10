// src/types/foundry.ts (or wherever you keep shared API types)

export type FoundryItemDoc = {
  _id: string;
  id?: string;
  name: string;
  type: string;
  img?: string;

  // Different systems store different things here; keep loose.
  system?: Record<string, unknown>;
  flags?: Record<string, unknown>;

  [k: string]: unknown;
};

export type ActorDoc = {
  _id: string;
  id?: string;          // some exports include both
  name: string;
  type?: string;        // "character" | "npc" in dnd5e, etc.
  img?: string;         // <-- you use this for portraits
  folder?: string;
  sort?: number;

  system?: Record<string, unknown>;
  items?: FoundryItemDoc[];
  effects?: unknown[];
  flags?: Record<string, unknown>;

  // Your export already includes this, and it’s very useful for routing/permissions.
  _meta?: {
    schema?: number;
    source?: string;     // "foundry"
    worldId?: string;
    systemId?: string;
    coreVersion?: string;
    exportedAt?: string;
    [k: string]: unknown;
  };

  [k: string]: unknown;
};