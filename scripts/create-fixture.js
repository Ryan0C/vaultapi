#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const targetRoot = process.argv[2];
if (!targetRoot) {
  console.error("Usage: node create-fixture.js <target-root>");
  process.exit(1);
}

const worldId = "test-world";
const base = path.resolve(targetRoot);
const worldRoot = path.join(base, "worlds", worldId);

function nowTs() {
  return Date.now();
}

async function writeJson(rel, data) {
  const file = path.join(worldRoot, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function main() {
  console.log("Creating fixture vault at:", base);

  // ---- META ----
  await writeJson("meta/world.json", {
    id: worldId,
    title: "Test World",
    system: "dnd5e",
    coreVersion: "13.x",
    createdAt: new Date().toISOString()
  });

  await writeJson("meta/status.json", {
    lastSync: new Date().toISOString()
  });

  await writeJson("meta/vault.json", {
    version: 1
  });

  await writeJson("meta/users.json", {
    users: []
  });

  // ---- ACTORS ----
  const actors = [
    { id: "actorA", name: "Sir Testalot", type: "character" },
    { id: "actorB", name: "Goblin Tester", type: "npc" }
  ];

  for (const a of actors) {
    await writeJson(`actors/${a.id}.json`, {
      id: a.id,
      name: a.name,
      type: a.type,
      system: {}
    });
  }

  await writeJson("actors/tombstones/deletedActor.json", {
    id: "deletedActor",
    deletedAt: new Date().toISOString()
  });

  await writeJson("manifests/actors.json", {
    worldId,
    count: actors.length,
    actors: actors.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type
    })),
    generatedAt: new Date().toISOString()
  });

  // ---- CHAT ----
  const day = "2026-02-11";
  const hour = "22";
  const ts1 = nowTs();
  const ts2 = ts1 + 1000;

  const events = [
    {
      op: "create",
      ts: ts1,
      id: "msg1",
      message: { content: "Hello world" }
    },
    {
      op: "create",
      ts: ts2,
      id: "msg2",
      message: { content: "Second message" }
    }
  ];

  for (const evt of events) {
    await writeJson(
      `chat/events/${day}/${hour}/${evt.ts}-${evt.op}-${evt.id}.json`,
      evt
    );
  }

  await writeJson(`chat/manifests/${day}/${hour}.json`, {
    day,
    hour,
    count: events.length,
    firstTs: ts1,
    lastTs: ts2
  });

  console.log("Fixture created successfully.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});