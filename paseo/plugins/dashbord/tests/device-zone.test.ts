import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceZone, validZone } from "../server/device-zone";

test("only real IANA zone names are accepted", () => {
  assert.equal(validZone("US/Pacific"), "US/Pacific");
  assert.equal(validZone("America/New_York"), "America/New_York");
  assert.equal(validZone("Etc/GMT+8"), "Etc/GMT+8");
  for (const value of ["", "Not/AZone", "../etc", "US/Pacific; rm -rf", 42, null, undefined, "x".repeat(80)]) assert.equal(validZone(value), null, String(value));
});

test("the devices' zone wins over the host's once a client reports it, and survives a restart (grok-F2)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-zone-"));
  try {
    const first = new DeviceZone({ directory, hostZone: "UTC" });
    await first.ready;
    assert.equal(first.device(), null);
    assert.equal(first.current(), "UTC", "before any report: the host's zone");
    first.note("bogus/zone"); first.note(undefined);
    assert.equal(first.current(), "UTC", "invalid reports are ignored");
    first.note("US/Pacific");
    assert.equal(first.current(), "US/Pacific");
    await first.close();
    const saved = JSON.parse(await readFile(join(directory, "device-zone.json"), "utf8"));
    assert.deepEqual(saved, { version: 1, zone: "US/Pacific" }, "only the zone name is stored");
    assert.equal((await stat(join(directory, "device-zone.json"))).mode & 0o777, 0o600);
    const second = new DeviceZone({ directory, hostZone: "UTC" });
    await second.ready;
    assert.equal(second.current(), "US/Pacific", "a daemon restart keeps the devices' zone");
    second.note("America/New_York"); await second.close();
    assert.equal(JSON.parse(await readFile(join(directory, "device-zone.json"), "utf8")).zone, "America/New_York");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a damaged or foreign zone file is ignored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-zone-"));
  try {
    await writeFile(join(directory, "device-zone.json"), "{ not json");
    const zones = new DeviceZone({ directory, hostZone: "UTC" });
    await zones.ready;
    assert.equal(zones.current(), "UTC");
    await writeFile(join(directory, "device-zone.json"), JSON.stringify({ zone: "../../etc/passwd" }));
    const again = new DeviceZone({ directory, hostZone: "UTC" });
    await again.ready;
    assert.equal(again.device(), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
