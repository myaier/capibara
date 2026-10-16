import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindTranslator, createTranslator, type Catalog } from "../shared/i18n";
import zh from "../shared/locales/zh-CN.json";
import en from "../shared/locales/en.json";
import kitZh from "../shared/locales/kit/zh-CN.json";
import kitEn from "../shared/locales/kit/en.json";
import { ResumeLedger } from "../server/resume";
import type { PaseoApi } from "../server/paseo-types";
import type { ProviderBridge } from "../server/provider-subagents";
import { eventLabel } from "../shared/telemetry";
import { bigNumber } from "../shared/stats-view";
import { cadenceLabel } from "../shared/schedules";

const speak = (language: "en" | "zh-CN", overrides: Catalog = {}) => bindTranslator(createTranslator(language, [overrides, language === "en" ? en : zh, language === "en" ? kitEn : kitZh]));
const now = Date.parse("2026-10-15T00:00:00Z"), wake = now + 60 * 60_000;
const agentId = "a0000000-0000-4000-8000-000000000001";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "obs-i18n-resume-"));
  const schedules = new Map<string, Record<string, unknown>>();
  const bridge = { request: async (message: Record<string, unknown>) => {
    if (message.type === "schedule/list") return { schedules: [...schedules.values()] };
    if (message.type === "schedule/create") {
      const schedule = { ...message, id: "a0000000-0000-4000-8000-000000000002", status: "active", createdAt: new Date(now).toISOString(), nextRunAt: new Date(wake).toISOString(), runs: [] };
      schedules.set(schedule.id, schedule); return { schedule };
    }
    if (message.type === "schedule/inspect") return { schedule: schedules.get(String(message.scheduleId)) };
    if (message.type === "schedule/delete") { schedules.delete(String(message.scheduleId)); return {}; }
    throw new Error(`Unexpected request: ${message.type}`);
  } } as unknown as Pick<ProviderBridge, "request">;
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { id: agentId, title: "Original task", archivedAt: null, status: "idle", lastUserMessageAt: null } }) }) } } as unknown as PaseoApi;
  let ledger = new ResumeLedger(bridge, { directory, now: () => now, timers: false });
  return {
    directory, schedules, paseo,
    get ledger() { return ledger; },
    async reopen() { await ledger.close(); ledger = new ResumeLedger(bridge, { directory, now: () => now, timers: false }); await ledger.ready; },
    async close() { await ledger.close(); await rm(directory, { recursive: true, force: true }); speak("zh-CN"); },
  };
}

for (const [initial, switched] of [["en", "zh-CN"], ["zh-CN", "en"]] as const) {
  test(`a ${initial} resume survives switching to ${switched} and restarting without storing its text`, async () => {
    const f = await fixture();
    try {
      speak(initial);
      const created = await f.ledger.schedule(f.paseo, { agentId, at: new Date(wake).toISOString() });
      assert.equal(created.status, "scheduled");
      const original = f.schedules.get(created.scheduleId!)!;
      assert.match(String(original.name), initial === "en" ? /^Resume after reset/ : /^恢复后续跑/);
      const saved = await readFile(join(f.directory, "resume-ledger.json"), "utf8");
      assert.ok(!saved.includes("Original task") && !saved.includes(String(original.prompt)));
      speak(switched); await f.reopen();
      assert.equal((await f.ledger.cancel(f.paseo, { agentId })).status, "canceled");
      assert.equal(f.schedules.size, 0);
    } finally { await f.close(); }
  });
}

for (const field of ["name", "prompt"] as const) {
  test(`a translated resume whose ${field} was edited remains the user's after a language change`, async () => {
    const f = await fixture();
    try {
      speak("en");
      const created = await f.ledger.schedule(f.paseo, { agentId, at: new Date(wake).toISOString() });
      f.schedules.get(created.scheduleId!)![field] = "User changed this";
      speak("zh-CN"); await f.reopen();
      assert.equal((await f.ledger.cancel(f.paseo, { agentId })).status, "failed");
      assert.equal(f.schedules.size, 1);
    } finally { await f.close(); }
  });
}

test("stored lifecycle labels translate by stable type while user text stays unchanged", () => {
  try {
    speak("en");
    assert.equal(eventLabel({ type: "created", label: "新建 Agent" }), "Agent created");
    assert.equal(eventLabel({ type: "turn_completed", label: "完成重复请求验证" }), "完成重复请求验证");
    assert.equal(eventLabel({ type: "permission_resolved", label: "custom text", localized: true, permissionAllowed: false }), "Request denied or withdrawn");
    assert.equal(bigNumber(15_000), "15k");
    assert.equal(bigNumber(1_500_000), "1.5M");
  } finally { speak("zh-CN"); }
});


test("cron weekdays keep whole English names and Chinese wording across language changes", () => {
  const cadence = { type: "cron" as const, expression: "0 9 * * 1,3,5" };
  try {
    speak("en");
    assert.equal(cadenceLabel(cadence), "Every Monday, Wednesday, Friday 09:00");
    speak("zh-CN");
    assert.equal(cadenceLabel(cadence), "每周一、三、五 09:00");
  } finally { speak("zh-CN"); }
});
