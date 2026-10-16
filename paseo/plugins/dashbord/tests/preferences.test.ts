import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PreferencesStore } from "../server/preferences";
import { defaultViewPreferences, isCompletionSnoozed, updatePreferences } from "../shared/preferences";
import { normalizeAgent } from "../shared/model";

const at = Date.parse("2026-09-17T12:00:00Z");
const completion = "2026-09-17T11:59:00Z";
const until = "2026-09-17T13:00:00Z";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "observatory-preferences-"));
  let now = at;
  const store = new PreferencesStore({ directory, now: () => now });
  return { store, directory, setNow: (next: number) => { now = next; }, async close() { await store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("preferences defaults distinguish overview/archive and partial view writes preserve fields", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.store.get("overview")).view.view, "tree");
    assert.equal((await f.store.get("archives")).view.view, "list");
    const first = await f.store.update({ viewKey: "overview", expectedRevision: 0, view: { project: "p", expanded: ["a", "a", "b"], scrollOffset: 372 } });
    assert.equal(first.status, "updated"); assert.equal(first.revision, 1); assert.deepEqual(first.view.expanded, ["a", "b"]);
    const second = await f.store.update({ viewKey: "overview", expectedRevision: first.revision, view: { readFilter: "unread" } });
    assert.equal(second.view.project, "p"); assert.equal(second.view.scrollOffset, 372); assert.equal(second.view.range, "7d");
    const archive = await f.store.get("archives"); assert.equal(archive.view.project, "all"); assert.equal(archive.revision, second.revision);
  } finally { await f.close(); }
});

test("concurrent same-revision mutations reject the stale writer without losing the winner", async () => {
  const f = await fixture();
  try {
    const [first, second] = await Promise.all([
      f.store.update({ viewKey: "overview", expectedRevision: 0, view: { project: "winner" } }),
      f.store.update({ viewKey: "archives", expectedRevision: 0, view: { project: "stale" } }),
    ]);
    assert.equal(first.status, "updated"); assert.equal(second.status, "conflict"); assert.equal(second.revision, 1);
    assert.equal((await f.store.get("overview")).view.project, "winner"); assert.equal((await f.store.get("archives")).view.project, "all");
  } finally { await f.close(); }
});

test("search text is never synced in the live view, including text saved by older versions, but saved views keep theirs", async () => {
  const f = await fixture();
  try {
    const typed = await f.store.update({ viewKey: "overview", expectedRevision: 0, view: { query: "only on this device", status: "idle" } });
    assert.equal(typed.view.query, ""); assert.equal(typed.view.status, "idle");
    const saved = await f.store.update({ viewKey: "overview", expectedRevision: typed.revision, saveView: { name: "我的搜索", view: { ...typed.view, query: "deploy" } } });
    assert.equal(saved.savedViews[0].view.query, "deploy");
    await f.store.close();
    const stored = JSON.parse(await readFile(join(f.directory, "preferences.json"), "utf8"));
    assert.equal(stored.views[0].view.query, "");
    stored.views[0].view.query = "left by an older version";
    await writeFile(join(f.directory, "preferences.json"), JSON.stringify(stored));
    const again = new PreferencesStore({ directory: f.directory, now: () => at });
    const restored = await again.get("overview");
    assert.equal(restored.view.query, ""); assert.equal(restored.view.status, "idle"); assert.equal(restored.savedViews[0].view.query, "deploy");
    await again.close();
  } finally { await f.close(); }
});

test("named views are scoped, bounded at twelve, editable and removable", async () => {
  const f = await fixture();
  try {
    let revision = 0;
    for (let i = 0; i < 12; i++) revision = (await f.store.update({ viewKey: "overview", expectedRevision: revision, saveView: { name: `视图 ${i}`, view: { ...defaultViewPreferences(), project: `p${i}` } } })).revision;
    assert.equal((await f.store.get("overview")).savedViews.length, 12); assert.equal((await f.store.get("archives")).savedViews.length, 0);
    await assert.rejects(f.store.update({ viewKey: "overview", expectedRevision: revision, saveView: { name: "超限", view: defaultViewPreferences() } }), /12/);
    const saved = (await f.store.get("overview")).savedViews[0]!;
    const changed = await f.store.update({ viewKey: "overview", expectedRevision: revision, saveView: { id: saved.id, name: "重命名", view: { ...saved.view, readFilter: "read" } } });
    assert.equal(changed.savedViews[0]?.name, "重命名"); assert.equal(changed.savedViews.length, 12);
    const deleted = await f.store.update({ viewKey: "overview", expectedRevision: changed.revision, deleteSavedViewId: saved.id });
    assert.equal(deleted.savedViews.length, 11);
  } finally { await f.close(); }
});

