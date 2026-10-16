import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostMemoryStore } from "../server/host-memory";

const seen = (serverId: string, seenAt: string, version: string | null = "2.20.0-dev.1") =>
  ({ serverId, label: serverId === "srv_demo_win" ? "WIN-DEMO-PC" : "BUILD-DEMO", version, revision: version ? "8e1f2c3d4b5a69788796a5b4c3d2e1f00a1b2c3d" : null, seenAt });

test("host sightings survive a restart in a private file, and an older sighting never replaces a newer one", async t => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-host-memory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new HostMemoryStore(directory);
  assert.deepEqual(await store.get(), { hosts: [] });
  await store.remember([seen("srv_demo_win", "2026-10-16T08:00:00.000Z"), seen("srv_demo_build", "2026-10-15T08:00:00.000Z", null)]);
  await store.remember([seen("srv_demo_win", "2026-10-14T08:00:00.000Z", "2.19.0-dev.8")]);
  const restarted = new HostMemoryStore(directory);
  assert.deepEqual((await restarted.get()).hosts, [seen("srv_demo_win", "2026-10-16T08:00:00.000Z"), seen("srv_demo_build", "2026-10-15T08:00:00.000Z", null)]);
  assert.equal((await stat(join(directory, "host-memory.json"))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "host-memory.json"), "utf8")).version, 1);
});

test("an unreadable memory file starts empty instead of failing the panel", async t => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-host-memory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "host-memory.json"), "{ not json");
  assert.deepEqual(await new HostMemoryStore(directory).get(), { hosts: [] });
  await writeFile(join(directory, "host-memory.json"), JSON.stringify({ version: 1, hosts: [{ serverId: "", label: 1 }] }));
  assert.deepEqual(await new HostMemoryStore(directory).get(), { hosts: [] });
});
