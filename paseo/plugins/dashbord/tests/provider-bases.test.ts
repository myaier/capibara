import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { providerBasesFromConfig, quotaBaseOf } from "../shared/provider-bases";
import { providerBasesReader, readProviderBases } from "../server/provider-bases";

const config = {
  agents: { providers: {
    "my-claude": { extends: "claude", env: { CLAUDE_CONFIG_DIR: "/home/me/.claude-work", API_TOKEN: "not-a-real-token" } },
    "work-codex": { extends: "codex", command: ["codex-wrapper"] },
    "my-acp": { extends: "acp", command: ["my-acp-agent", "--stdio"] },
    claude: { enabled: true },
    "self-loop": { extends: "self-loop" },
    "bad id!": { extends: "claude" },
    "odd-shape": ["claude"],
    "plugin-based": { extends: "muse" },
  } },
};

test("custom providers count as the provider they extend; ACP ones, built-ins and odd entries stand for themselves", () => {
  assert.deepEqual(providerBasesFromConfig(config), { "my-claude": "claude", "work-codex": "codex", "plugin-based": "muse" });
  assert.equal(quotaBaseOf("my-claude", providerBasesFromConfig(config)), "claude");
  assert.equal(quotaBaseOf("my-acp", providerBasesFromConfig(config)), "my-acp", "an ACP provider is its own usage source");
  assert.equal(quotaBaseOf("codex"), "codex");
  for (const value of [null, {}, { agents: null }, { agents: { providers: [] } }, "text"]) assert.deepEqual(providerBasesFromConfig(value), {});
});

test("only `extends` leaves the daemon config; a missing, oversized or broken file reads as no custom providers", async () => {
  const home = await mkdtemp(join(tmpdir(), "observatory-bases-"));
  try {
    assert.deepEqual(await readProviderBases(home), {}, "no config yet");
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const bases = await readProviderBases(home);
    assert.deepEqual(bases, { "my-claude": "claude", "work-codex": "codex", "plugin-based": "muse" });
    assert.ok(!JSON.stringify(bases).includes("not-a-real-token") && !JSON.stringify(bases).includes(".claude-work"), "no env or paths");
    await writeFile(join(home, "config.json"), "{ not json");
    assert.deepEqual(await readProviderBases(home), {});
    await writeFile(join(home, "config.json"), JSON.stringify({ ...config, padding: "x".repeat(5 * 1024 * 1024) }));
    assert.deepEqual(await readProviderBases(home), {}, "over 4 MiB");
    // Cached for five minutes, then read again.
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    let clock = 0;
    const read = providerBasesReader({ home, now: () => clock });
    assert.deepEqual(await read(), bases);
    await writeFile(join(home, "config.json"), JSON.stringify({ agents: { providers: { "new-one": { extends: "pi" } } } }));
    clock += 60_000;
    assert.deepEqual(await read(), bases, "still the cached map");
    clock += 5 * 60_000;
    assert.deepEqual(await read(), { "new-one": "pi" });
  } finally { await rm(home, { recursive: true, force: true }); }
});
