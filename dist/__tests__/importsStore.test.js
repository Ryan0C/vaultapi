import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ImportsStore } from "../stores/importStore.js";
const createdDirs = [];
async function mkRoot() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultapi-imports-"));
    createdDirs.push(dir);
    return dir;
}
async function scaffoldWorld(root, worldId) {
    await fs.mkdir(path.join(root, "worlds", worldId), { recursive: true });
}
afterEach(async () => {
    await Promise.all(createdDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
describe("ImportsStore", () => {
    it("creates actor imports from VaultSync export payloads with actor-prefixed ids", async () => {
        const root = await mkRoot();
        const worldId = "test-world";
        await scaffoldWorld(root, worldId);
        const store = new ImportsStore({ dataRoot: root });
        const out = await store.createImport(worldId, {
            type: "vaultsync.import",
            payload: {
                type: "export",
                contractVersion: 1,
                docType: "Actor",
                uuid: "Actor.actorA",
                foundry: { _id: "actorA", name: "Alice" },
            },
        });
        expect(out.ok).toBe(true);
        if (!out.ok)
            return;
        expect(out.id).toMatch(/^actor\.actorA\.\d+\.[a-z0-9]+$/);
        const saved = await store.readImport(worldId, out.id);
        expect(saved).toEqual(expect.objectContaining({
            docType: "Actor",
            uuid: "Actor.actorA",
        }));
    });
    it("infers item/chat/journal prefixes from export docType", async () => {
        const root = await mkRoot();
        const worldId = "test-world";
        await scaffoldWorld(root, worldId);
        const store = new ImportsStore({ dataRoot: root });
        const item = await store.createImport(worldId, {
            type: "vaultsync.import",
            payload: { type: "export", docType: "Item", uuid: "Item.itemA", foundry: { _id: "itemA" } },
        });
        const chat = await store.createImport(worldId, {
            type: "vaultsync.import",
            payload: { type: "export", docType: "ChatMessage", uuid: "ChatMessage.msgA", foundry: { _id: "msgA" } },
        });
        const page = await store.createImport(worldId, {
            type: "vaultsync.import",
            payload: { type: "export", docType: "JournalPage", uuid: "JournalEntry.X.JournalEntryPage.pageA", foundry: { _id: "pageA" } },
        });
        const entry = await store.createImport(worldId, {
            type: "vaultsync.import",
            payload: { type: "export", docType: "JournalEntry", uuid: "JournalEntry.entryA", foundry: { _id: "entryA" } },
        });
        expect(item.ok && item.id.startsWith("item.itemA.")).toBe(true);
        expect(chat.ok && chat.id.startsWith("chat.msgA.")).toBe(true);
        expect(page.ok && page.id.startsWith("page.pageA.")).toBe(true);
        expect(entry.ok && entry.id.startsWith("entry.entryA.")).toBe(true);
    });
    it("preserves actor flags.vaulthero.location in import payload", async () => {
        const root = await mkRoot();
        const worldId = "test-world";
        await scaffoldWorld(root, worldId);
        const store = new ImportsStore({ dataRoot: root });
        const out = await store.createImport(worldId, {
            type: "actor.import",
            entityType: "actor",
            entityId: "actorA",
            payload: {
                type: "export",
                contractVersion: 1,
                docType: "Actor",
                uuid: "Actor.actorA",
                foundry: {
                    _id: "actorA",
                    name: "Alice",
                    flags: {
                        vaulthero: {
                            location: "Neverwinter",
                        },
                    },
                },
            },
        });
        expect(out.ok).toBe(true);
        if (!out.ok)
            return;
        const saved = await store.readImport(worldId, out.id);
        expect(saved?.foundry?.flags?.vaulthero?.location).toBe("Neverwinter");
    });
    it("reads ack markers from processed/_done and reports processed status", async () => {
        const root = await mkRoot();
        const worldId = "test-world";
        await scaffoldWorld(root, worldId);
        const store = new ImportsStore({ dataRoot: root });
        const created = await store.createImport(worldId, {
            type: "vaultsync.import",
            entityType: "actor",
            entityId: "actorA",
            payload: { type: "export", docType: "Actor", uuid: "Actor.actorA", foundry: { _id: "actorA" } },
        });
        expect(created.ok).toBe(true);
        if (!created.ok)
            return;
        const ackDir = path.join(root, "worlds", worldId, "vaultsync", "import", "processed", "_done");
        await fs.mkdir(ackDir, { recursive: true });
        const ackName = `${created.id}.json.1770000000000.abc123.done.json`;
        await fs.writeFile(path.join(ackDir, ackName), JSON.stringify({ ok: true, result: { applied: 1 } }, null, 2), "utf-8");
        const ack = await store.readAck(worldId, created.id);
        expect(ack).toEqual(expect.objectContaining({
            id: created.id,
            status: "processed",
            ok: true,
            file: ackName,
        }));
        const listed = await store.listAcks(worldId);
        expect(listed.some((f) => f === ackName)).toBe(true);
    });
});
//# sourceMappingURL=importsStore.test.js.map