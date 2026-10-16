import { t } from "../shared/text";
import { useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { AGENT_STATUSES, type AgentStatus } from "../shared/model";
import type { SavedView } from "../shared/preferences";
import { rangeLabels, type TimeRange } from "../shared/time-range";
import { Button, Chip, Divider, IconButton, MetaLine, ProjectMark, Sheet, TextField, fontSize, hue, space, type Tone } from "./kit";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { ChoiceList, statusNames } from "./ui";

export type SessionScope = "all" | "current" | "history";
export const sessionScopeNames: Record<SessionScope, string> = { get all() { return t("coreFilters.allSessions"); }, get current() { return t("coreFilters.currentSessions"); }, get history() { return t("coreFilters.pastSessions"); } };
export const readFilterNames = { get all() { return t("coreFilters.allResults"); }, get unread() { return t("coreFilters.completedAndUnread"); }, get read() { return t("coreFilters.completedAndRead"); } } as const;

function Group({ theme, title, children }: { theme: PluginTheme; title: string; children: ReactNode }) {
  return <View style={{ gap: space.sm }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "500" }}>{title}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>{children}</View>
  </View>;
}
function Choices<Value extends string>({ theme, title, options, value, onChange }: { theme: PluginTheme; title: string; options: readonly (readonly [Value, string, Tone?])[]; value: Value; onChange: (value: Value) => void }) {
  return <Group theme={theme} title={title}>{options.map(([id, label, tone]) => <Chip key={id} theme={theme} label={label} tone={tone} selected={value === id} onPress={() => onChange(id)} />)}</Group>;
}
/** Status chips carry the same colours as the list: running blue, waiting amber, error red, done green. */
const statusTones: Partial<Record<AgentStatus, Tone>> = { running: "info", initializing: "info", waiting: "warning", error: "danger", completed: "success" };

export interface FilterState {
  status: AgentStatus | "all"; readFilter: "all" | "unread" | "read"; sessionScope: SessionScope;
  checkout: string; workspace: string; provider: string;
}
/** Everything that is not a quick scope: status, read state, checkout, workspace, provider, and named views. */
export function FilterSheet({ theme, open, onClose, archiveMode, state, checkouts, workspaces, providers, showWorkspace, onChange, onReset, savedViews, canSave, onSaveView, onApplyView, onDeleteView }: {
  theme: PluginTheme; open: boolean; onClose: () => void; archiveMode: boolean; state: FilterState;
  checkouts: readonly (readonly [string, string])[]; workspaces: readonly (readonly [string, string])[]; providers: readonly string[]; showWorkspace: boolean;
  onChange: (patch: Partial<FilterState>) => void; onReset: () => void;
  savedViews: readonly SavedView[]; canSave: boolean; onSaveView: (name: string) => Promise<void>; onApplyView: (view: SavedView) => void; onDeleteView: (view: SavedView) => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const save = () => { const trimmed = name.trim(); if (!trimmed || saving) return; setSaving(true); void onSaveView(trimmed).then(() => setName("")).catch(() => {}).finally(() => setSaving(false)); };
  return <Sheet title={t("coreFilters.filters")} open={open} onClose={onClose}>
    {!archiveMode ? <Choices theme={theme} title={t("coreFilters.sessions")} options={(["all", "current", "history"] as const).map(id => [id, sessionScopeNames[id]] as const)} value={state.sessionScope} onChange={sessionScope => onChange({ sessionScope, readFilter: "all" })} /> : null}
    <Choices theme={theme} title={t("coreFilters.status")} options={[["all", t("coreFilters.allStatuses")], ...AGENT_STATUSES.map(id => [id, statusNames[id], statusTones[id]] as const)]} value={state.status} onChange={status => onChange({ status })} />
    {!archiveMode ? <Choices theme={theme} title={t("coreFilters.results")} options={(["all", "unread", "read"] as const).map(id => [id, readFilterNames[id], id === "unread" ? "success" as const : undefined] as const)} value={state.readFilter} onChange={readFilter => onChange({ readFilter, status: "all", sessionScope: "all" })} /> : null}
    <Choices theme={theme} title={t("coreFilters.worktreeCheckout")} options={[["all", t("coreFilters.allCheckouts")], ...checkouts]} value={state.checkout} onChange={checkout => onChange({ checkout })} />
    {showWorkspace ? <Choices theme={theme} title={t("coreFilters.workspace")} options={[["all", t("coreFilters.allWorkspaces")], ...workspaces]} value={state.workspace} onChange={workspace => onChange({ workspace, checkout: "all" })} /> : null}
    <Choices theme={theme} title={t("coreFilters.provider")} options={[["all", t("coreFilters.allProviders")], ...providers.map(id => [id, id] as const)]} value={state.provider} onChange={provider => onChange({ provider })} />
    <Divider theme={theme} />
    <View style={{ gap: space.sm }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "500" }}>{t("coreFilters.savedViews")}</Text>
      {savedViews.map(view => <View key={view.id} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <View style={{ flex: 1, minWidth: 0, alignItems: "flex-start" }}><Chip theme={theme} label={view.name} icon="Bookmark" onPress={() => { onApplyView(view); onClose(); }} /></View>
        <IconButton theme={theme} icon="Trash2" label={t("coreFilters.deleteView", { value1: view.name })} size="sm" onPress={() => onDeleteView(view)} />
      </View>)}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
        <View style={{ flex: 1 }}><TextField theme={theme} label={t("coreFilters.viewName")} value={name} onChangeText={setName} placeholder={t("coreFilters.forExampleUnreadPaymentProjectResults")} /></View>
        <Button theme={theme} label={t("coreFilters.saveView")} icon="Bookmark" onPress={save} disabled={!name.trim() || !canSave} busy={saving} />
      </View>
    </View>
    <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm, paddingTop: space.xs }}>
      <Button theme={theme} label={t("coreFilters.reset")} variant="ghost" onPress={onReset} />
      <Button theme={theme} label={t("coreFilters.done")} variant="primary" onPress={onClose} />
    </View>
  </Sheet>;
}

export function ProjectSheet({ theme, open, onClose, projects, value, total, onChange }: {
  theme: PluginTheme; open: boolean; onClose: () => void; projects: readonly { id: string; name: string; count: number }[]; value: string; total: number; onChange: (id: string) => void;
}) {
  return <Sheet title={t("coreFilters.projects")} open={open} onClose={onClose}>
    <ChoiceList theme={theme} value={value} onChange={id => { onChange(id); onClose(); }} options={[{ value: "all", label: t("coreFilters.allProjects"), count: total, leading: <Icon name="Layers" size={18} color={hue(theme, "blue")} /> },
      ...projects.map(project => ({ value: project.id, label: project.name, count: project.count, leading: <ProjectMark theme={theme} name={project.name} size={20} /> }))]} />
  </Sheet>;
}

export const rangeOptions: readonly TimeRange[] = ["24h", "7d", "30d", "all"];
export function RangeSheet({ theme, open, onClose, value, onChange }: { theme: PluginTheme; open: boolean; onClose: () => void; value: TimeRange; onChange: (range: TimeRange) => void }) {
  return <Sheet title={t("coreFilters.timeRange")} open={open} onClose={onClose}>
    <ChoiceList theme={theme} value={value} onChange={range => { onChange(range); onClose(); }} options={rangeOptions.map(range => ({ value: range, label: rangeLabels[range] }))} />
    <MetaLine theme={theme} numberOfLines={2} parts={[t("coreFilters.runningSessionsPendingApprovalsAndUnreadResults")]} />
  </Sheet>;
}
