import { useState } from "react";
import { View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { t } from "../shared/text";
import { Button, Chip, ChipBar, Sheet, space } from "./kit";
import { ChoiceList } from "./ui";

export function StatsFilters({ theme, project, provider, model, projects, providers, models, onProject, onProvider, onModel }: {
  theme: PluginTheme; project: string; provider: string; model: string;
  projects: readonly { id: string; name: string }[]; providers: string[]; models: string[];
  onProject(value: string): void; onProvider(value: string): void; onModel(value: string): void;
}) {
  const [sheet, setSheet] = useState<"project" | "provider" | "model" | null>(null);
  const all = { project: t("coreDashboard.allProjects"), provider: t("fleet.allProviders"), model: t("fleet.allModels") };
  const items = { project: projects.map(row => ({ value: row.id, label: row.name })), provider: providers.map(value => ({ value, label: value })), model: models.map(value => ({ value, label: value })) };
  const value = { project, provider, model }, change = { project: onProject, provider: onProvider, model: onModel };
  return <View style={{ paddingHorizontal: space.lg, paddingVertical: space.xs }}>
    <ChipBar>{(["project", "provider", "model"] as const).map(key => <Chip key={key} theme={theme}
      label={value[key] === "all" ? all[key] : items[key].find(row => row.value === value[key])?.label ?? value[key]}
      icon={key === "project" ? "Folder" : key === "provider" ? "Bot" : "Cpu"} selected={value[key] !== "all"} onPress={() => setSheet(key)} />)}</ChipBar>
    <Sheet title={t("fleet.businessFilters")} open={sheet !== null} onClose={() => setSheet(null)}>
      {sheet ? <ChoiceList theme={theme} value={value[sheet]} options={[{ value: "all", label: all[sheet] }, ...items[sheet]]}
        onChange={value => { change[sheet](value); setSheet(null); }} /> : null}
      <Button theme={theme} label={t("coreFilters.reset")} onPress={() => { onProject("all"); onProvider("all"); onModel("all"); setSheet(null); }} />
    </Sheet>
  </View>;
}