test("snoozes are exact-version host-wide metadata and expire without clearing native state", async () => {
  const f = await fixture();
  try {
    const first = await f.store.update({ viewKey: "overview", expectedRevision: 0, snooze: { agentId: "a", completionAt: completion, until } });
    const agent = normalizeAgent({ id: "a", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: completion });
    assert.equal(isCompletionSnoozed(agent, first.snoozes, at), true);
    assert.equal(agent.requiresAttention, true);
    assert.equal((await f.store.get("archives")).snoozes.length, 1);
    const next = normalizeAgent({ id: "a", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: "2026-09-17T12:01:00Z" });
    assert.equal(isCompletionSnoozed(next, first.snoozes, at), false);
    f.setNow(Date.parse(until)); assert.equal((await f.store.get("overview")).snoozes.length, 0);
    assert.equal(isCompletionSnoozed(agent, first.snoozes, Date.parse(until)), false);
  } finally { await f.close(); }
});

test("unsnooze removes only the targeted completion and invalid dates cannot mutate revision", async () => {
  const f = await fixture();
  try {
    const a = await f.store.update({ viewKey: "overview", expectedRevision: 0, snooze: { agentId: "a", completionAt: completion, until } });
    const b = await f.store.update({ viewKey: "overview", expectedRevision: a.revision, snooze: { agentId: "a", completionAt: "2026-09-17T11:58:00Z", until } });
    const c = await f.store.update({ viewKey: "overview", expectedRevision: b.revision, unsnooze: { agentId: "a", completionAt: completion } });
    assert.equal(c.snoozes.length, 1); assert.equal(c.snoozes[0]?.completionAt, "2026-09-17T11:58:00Z");
    await assert.rejects(f.store.update({ viewKey: "overview", expectedRevision: c.revision, snooze: { agentId: "a", completionAt: completion, until: "2026-11-01T12:00:00Z" } }), /30/);
    assert.equal((await f.store.get("overview")).revision, c.revision);
  } finally { await f.close(); }
});

test("preferences persist privately, reload and keep normal/archive saved states isolated", async () => {
  const f = await fixture();
  try {
    await f.store.update({ viewKey: "overview", expectedRevision: 0, view: { project: "remember", scrollOffset: 50 } });
    const again = new PreferencesStore({ directory: f.directory, now: () => at });
    assert.equal((await again.get("overview")).view.project, "remember"); assert.equal((await again.get("archives")).view.project, "all"); await again.close();
    assert.equal((await stat(join(f.directory, "preferences.json"))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(f.directory), ["preferences.json"]);
    assert.equal(JSON.parse(await readFile(join(f.directory, "preferences.json"), "utf8")).version, 1);
  } finally { await f.close(); }
});

test("corrupt files are backed up once and invalid payload sizes are rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-preferences-bad-"));
  await writeFile(join(directory, "preferences.json"), "invalid");
  const store = new PreferencesStore({ directory, now: () => at });
  try {
    assert.ok((await store.get("overview")).error);
    const updated = await store.update({ viewKey: "overview", expectedRevision: 0, view: { project: "fresh" } }); assert.equal(updated.error, null);
    assert.equal(await readFile(join(directory, "preferences.json.corrupt"), "utf8"), "invalid");
    assert.equal(updatePreferences.input.safeParse({ viewKey: "overview", expectedRevision: 1, view: { query: "x".repeat(1001) } }).success, false);
    assert.equal(updatePreferences.input.safeParse({ viewKey: "overview", expectedRevision: 1, view: { scrollOffset: Infinity } }).success, false);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("the optional 需要处理 focus round-trips, clears explicitly and never breaks views stored without it", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.store.get("overview")).view.focus, undefined);
    const focused = await f.store.update({ viewKey: "overview", expectedRevision: 0, view: { focus: "attention", sort: "recent" } });
    assert.equal(focused.view.focus, "attention");
    const other = await f.store.update({ viewKey: "overview", expectedRevision: focused.revision, view: { project: "p" } });
    assert.equal(other.view.focus, "attention", "partial writes preserve the scope");
    const cleared = await f.store.update({ viewKey: "overview", expectedRevision: other.revision, view: { focus: "all" } });
    assert.equal(cleared.view.focus, "all"); assert.equal(cleared.view.sort, "recent");
    await f.store.close();
    const stored = JSON.parse(await readFile(join(f.directory, "preferences.json"), "utf8"));
    delete stored.views[0].view.focus;
    await writeFile(join(f.directory, "preferences.json"), JSON.stringify(stored));
    const reloaded = new PreferencesStore({ directory: f.directory, now: () => at });
    const legacy = await reloaded.get("overview");
    assert.equal(legacy.error, null); assert.equal(legacy.view.focus, undefined); assert.equal(legacy.view.project, "p");
    await reloaded.close();
    assert.equal(updatePreferences.input.safeParse({ viewKey: "overview", expectedRevision: 1, view: { focus: "everything" } }).success, false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
