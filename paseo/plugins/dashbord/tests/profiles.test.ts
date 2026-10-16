import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { profileSummaries } from "../server/profiles";

test("the device gets each profile's own fields from the plugin, never the daemon config itself", async () => {
  assert.deepEqual(profileSummaries([{ id: "p1", name: "Opus", provider: "claude", model: "opus", modeId: "default", featureValues: { fast: true }, env: { ANTHROPIC_API_KEY: "QX7-key" }, command: ["claude"] }, null, { id: 5 }]),
    [{ id: "p1", name: "Opus", provider: "claude", model: "opus", modeId: "default", featureValues: { fast: true } }]);
  const client = join(__dirname, "..", "client");
  // The 主机 panel reads the config of a host that runs no observatory backend, and keeps only this plugin's install and enable
  // flags (pluginConfigState) the moment it arrives. No other client code reads the daemon config.
  const allowed: Record<string, RegExp> = { "hosts-panel.tsx": /const \{ config \} = await getPaseoClient\(serverId\)\.config\.get\(\);\s*return pluginConfigState\(config\);/ };
  for (const name of (await readdir(client)).filter(name => /\.tsx?$/.test(name))) {
    const text = await readFile(join(client, name), "utf8"), reads = text.match(/\bconfig\.get\(/g)?.length ?? 0;
    if (allowed[name]) { assert.equal(reads, 1, name); assert.match(text, allowed[name]!, name); }
    else assert.equal(reads, 0, name);
  }
});

test("a long name or notes is shortened for display and the profile stays; what is passed on to the new Agent is never cut", () => {
  const long = { id: `p-${"i".repeat(300)}`, name: "N".repeat(401), provider: `custom-${"p".repeat(200)}`, model: "m".repeat(600), modeId: "x".repeat(300),
    thinkingOptionId: "t".repeat(300), featureValues: { [`f${"k".repeat(300)}`]: true }, notes: `${"A".repeat(3998)}😀B` };
  const [summary] = profileSummaries([long]);
  assert.ok(summary, "the profile is kept");
  for (const field of ["id", "provider", "model", "modeId", "thinkingOptionId", "featureValues"] as const) assert.deepEqual(summary[field], long[field], field);
  assert.equal(summary.name, `${"N".repeat(399)}…`);
  assert.ok(summary.notes!.length <= 4000 && summary.notes!.endsWith("…"));
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(summary.notes!), false, "no half of a surrogate pair");
  assert.deepEqual(profileSummaries([{ id: "p2", name: "Short", provider: "codex", notes: "A".repeat(4000) }])[0]?.notes, "A".repeat(4000));
});
