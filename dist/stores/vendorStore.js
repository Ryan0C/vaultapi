// src/stores/vendorStore.ts
import { db } from "../services/db.js";
import { v4 as uuid } from "uuid";
// ─── Helpers ──────────────────────────────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }
function nowMs() { return Date.now(); }
/**
 * Compute effective (displayed) quantity using lazy restock evaluation.
 * We do NOT write to the DB here — that happens on purchase to keep reads cheap.
 */
function computeEffectiveQuantity(row) {
    const base = Math.max(0, row.quantity);
    if (row.restock_interval_seconds <= 0)
        return base;
    const elapsed = nowMs() - (row.last_restocked_at || 0);
    const periods = Math.floor(elapsed / (row.restock_interval_seconds * 1000));
    if (periods <= 0)
        return base;
    const restored = periods * Math.max(1, row.restock_amount);
    return Math.min(row.max_quantity || base + restored, base + restored);
}
function rowToVendor(r) {
    let greetings = [];
    try {
        greetings = JSON.parse(r.greetings || "[]");
    }
    catch {
        greetings = [];
    }
    return {
        id: r.id,
        worldId: r.world_id,
        name: r.name,
        description: r.description,
        avatarUrl: r.avatar_url,
        npcName: r.npc_name,
        greetings,
        gold: r.gold,
        isActive: r.is_active === 1,
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}
function rowToItem(r) {
    return {
        id: r.id,
        vendorId: r.vendor_id,
        worldId: r.world_id,
        name: r.name,
        description: r.description,
        imageUrl: r.image_url,
        foundryItemId: r.foundry_item_id,
        priceGold: r.price_gold,
        quantity: r.quantity,
        effectiveQuantity: computeEffectiveQuantity(r),
        maxQuantity: r.max_quantity,
        restockIntervalSeconds: r.restock_interval_seconds,
        restockAmount: r.restock_amount,
        lastRestockedAt: r.last_restocked_at,
        sortOrder: r.sort_order,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}
function rowToTransaction(r) {
    return {
        id: r.id,
        vendorId: r.vendor_id,
        worldId: r.world_id,
        itemId: r.item_id,
        itemName: r.item_name,
        buyerActorId: r.buyer_actor_id,
        buyerVaultUserId: r.buyer_vault_user_id,
        quantity: r.quantity,
        goldSpent: r.gold_spent,
        createdAt: r.created_at,
    };
}
// ─── Store ────────────────────────────────────────────────────────────────────
export class VendorStore {
    // ── Vendor CRUD ─────────────────────────────────────────────────────────────
    listVendors(worldId, opts = {}) {
        const sql = opts.includeInactive
            ? `SELECT * FROM vendors WHERE world_id = ? ORDER BY is_active DESC, name ASC`
            : `SELECT * FROM vendors WHERE world_id = ? AND is_active = 1 ORDER BY name ASC`;
        const rows = db.prepare(sql).all(String(worldId));
        return { ok: true, vendors: rows.map(rowToVendor) };
    }
    getVendor(vendorId, opts = {}) {
        const vendorRow = db.prepare(`SELECT * FROM vendors WHERE id = ?`).get(String(vendorId));
        if (!vendorRow)
            return { ok: false, error: "Vendor not found" };
        if (!opts.includeInactive && vendorRow.is_active !== 1) {
            return { ok: false, error: "This shop is currently closed" };
        }
        const itemRows = db.prepare(`
      SELECT * FROM vendor_items WHERE vendor_id = ? ORDER BY sort_order ASC, name ASC
    `).all(String(vendorId));
        return {
            ok: true,
            vendor: { ...rowToVendor(vendorRow), items: itemRows.map(rowToItem) },
        };
    }
    createVendor(args) {
        const name = String(args.name ?? "").trim();
        if (!name)
            return { ok: false, error: "name is required" };
        const id = uuid();
        const now = nowIso();
        db.prepare(`
      INSERT INTO vendors (id, world_id, name, description, avatar_url, npc_name, greetings, gold, is_active, created_by, created_at, updated_at)
      VALUES (@id, @worldId, @name, @description, @avatarUrl, @npcName, @greetings, @gold, 1, @createdBy, @now, @now)
    `).run({
            id,
            worldId: String(args.worldId),
            name,
            description: args.description ? String(args.description) : null,
            avatarUrl: args.avatarUrl ? String(args.avatarUrl) : null,
            npcName: args.npcName ? String(args.npcName) : null,
            greetings: JSON.stringify(Array.isArray(args.greetings) ? args.greetings : []),
            gold: Math.max(0, Math.trunc(Number(args.gold ?? 0))),
            createdBy: args.createdBy ? String(args.createdBy) : null,
            now,
        });
        return { ok: true, vendor: rowToVendor(db.prepare(`SELECT * FROM vendors WHERE id = ?`).get(id)) };
    }
    updateVendor(vendorId, args) {
        const existing = db.prepare(`SELECT * FROM vendors WHERE id = ?`).get(String(vendorId));
        if (!existing)
            return { ok: false, error: "Vendor not found" };
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
            id: vendorId,
            name: args.name !== undefined ? String(args.name).trim() : existing.name,
            description: args.description !== undefined ? (args.description || null) : existing.description,
            avatarUrl: args.avatarUrl !== undefined ? (args.avatarUrl || null) : existing.avatar_url,
            npcName: args.npcName !== undefined ? (args.npcName || null) : existing.npc_name,
            greetings: args.greetings !== undefined ? JSON.stringify(Array.isArray(args.greetings) ? args.greetings : []) : (existing.greetings || "[]"),
            gold: args.gold !== undefined ? Math.max(0, Math.trunc(Number(args.gold))) : existing.gold,
            isActive: args.isActive !== undefined ? (args.isActive ? 1 : 0) : existing.is_active,
            now: nowIso(),
        });
        return { ok: true, vendor: rowToVendor(db.prepare(`SELECT * FROM vendors WHERE id = ?`).get(vendorId)) };
    }
    deleteVendor(vendorId) {
        const info = db.prepare(`DELETE FROM vendors WHERE id = ?`).run(String(vendorId));
        if (!info.changes)
            return { ok: false, error: "Vendor not found" };
        return { ok: true };
    }
    // ── Item CRUD ────────────────────────────────────────────────────────────────
    addItem(vendorId, args) {
        const name = String(args.name ?? "").trim();
        if (!name)
            return { ok: false, error: "name is required" };
        const vendorExists = db.prepare(`SELECT id FROM vendors WHERE id = ?`).get(String(vendorId));
        if (!vendorExists)
            return { ok: false, error: "Vendor not found" };
        const qty = Math.max(0, Math.trunc(Number(args.quantity ?? 0)));
        const maxQty = Math.max(0, Math.trunc(Number(args.maxQuantity ?? qty)));
        const id = uuid();
        const now = nowIso();
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
            vendorId: String(vendorId),
            worldId: String(args.worldId),
            name,
            description: args.description || null,
            imageUrl: args.imageUrl || null,
            foundryItemId: args.foundryItemId || null,
            priceGold: Math.max(0, Math.trunc(Number(args.priceGold ?? 0))),
            quantity: qty,
            maxQuantity: maxQty,
            restockIntervalSeconds: Math.max(0, Math.trunc(Number(args.restockIntervalSeconds ?? 0))),
            restockAmount: Math.max(1, Math.trunc(Number(args.restockAmount ?? 1))),
            lastRestockedAt: nowMs(),
            sortOrder: Math.trunc(Number(args.sortOrder ?? 0)),
            now,
        });
        return { ok: true, item: rowToItem(db.prepare(`SELECT * FROM vendor_items WHERE id = ?`).get(id)) };
    }
    updateItem(itemId, args) {
        const existing = db.prepare(`SELECT * FROM vendor_items WHERE id = ?`).get(String(itemId));
        if (!existing)
            return { ok: false, error: "Item not found" };
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
            id: itemId,
            name: args.name !== undefined ? String(args.name).trim() : existing.name,
            description: args.description !== undefined ? (args.description || null) : existing.description,
            imageUrl: args.imageUrl !== undefined ? (args.imageUrl || null) : existing.image_url,
            foundryItemId: args.foundryItemId !== undefined ? (args.foundryItemId || null) : existing.foundry_item_id,
            priceGold: args.priceGold !== undefined ? Math.max(0, Math.trunc(Number(args.priceGold))) : existing.price_gold,
            quantity: args.quantity !== undefined ? Math.max(0, Math.trunc(Number(args.quantity))) : existing.quantity,
            maxQuantity: args.maxQuantity !== undefined ? Math.max(0, Math.trunc(Number(args.maxQuantity))) : existing.max_quantity,
            restockIntervalSeconds: args.restockIntervalSeconds !== undefined ? Math.max(0, Math.trunc(Number(args.restockIntervalSeconds))) : existing.restock_interval_seconds,
            restockAmount: args.restockAmount !== undefined ? Math.max(1, Math.trunc(Number(args.restockAmount))) : existing.restock_amount,
            sortOrder: args.sortOrder !== undefined ? Math.trunc(Number(args.sortOrder)) : existing.sort_order,
            now: nowIso(),
        });
        return { ok: true, item: rowToItem(db.prepare(`SELECT * FROM vendor_items WHERE id = ?`).get(itemId)) };
    }
    deleteItem(itemId) {
        const info = db.prepare(`DELETE FROM vendor_items WHERE id = ?`).run(String(itemId));
        if (!info.changes)
            return { ok: false, error: "Item not found" };
        return { ok: true };
    }
    // ── Purchase ─────────────────────────────────────────────────────────────────
    /**
     * Atomically apply pending restocks, validate stock, deduct item quantity,
     * credit vendor gold, and record a transaction.
     */
    purchase(args) {
        const qty = Math.max(1, Math.trunc(Number(args.quantity ?? 1)));
        const result = db.transaction(() => {
            const vendor = db.prepare(`SELECT * FROM vendors WHERE id = ?`).get(String(args.vendorId));
            if (!vendor)
                return { ok: false, error: "Vendor not found" };
            const itemRow = db.prepare(`SELECT * FROM vendor_items WHERE id = ? AND vendor_id = ?`)
                .get(String(args.itemId), String(args.vendorId));
            if (!itemRow)
                return { ok: false, error: "Item not found in this vendor" };
            // Commit any pending restocks so our arithmetic is consistent
            if (itemRow.restock_interval_seconds > 0) {
                const elapsed = nowMs() - (itemRow.last_restocked_at || 0);
                const periods = Math.floor(elapsed / (itemRow.restock_interval_seconds * 1000));
                if (periods > 0) {
                    const newQty = Math.min(itemRow.max_quantity || Number.MAX_SAFE_INTEGER, itemRow.quantity + periods * Math.max(1, itemRow.restock_amount));
                    db.prepare(`UPDATE vendor_items SET quantity = @qty, last_restocked_at = @ts WHERE id = @id`)
                        .run({ qty: newQty, ts: nowMs(), id: itemRow.id });
                    itemRow.quantity = newQty; // reflect in-memory for checks below
                }
            }
            const available = Math.max(0, itemRow.quantity);
            if (available < qty) {
                return { ok: false, error: `Only ${available} in stock (requested ${qty})` };
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
                id: txId,
                vendorId: args.vendorId,
                worldId: vendor.world_id,
                itemId: args.itemId,
                itemName: itemRow.name,
                buyerActorId: args.buyerActorId || null,
                buyerVaultUserId: args.buyerVaultUserId || null,
                qty,
                goldSpent,
                now: nowIso(),
            });
            return {
                ok: true,
                goldSpent,
                transaction: rowToTransaction(db.prepare(`SELECT * FROM vendor_transactions WHERE id = ?`).get(txId)),
            };
        })();
        return result;
    }
    // ── Transactions ────────────────────────────────────────────────────────────
    listTransactions(args) {
        const limit = Math.min(500, Math.max(1, Math.trunc(Number(args.limit ?? 100))));
        let rows;
        if (args.vendorId) {
            rows = db.prepare(`
        SELECT * FROM vendor_transactions WHERE world_id = ? AND vendor_id = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(String(args.worldId), String(args.vendorId), limit);
        }
        else {
            rows = db.prepare(`
        SELECT * FROM vendor_transactions WHERE world_id = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(String(args.worldId), limit);
        }
        return { ok: true, transactions: rows.map(rowToTransaction) };
    }
}
export const vendorStore = new VendorStore();
//# sourceMappingURL=vendorStore.js.map