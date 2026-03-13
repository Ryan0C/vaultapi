// src/stores/vendorStore.ts
import { db } from "../services/db.js";
import { v4 as uuid } from "uuid";

// ─── Public types ─────────────────────────────────────────────────────────────

export type Vendor = {
  id: string;
  worldId: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  npcName: string | null;
  greetings: string[];
  gold: number;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type VendorItem = {
  id: string;
  vendorId: string;
  worldId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  foundryItemId: string | null;
  priceGold: number;
  quantity: number;          // committed stock in DB
  effectiveQuantity: number; // includes pending restock intervals
  maxQuantity: number;
  restockIntervalSeconds: number;
  restockAmount: number;
  lastRestockedAt: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type VendorWithItems = Vendor & { items: VendorItem[] };

export type VendorTransaction = {
  id: string;
  vendorId: string;
  worldId: string;
  itemId: string;
  itemName: string;
  buyerActorId: string | null;
  buyerVaultUserId: string | null;
  quantity: number;
  goldSpent: number;
  createdAt: string;
};

export type VendorPack = {
  format: "vaulthero.vendorPack";
  version: 1;
  meta: {
    title: string;
    createdAt: string;
    sourceWorldId: string;
  };
  data: {
    vendors: Array<{
      externalId: string;
      name: string;
      description: string | null;
      avatarUrl: string | null;
      npcName: string | null;
      greetings: string[];
      gold: number;
      isActive: boolean;
      items: Array<{
        externalId: string;
        name: string;
        description: string | null;
        imageUrl: string | null;
        foundryItemId: string | null;
        priceGold: number;
        quantity: number;
        maxQuantity: number;
        restockIntervalSeconds: number;
        restockAmount: number;
        sortOrder: number;
      }>;
    }>;
  };
};

// ─── Row types (SQLite snake_case) ────────────────────────────────────────────

type VendorRow = {
  id: string;
  world_id: string;
  name: string;
  description: string | null;
  avatar_url: string | null;
  npc_name: string | null;
  greetings: string;
  gold: number;
  is_active: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type VendorItemRow = {
  id: string;
  vendor_id: string;
  world_id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  foundry_item_id: string | null;
  price_gold: number;
  quantity: number;
  max_quantity: number;
  restock_interval_seconds: number;
  restock_amount: number;
  last_restocked_at: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type VendorTransactionRow = {
  id: string;
  vendor_id: string;
  world_id: string;
  item_id: string;
  item_name: string;
  buyer_actor_id: string | null;
  buyer_vault_user_id: string | null;
  quantity: number;
  gold_spent: number;
  created_at: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nowIso() { return new Date().toISOString(); }
function nowMs()  { return Date.now(); }

/**
 * Compute effective (displayed) quantity using lazy restock evaluation.
 * We do NOT write to the DB here — that happens on purchase to keep reads cheap.
 */
function computeEffectiveQuantity(row: VendorItemRow): number {
  const base = Math.max(0, row.quantity);
  if (row.restock_interval_seconds <= 0) return base;

  const elapsed  = nowMs() - (row.last_restocked_at || 0);
  const periods  = Math.floor(elapsed / (row.restock_interval_seconds * 1000));
  if (periods <= 0) return base;

  const restored = periods * Math.max(1, row.restock_amount);
  return Math.min(row.max_quantity || base + restored, base + restored);
}

function rowToVendor(r: VendorRow): Vendor {
  let greetings: string[] = [];
  try { greetings = JSON.parse(r.greetings || "[]"); } catch { greetings = []; }
  return {
    id:          r.id,
    worldId:     r.world_id,
    name:        r.name,
    description: r.description,
    avatarUrl:   r.avatar_url,
    npcName:     r.npc_name,
    greetings,
    gold:        r.gold,
    isActive:    r.is_active === 1,
    createdBy:   r.created_by,
    createdAt:   r.created_at,
    updatedAt:   r.updated_at,
  };
}

function rowToItem(r: VendorItemRow): VendorItem {
  return {
    id:                     r.id,
    vendorId:               r.vendor_id,
    worldId:                r.world_id,
    name:                   r.name,
    description:            r.description,
    imageUrl:               r.image_url,
    foundryItemId:          r.foundry_item_id,
    priceGold:              r.price_gold,
    quantity:               r.quantity,
    effectiveQuantity:      computeEffectiveQuantity(r),
    maxQuantity:            r.max_quantity,
    restockIntervalSeconds: r.restock_interval_seconds,
    restockAmount:          r.restock_amount,
    lastRestockedAt:        r.last_restocked_at,
    sortOrder:              r.sort_order,
    createdAt:              r.created_at,
    updatedAt:              r.updated_at,
  };
}

function rowToTransaction(r: VendorTransactionRow): VendorTransaction {
  return {
    id:                r.id,
    vendorId:          r.vendor_id,
    worldId:           r.world_id,
    itemId:            r.item_id,
    itemName:          r.item_name,
    buyerActorId:      r.buyer_actor_id,
    buyerVaultUserId:  r.buyer_vault_user_id,
    quantity:          r.quantity,
    goldSpent:         r.gold_spent,
    createdAt:         r.created_at,
  };
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class VendorStore {
  // ── Vendor CRUD ─────────────────────────────────────────────────────────────

  listVendors(worldId: string, opts: { includeInactive?: boolean } = {}): { ok: true; vendors: Vendor[] } {
    const sql = opts.includeInactive
      ? `SELECT * FROM vendors WHERE world_id = ? ORDER BY is_active DESC, name ASC`
      : `SELECT * FROM vendors WHERE world_id = ? AND is_active = 1 ORDER BY name ASC`;
    const rows = db.prepare(sql).all(String(worldId)) as VendorRow[];
    return { ok: true, vendors: rows.map(rowToVendor) };
  }

  getVendor(vendorId: string, opts: { includeInactive?: boolean } = {}): { ok: true; vendor: VendorWithItems } | { ok: false; error: string } {
    const vendorRow = db.prepare(`SELECT * FROM vendors WHERE id = ?`).get(String(vendorId)) as VendorRow | undefined;
    if (!vendorRow) return { ok: false, error: "Vendor not found" };
    if (!opts.includeInactive && vendorRow.is_active !== 1) {
      return { ok: false, error: "This shop is currently closed" };
    }

    const itemRows = db.prepare(`
      SELECT * FROM vendor_items WHERE vendor_id = ? ORDER BY sort_order ASC, name ASC
    `).all(String(vendorId)) as VendorItemRow[];

    return {
      ok: true,
      vendor: { ...rowToVendor(vendorRow), items: itemRows.map(rowToItem) },
    };
  }

  createVendor(args: {
    worldId: string;
    name: string;
    description?: string | null;
    avatarUrl?: string | null;
    npcName?: string | null;
    greetings?: string[];
    gold?: number;
    createdBy?: string | null;
  }): { ok: true; vendor: Vendor } | { ok: false; error: string } {
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, error: "name is required" };

    const id  = uuid();
    const now = nowIso();
    db.prepare(`
      INSERT INTO vendors (id, world_id, name, description, avatar_url, npc_name, greetings, gold, is_active, created_by, created_at, updated_at)
      VALUES (@id, @worldId, @name, @description, @avatarUrl, @npcName, @greetings, @gold, 1, @createdBy, @now, @now)
    `).run({
      id,
      worldId:     String(args.worldId),
      name,
      description: args.description ? String(args.description) : null,
      avatarUrl:   args.avatarUrl   ? String(args.avatarUrl)   : null,
      npcName:     args.npcName     ? String(args.npcName)     : null,
      greetings:   JSON.stringify(Array.isArray(args.greetings) ? args.greetings : []),
      gold:        Math.max(0, Math.trunc(Number(args.gold ?? 0))),
      createdBy:   args.createdBy   ? String(args.createdBy)   : null,
      now,
    });

    return { ok: true, vendor: rowToVendor(db.prepare(`SELECT * FROM vendors WHERE id = ?`).get(id) as VendorRow) };
  }

  updateVendor(vendorId: string, args: {
    name?: string;
    description?: string | null;
    avatarUrl?: string | null;
    npcName?: string | null;
    greetings?: string[];
    gold?: number;
    isActive?: boolean;
  }): { ok: true; vendor: Vendor } | { ok: false; error: string } {
    const existing = db.prepare(`SELECT * FROM vendors WHERE id = ?`).get(String(vendorId)) as VendorRow | undefined;
    if (!existing) return { ok: false, error: "Vendor not found" };

    db.prepare(`
      UPDATE vendors SET
        name        = @name,
        description = @description,
        avatar_url  = @avatarUrl,
        npc_name    = @npcName,
        greetings   = @greetings,
        gold        = @gold,
        is_active   = @isActive,
        updated_at  = @now
      WHERE id = @id
    `).run({
      id:          vendorId,
      name:        args.name        !== undefined ? String(args.name).trim()                            : existing.name,
      description: args.description !== undefined ? (args.description || null)                         : existing.description,
      avatarUrl:   args.avatarUrl   !== undefined ? (args.avatarUrl   || null)                         : existing.avatar_url,
      npcName:     args.npcName     !== undefined ? (args.npcName     || null)                         : existing.npc_name,
      greetings:   args.greetings   !== undefined ? JSON.stringify(Array.isArray(args.greetings) ? args.greetings : []) : (existing.greetings || "[]"),
      gold:        args.gold        !== undefined ? Math.max(0, Math.trunc(Number(args.gold)))          : existing.gold,
      isActive:    args.isActive    !== undefined ? (args.isActive ? 1 : 0)                            : existing.is_active,
      now:         nowIso(),
    });

    return { ok: true, vendor: rowToVendor(db.prepare(`SELECT * FROM vendors WHERE id = ?`).get(vendorId) as VendorRow) };
  }

  deleteVendor(vendorId: string): { ok: true } | { ok: false; error: string } {
    const info = db.prepare(`DELETE FROM vendors WHERE id = ?`).run(String(vendorId));
    if (!info.changes) return { ok: false, error: "Vendor not found" };
    return { ok: true };
  }

  // ── Item CRUD ────────────────────────────────────────────────────────────────

  addItem(vendorId: string, args: {
    worldId: string;
    name: string;
    description?: string | null;
    imageUrl?: string | null;
    foundryItemId?: string | null;
    priceGold?: number;
    quantity?: number;
    maxQuantity?: number;
    restockIntervalSeconds?: number;
    restockAmount?: number;
    sortOrder?: number;
  }): { ok: true; item: VendorItem } | { ok: false; error: string } {
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, error: "name is required" };

    const vendorExists = db.prepare(`SELECT id FROM vendors WHERE id = ?`).get(String(vendorId));
    if (!vendorExists) return { ok: false, error: "Vendor not found" };

    const qty    = Math.max(0, Math.trunc(Number(args.quantity ?? 0)));
    const maxQty = Math.max(0, Math.trunc(Number(args.maxQuantity ?? qty)));
    const id     = uuid();
    const now    = nowIso();

    db.prepare(`
      INSERT INTO vendor_items (
        id, vendor_id, world_id, name, description, image_url, foundry_item_id,
        price_gold, quantity, max_quantity,
        restock_interval_seconds, restock_amount, last_restocked_at,
        sort_order, created_at, updated_at
      ) VALUES (
        @id, @vendorId, @worldId, @name, @description, @imageUrl, @foundryItemId,
        @priceGold, @quantity, @maxQuantity,
        @restockIntervalSeconds, @restockAmount, @lastRestockedAt,
        @sortOrder, @now, @now
      )
    `).run({
      id,
      vendorId:               String(vendorId),
      worldId:                String(args.worldId),
      name,
      description:            args.description   || null,
      imageUrl:               args.imageUrl       || null,
      foundryItemId:          args.foundryItemId  || null,
      priceGold:              Math.max(0, Math.trunc(Number(args.priceGold ?? 0))),
      quantity:               qty,
      maxQuantity:            maxQty,
      restockIntervalSeconds: Math.max(0, Math.trunc(Number(args.restockIntervalSeconds ?? 0))),
      restockAmount:          Math.max(1, Math.trunc(Number(args.restockAmount ?? 1))),
      lastRestockedAt:        nowMs(),
      sortOrder:              Math.trunc(Number(args.sortOrder ?? 0)),
      now,
    });

    return { ok: true, item: rowToItem(db.prepare(`SELECT * FROM vendor_items WHERE id = ?`).get(id) as VendorItemRow) };
  }

  updateItem(itemId: string, args: {
    name?: string;
    description?: string | null;
    imageUrl?: string | null;
    foundryItemId?: string | null;
    priceGold?: number;
    quantity?: number;
    maxQuantity?: number;
    restockIntervalSeconds?: number;
    restockAmount?: number;
    sortOrder?: number;
  }): { ok: true; item: VendorItem } | { ok: false; error: string } {
    const existing = db.prepare(`SELECT * FROM vendor_items WHERE id = ?`).get(String(itemId)) as VendorItemRow | undefined;
    if (!existing) return { ok: false, error: "Item not found" };

    db.prepare(`
      UPDATE vendor_items SET
        name                     = @name,
        description              = @description,
        image_url                = @imageUrl,
        foundry_item_id          = @foundryItemId,
        price_gold               = @priceGold,
        quantity                 = @quantity,
        max_quantity             = @maxQuantity,
        restock_interval_seconds = @restockIntervalSeconds,
        restock_amount           = @restockAmount,
        sort_order               = @sortOrder,
        updated_at               = @now
      WHERE id = @id
    `).run({
      id:                     itemId,
      name:                   args.name        !== undefined ? String(args.name).trim()                                : existing.name,
      description:            args.description !== undefined ? (args.description || null)                              : existing.description,
      imageUrl:               args.imageUrl    !== undefined ? (args.imageUrl    || null)                              : existing.image_url,
      foundryItemId:          args.foundryItemId !== undefined ? (args.foundryItemId || null)                         : existing.foundry_item_id,
      priceGold:              args.priceGold   !== undefined ? Math.max(0, Math.trunc(Number(args.priceGold)))         : existing.price_gold,
      quantity:               args.quantity    !== undefined ? Math.max(0, Math.trunc(Number(args.quantity)))          : existing.quantity,
      maxQuantity:            args.maxQuantity !== undefined ? Math.max(0, Math.trunc(Number(args.maxQuantity)))       : existing.max_quantity,
      restockIntervalSeconds: args.restockIntervalSeconds !== undefined ? Math.max(0, Math.trunc(Number(args.restockIntervalSeconds))) : existing.restock_interval_seconds,
      restockAmount:          args.restockAmount !== undefined ? Math.max(1, Math.trunc(Number(args.restockAmount)))   : existing.restock_amount,
      sortOrder:              args.sortOrder   !== undefined ? Math.trunc(Number(args.sortOrder))                      : existing.sort_order,
      now:                    nowIso(),
    });

    return { ok: true, item: rowToItem(db.prepare(`SELECT * FROM vendor_items WHERE id = ?`).get(itemId) as VendorItemRow) };
  }

  deleteItem(itemId: string): { ok: true } | { ok: false; error: string } {
    const info = db.prepare(`DELETE FROM vendor_items WHERE id = ?`).run(String(itemId));
    if (!info.changes) return { ok: false, error: "Item not found" };
    return { ok: true };
  }

  // ── Purchase ─────────────────────────────────────────────────────────────────

  /**
   * Atomically apply pending restocks, validate stock, deduct item quantity,
   * credit vendor gold, and record a transaction.
   */
  purchase(args: {
    vendorId: string;
    itemId: string;
    quantity: number;
    buyerActorId?: string | null;
    buyerVaultUserId?: string | null;
  }): { ok: true; transaction: VendorTransaction; goldSpent: number } | { ok: false; error: string } {
    const qty = Math.max(1, Math.trunc(Number(args.quantity ?? 1)));

    const result = (db.transaction(() => {
      const vendor = db.prepare(`SELECT * FROM vendors WHERE id = ?`).get(String(args.vendorId)) as VendorRow | undefined;
      if (!vendor) return { ok: false as const, error: "Vendor not found" };

      const itemRow = db.prepare(`SELECT * FROM vendor_items WHERE id = ? AND vendor_id = ?`)
        .get(String(args.itemId), String(args.vendorId)) as VendorItemRow | undefined;
      if (!itemRow) return { ok: false as const, error: "Item not found in this vendor" };

      // Commit any pending restocks so our arithmetic is consistent
      if (itemRow.restock_interval_seconds > 0) {
        const elapsed  = nowMs() - (itemRow.last_restocked_at || 0);
        const periods  = Math.floor(elapsed / (itemRow.restock_interval_seconds * 1000));
        if (periods > 0) {
          const newQty = Math.min(
            itemRow.max_quantity || Number.MAX_SAFE_INTEGER,
            itemRow.quantity + periods * Math.max(1, itemRow.restock_amount)
          );
          db.prepare(`UPDATE vendor_items SET quantity = @qty, last_restocked_at = @ts WHERE id = @id`)
            .run({ qty: newQty, ts: nowMs(), id: itemRow.id });
          itemRow.quantity = newQty; // reflect in-memory for checks below
        }
      }

      const available = Math.max(0, itemRow.quantity);
      if (available < qty) {
        return { ok: false as const, error: `Only ${available} in stock (requested ${qty})` };
      }

      const goldSpent = itemRow.price_gold * qty;

      // Deduct stock; add gold to vendor
      db.prepare(`UPDATE vendor_items SET quantity = quantity - @qty, updated_at = @now WHERE id = @id`)
        .run({ qty, now: nowIso(), id: itemRow.id });
      db.prepare(`UPDATE vendors SET gold = gold + @gold, updated_at = @now WHERE id = @id`)
        .run({ gold: goldSpent, now: nowIso(), id: args.vendorId });

      // Record transaction
      const txId = uuid();
      db.prepare(`
        INSERT INTO vendor_transactions
          (id, vendor_id, world_id, item_id, item_name, buyer_actor_id, buyer_vault_user_id, quantity, gold_spent, created_at)
        VALUES
          (@id, @vendorId, @worldId, @itemId, @itemName, @buyerActorId, @buyerVaultUserId, @qty, @goldSpent, @now)
      `).run({
        id:               txId,
        vendorId:         args.vendorId,
        worldId:          vendor.world_id,
        itemId:           args.itemId,
        itemName:         itemRow.name,
        buyerActorId:     args.buyerActorId    || null,
        buyerVaultUserId: args.buyerVaultUserId || null,
        qty,
        goldSpent,
        now: nowIso(),
      });

      return {
        ok: true as const,
        goldSpent,
        transaction: rowToTransaction(
          db.prepare(`SELECT * FROM vendor_transactions WHERE id = ?`).get(txId) as VendorTransactionRow
        ),
      };
    }) as () => { ok: true; goldSpent: number; transaction: VendorTransaction } | { ok: false; error: string })();

    return result;
  }

  // ── Transactions ────────────────────────────────────────────────────────────

  listTransactions(args: {
    worldId: string;
    vendorId?: string;
    limit?: number;
  }): { ok: true; transactions: VendorTransaction[] } {
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(args.limit ?? 100))));

    let rows: VendorTransactionRow[];
    if (args.vendorId) {
      rows = db.prepare(`
        SELECT * FROM vendor_transactions WHERE world_id = ? AND vendor_id = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(String(args.worldId), String(args.vendorId), limit) as VendorTransactionRow[];
    } else {
      rows = db.prepare(`
        SELECT * FROM vendor_transactions WHERE world_id = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(String(args.worldId), limit) as VendorTransactionRow[];
    }

    return { ok: true, transactions: rows.map(rowToTransaction) };
  }

  // ── Portable packs (import / export) ───────────────────────────────────────

  exportPack(args: {
    worldId: string;
    vendorId?: string | null;
  }): { ok: true; pack: VendorPack } | { ok: false; error: string } {
    const worldId = String(args.worldId ?? "").trim();
    const vendorId = String(args.vendorId ?? "").trim();
    if (!worldId) return { ok: false, error: "worldId is required" };

    let vendorRows: VendorRow[] = [];
    if (vendorId) {
      const one = db.prepare(`SELECT * FROM vendors WHERE world_id = ? AND id = ?`).get(worldId, vendorId) as VendorRow | undefined;
      if (one) vendorRows = [one];
    } else {
      vendorRows = db.prepare(`SELECT * FROM vendors WHERE world_id = ? ORDER BY name ASC`).all(worldId) as VendorRow[];
    }

    if (!vendorRows.length) return { ok: false, error: "No vendors found for export" };

    const vendors = vendorRows.map((vendor) => {
      const itemRows = db.prepare(`
        SELECT * FROM vendor_items
        WHERE world_id = ? AND vendor_id = ?
        ORDER BY sort_order ASC, name ASC
      `).all(worldId, vendor.id) as VendorItemRow[];

      return {
        externalId: vendor.id,
        name: vendor.name,
        description: vendor.description,
        avatarUrl: vendor.avatar_url,
        npcName: vendor.npc_name,
        greetings: (() => {
          try {
            const parsed = JSON.parse(vendor.greetings || "[]");
            return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
          } catch {
            return [];
          }
        })(),
        gold: Math.max(0, Math.trunc(Number(vendor.gold ?? 0))),
        isActive: vendor.is_active === 1,
        items: itemRows.map((it) => ({
          externalId: it.id,
          name: it.name,
          description: it.description,
          imageUrl: it.image_url,
          foundryItemId: it.foundry_item_id,
          priceGold: Math.max(0, Math.trunc(Number(it.price_gold ?? 0))),
          quantity: Math.max(0, Math.trunc(Number(it.quantity ?? 0))),
          maxQuantity: Math.max(0, Math.trunc(Number(it.max_quantity ?? 0))),
          restockIntervalSeconds: Math.max(0, Math.trunc(Number(it.restock_interval_seconds ?? 0))),
          restockAmount: Math.max(1, Math.trunc(Number(it.restock_amount ?? 1))),
          sortOrder: Math.trunc(Number(it.sort_order ?? 0)),
        })),
      };
    });

    const pack: VendorPack = {
      format: "vaulthero.vendorPack",
      version: 1,
      meta: {
        title: vendorId ? "Vendor export" : "Vendor pack export",
        createdAt: nowIso(),
        sourceWorldId: worldId,
      },
      data: { vendors },
    };

    return { ok: true, pack };
  }

  importPack(args: {
    worldId: string;
    pack: any;
    createdBy?: string | null;
  }): {
    ok: true;
    imported: { vendors: number; items: number; mergedVendors: number; mergedItems: number };
  } | {
    ok: false;
    error: string;
  } {
    const worldId = String(args.worldId ?? "").trim();
    if (!worldId) return { ok: false, error: "worldId is required" };

    const root = args.pack?.data ? args.pack : (args.pack?.pack?.data ? args.pack.pack : null);
    const vendorRows = Array.isArray(root?.data?.vendors) ? root.data.vendors : [];
    if (!vendorRows.length) return { ok: false, error: "Pack missing data.vendors[]" };

    let createdVendors = 0;
    let createdItems = 0;
    let mergedVendors = 0;
    let mergedItems = 0;

    for (const rawVendor of vendorRows) {
      const name = String(rawVendor?.name ?? "").trim();
      if (!name) return { ok: false, error: "Vendor is missing required name" };

      const vendorExternalId = String(rawVendor?.externalId ?? "").trim();
      const existingByExternalId = vendorExternalId
        ? (db.prepare(`SELECT * FROM vendors WHERE world_id = ? AND id = ?`).get(worldId, vendorExternalId) as VendorRow | undefined)
        : undefined;
      const existingByName = !existingByExternalId
        ? (db.prepare(`SELECT * FROM vendors WHERE world_id = ? AND lower(name) = lower(?)`).get(worldId, name) as VendorRow | undefined)
        : undefined;
      const existingVendor = existingByExternalId ?? existingByName ?? null;

      const greetings = Array.isArray(rawVendor?.greetings) ? rawVendor.greetings.map((x: any) => String(x)) : [];
      let targetVendorId = "";

      if (existingVendor) {
        const updated = this.updateVendor(existingVendor.id, {
          name,
          description: rawVendor?.description ?? null,
          avatarUrl: rawVendor?.avatarUrl ?? null,
          npcName: rawVendor?.npcName ?? null,
          greetings,
          gold: Number(rawVendor?.gold ?? 0),
          isActive: typeof rawVendor?.isActive === "boolean" ? rawVendor.isActive : undefined,
        });
        if (!updated.ok) return { ok: false, error: updated.error };
        targetVendorId = existingVendor.id;
        mergedVendors++;
      } else {
        const created = this.createVendor({
          worldId,
          name,
          description: rawVendor?.description ?? null,
          avatarUrl: rawVendor?.avatarUrl ?? null,
          npcName: rawVendor?.npcName ?? null,
          greetings,
          gold: Number(rawVendor?.gold ?? 0),
          createdBy: args.createdBy ?? null,
        });
        if (!created.ok) return { ok: false, error: created.error };
        targetVendorId = created.vendor.id;
        createdVendors++;

        if (typeof rawVendor?.isActive === "boolean") {
          this.updateVendor(targetVendorId, { isActive: rawVendor.isActive });
        }
      }

      const items = Array.isArray(rawVendor?.items) ? rawVendor.items : [];
      for (const rawItem of items) {
        const itemName = String(rawItem?.name ?? "").trim();
        if (!itemName) continue;

        const itemExternalId = String(rawItem?.externalId ?? "").trim();
        const foundryItemId = String(rawItem?.foundryItemId ?? "").trim();

        const existingByExternalId = itemExternalId
          ? (db.prepare(`
              SELECT * FROM vendor_items
              WHERE world_id = ? AND vendor_id = ? AND id = ?
            `).get(worldId, targetVendorId, itemExternalId) as VendorItemRow | undefined)
          : undefined;

        const existingByFoundry = !existingByExternalId && foundryItemId
          ? (db.prepare(`
              SELECT * FROM vendor_items
              WHERE world_id = ? AND vendor_id = ? AND foundry_item_id = ?
              LIMIT 1
            `).get(worldId, targetVendorId, foundryItemId) as VendorItemRow | undefined)
          : undefined;

        const existingByNamePrice = !existingByExternalId && !existingByFoundry
          ? (db.prepare(`
              SELECT * FROM vendor_items
              WHERE world_id = ? AND vendor_id = ? AND lower(name) = lower(?) AND price_gold = ?
              LIMIT 1
            `).get(
              worldId,
              targetVendorId,
              itemName,
              Math.max(0, Math.trunc(Number(rawItem?.priceGold ?? 0)))
            ) as VendorItemRow | undefined)
          : undefined;

        const existingItem = existingByExternalId ?? existingByFoundry ?? existingByNamePrice ?? null;

        if (existingItem) {
          const merged = this.updateItem(existingItem.id, {
            name: itemName,
            description: rawItem?.description ?? null,
            imageUrl: rawItem?.imageUrl ?? null,
            foundryItemId: foundryItemId || null,
            priceGold: Number(rawItem?.priceGold ?? 0),
            quantity: Number(rawItem?.quantity ?? 0),
            maxQuantity: Number(rawItem?.maxQuantity ?? rawItem?.quantity ?? 0),
            restockIntervalSeconds: Number(rawItem?.restockIntervalSeconds ?? 0),
            restockAmount: Number(rawItem?.restockAmount ?? 1),
            sortOrder: Number(rawItem?.sortOrder ?? 0),
          });
          if (!merged.ok) return { ok: false, error: merged.error };
          mergedItems++;
          continue;
        }

        const out = this.addItem(targetVendorId, {
          worldId,
          name: itemName,
          description: rawItem?.description ?? null,
          imageUrl: rawItem?.imageUrl ?? null,
          foundryItemId: foundryItemId || null,
          priceGold: Number(rawItem?.priceGold ?? 0),
          quantity: Number(rawItem?.quantity ?? 0),
          maxQuantity: Number(rawItem?.maxQuantity ?? rawItem?.quantity ?? 0),
          restockIntervalSeconds: Number(rawItem?.restockIntervalSeconds ?? 0),
          restockAmount: Number(rawItem?.restockAmount ?? 1),
          sortOrder: Number(rawItem?.sortOrder ?? 0),
        });
        if (!out.ok) return { ok: false, error: out.error };
        createdItems++;
      }
    }

    return {
      ok: true,
      imported: {
        vendors: createdVendors,
        items: createdItems,
        mergedVendors,
        mergedItems,
      },
    };
  }
}

export const vendorStore = new VendorStore();
