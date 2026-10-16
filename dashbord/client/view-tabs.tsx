import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { fontSize, glow, gradient, hue, isDarkTheme, radius, type Hue } from "./kit";

export interface ViewTab<Value extends string> { value: Value; label: string; icon: string; colors: readonly [Hue, Hue]; count?: number }
type Interaction = { pressed: boolean; hovered?: boolean };

/**
 * Main navigation: the selected view is a gradient pill with its own colours; the others show a coloured icon.
 * `iconOnly` (phones) hides the labels of unselected views — their names stay in the accessibility label — and the
 * row scrolls sideways instead of wrapping when it still does not fit.
 */
export function ViewTabs<Value extends string>({ theme, value, tabs, onChange, iconOnly = false, accessibilityLabel }: {
  theme: PluginTheme; value: Value; tabs: readonly ViewTab<Value>[]; onChange: (value: Value) => void; iconOnly?: boolean; accessibilityLabel?: string;
}) {
  const { colors } = theme;
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 1 }} contentContainerStyle={{ alignItems: "center", paddingVertical: 3, paddingHorizontal: 2 }}>
    <View accessibilityRole="tablist" accessibilityLabel={accessibilityLabel} style={{ flexDirection: "row", alignItems: "center", gap: iconOnly ? 2 : 4 }}>
      {tabs.map(tab => {
        const selected = tab.value === value, bare = iconOnly && !selected;
        const name = tab.count === undefined ? tab.label : `${tab.label} ${tab.count}`;
        return <Pressable key={tab.value} accessibilityRole="tab" accessibilityLabel={name} accessibilityState={{ selected }} aria-selected={selected} onPress={() => onChange(tab.value)} hitSlop={{ top: 6, bottom: 6 }}
          style={state => {
            const { hovered, pressed } = state as Interaction;
            return [{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, height: 30, minWidth: bare ? 30 : undefined, paddingHorizontal: bare ? 0 : 11, borderRadius: radius.full, opacity: pressed ? 0.8 : 1 },
              selected ? [gradient(theme, tab.colors, { angle: 120 }), glow(theme, hue(theme, tab.colors[1]), 12)] : { backgroundColor: hovered ? hue(theme, tab.colors[0], "soft") : "transparent" }];
          }}>
          <Icon name={tab.icon} size={15} color={selected ? "#ffffff" : hue(theme, tab.colors[0], isDarkTheme(theme) ? "solid" : "text")} />
          {bare ? null : <Text numberOfLines={1} style={{ color: selected ? "#ffffff" : colors.foregroundMuted, fontSize: fontSize.small, fontWeight: selected ? "800" : "500" }}>{tab.label}</Text>}
          {!bare && tab.count !== undefined ? <Text style={{ color: selected ? "#ffffff" : colors.foregroundMuted, opacity: selected ? 0.85 : 1, fontSize: fontSize.meta, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{tab.count}</Text> : null}
        </Pressable>;
      })}
    </View>
  </ScrollView>;
}
