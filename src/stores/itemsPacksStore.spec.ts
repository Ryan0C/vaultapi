import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ItemsPacksStore } from "./itemsPacksStore.js";

async function writeJson(absPath: string, value: unknown) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, JSON.stringify(value, null, 2), "utf-8");
}

function packIndex(entries: any[]) {
  return {
    generatedAt: new Date().toISOString(),
    count: entries.length,
    entries,
  };
}

describe("ItemsPacksStore builder choices cache invalidation", () => {
  const tmpRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpRoots.map((p) => fs.rm(p, { recursive: true, force: true })));
    tmpRoots.length = 0;
  });

  it("refreshes builder choices immediately when a pack index is re-exported", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultapi-items-packs-"));
    tmpRoots.push(root);
    const worldId = "world-a";
    const packId = "classes-pack";
    const packDir = path.join(root, "worlds", worldId, "vaultsync", "exports", "items", "packs", packId);

    await writeJson(
      path.join(packDir, "index.100.alpha.json"),
      packIndex([{ _id: "fighter", name: "Fighter", type: "class", system: {} }]),
    );

    const store = new ItemsPacksStore({ foundryDataRoot: root });
    const first = await store.readBuilderChoices(worldId);
    expect(first.classes.map((x: any) => x.name)).toContain("Fighter");

    await writeJson(
      path.join(packDir, "index.200.beta.json"),
      packIndex([{ _id: "wizard", name: "Wizard", type: "class", system: {} }]),
    );

    const second = await store.readBuilderChoices(worldId);
    const names = second.classes.map((x: any) => x.name);
    expect(names).toContain("Wizard");
    expect(names).not.toContain("Fighter");
  });

  it("includes newly added pack directories without waiting for pack-id cache TTL", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultapi-items-packs-"));
    tmpRoots.push(root);
    const worldId = "world-b";
    const base = path.join(root, "worlds", worldId, "vaultsync", "exports", "items", "packs");

    await writeJson(
      path.join(base, "pack-a", "index.100.alpha.json"),
      packIndex([{ _id: "class-1", name: "Rogue", type: "class", system: {} }]),
    );

    const store = new ItemsPacksStore({ foundryDataRoot: root });
    const first = await store.readBuilderChoices(worldId);
    expect(first.classes.map((x: any) => x.name)).toEqual(["Rogue"]);

    await writeJson(
      path.join(base, "pack-b", "index.110.beta.json"),
      packIndex([{ _id: "species-1", name: "Elf", type: "species", system: {} }]),
    );

    const second = await store.readBuilderChoices(worldId);
    expect(second.classes.map((x: any) => x.name)).toEqual(["Rogue"]);
    expect(second.species.map((x: any) => x.name)).toContain("Elf");
  });
});
