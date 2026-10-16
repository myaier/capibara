import { useMemo } from "react";
import { Text, View, type TextStyle } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { proseBlocks, proseTokens, type ProseToken } from "../shared/prose";
import { t } from "../shared/text";
import { fontSize, hairline, hue, space } from "./kit";
import { monoFont } from "./ui";
import { CodeBlock } from "./timeline-view";
import { openExternalUrl } from "./open-url";
import { ResultImage } from "./result-image";

function Inline({ theme, tokens, depth = 0 }: { theme: PluginTheme; tokens: ProseToken[]; depth?: number }) {
  return <>{tokens.map((token, key) => {
    if (token.kind === "text" || token.kind === "image") return token.text;
    if (token.kind === "code") return token.text.trim() ? <Text key={key} style={{ fontFamily: monoFont, fontSize: fontSize.small, backgroundColor: theme.colors.surface2 }}>{token.text}</Text> : token.text;
    if (token.kind === "link") return <Text key={key} accessibilityRole="link" accessibilityHint={t("secondaryResultView.openInBrowser")}
      onPress={() => { void openExternalUrl(token.url).catch(() => {}); }} style={{ color: hue(theme, "blue", "text"), textDecorationLine: "underline" }}>{token.text}</Text>;
    const style: TextStyle = token.kind === "bold" ? { fontWeight: "600" } : token.kind === "italic" ? { fontStyle: "italic" } : { textDecorationLine: "line-through" };
    return <Text key={key} style={style}>{depth < 8 ? <Inline theme={theme} tokens={proseTokens(token.text)} depth={depth + 1} /> : token.text}</Text>;
  })}</>;
}

/** Images are block children of a View, never nested Views inside native Text. */
function ProseText({ theme, text, style, heading, agentId, replyRef }: { theme: PluginTheme; text: string; style: TextStyle; heading?: boolean; agentId?: string; replyRef?: string }) {
  const tokens = proseTokens(text), children = [];
  let inline: ProseToken[] = [];
  const flush = () => {
    if (inline.some(token => token.kind !== "text" || token.text.trim())) children.push(<Text selectable key={children.length} accessibilityRole={heading ? "header" : undefined} style={style}><Inline theme={theme} tokens={inline} /></Text>);
    inline = [];
  };
  for (const token of tokens) {
    if (token.kind === "image") { flush(); children.push(<ResultImage key={`${children.length}:${agentId}:${token.url}`} theme={theme} url={token.url} alt={token.text} agentId={agentId} replyRef={replyRef} />); }
    else inline.push(token);
  }
  flush();
  return <View style={{ minWidth: 0, gap: space.sm }}>{children}</View>;
}

/** Native, selectable Markdown with bounded image loading; raw HTML is always displayed as text. */
export function OutputText({ theme, text, agentId, replyRef }: { theme: PluginTheme; text: string; agentId?: string; replyRef?: string }) {
  const { colors } = theme, blocks = useMemo(() => proseBlocks(text), [text]);
  const body: TextStyle = { color: colors.foreground, fontSize: fontSize.content, lineHeight: 24 };
  return <View testID="markdown-output" style={{ minWidth: 0, gap: space.md }}>{blocks.map((block, key) => {
    if (block.kind === "code") return <CodeBlock key={key} theme={theme} label={block.language || t("secondaryResultView.code")} value={block.text} />;
    if (block.kind === "rule") return <View key={key} style={{ borderBottomWidth: hairline, borderBottomColor: colors.border, marginVertical: space.xs }} />;
    if (block.kind === "heading") return <ProseText key={key} theme={theme} text={block.text} agentId={agentId} replyRef={replyRef} heading style={{ ...body, fontSize: block.level === 1 ? fontSize.heading : fontSize.title, fontWeight: "600", lineHeight: 26 }} />;
    if (block.kind === "quote") return <View key={key} style={{ borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: space.md }}><ProseText theme={theme} text={block.text} agentId={agentId} replyRef={replyRef} style={{ ...body, color: colors.foregroundMuted }} /></View>;
    if (block.kind === "table") return <ScrollView key={key} testID="markdown-table-scroll" horizontal style={{ flexGrow: 0, maxWidth: "100%" }}>
      <View testID="markdown-table" style={{ borderWidth: hairline, borderColor: colors.border }}>
        {[block.headers, ...block.rows].map((cells, row) => <View key={row} style={{ flexDirection: "row", backgroundColor: row === 0 ? colors.surface2 : "transparent", borderBottomWidth: row < block.rows.length ? hairline : 0, borderBottomColor: colors.border }}>
          {block.headers.map((_, column) => <View key={column} style={{ width: 160, padding: space.sm }}><ProseText theme={theme} text={cells[column] ?? ""} agentId={agentId} replyRef={replyRef} style={{ ...body, fontSize: fontSize.small, textAlign: block.align[column], fontWeight: row === 0 ? "600" : "400" }} /></View>)}
        </View>)}
      </View>
    </ScrollView>;
    if (block.kind === "list") return <View key={key} style={{ gap: space.xs }}>{block.items.map((item, n) => <View key={n} style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingLeft: item.depth * space.lg }}>
      <Text accessibilityLabel={item.checked === undefined ? undefined : t(item.checked ? "secondaryResultView.taskChecked" : "secondaryResultView.taskUnchecked")} style={{ ...body, minWidth: item.marker === "•" ? 10 : 18, color: item.marker === "•" ? hue(theme, "blue") : colors.foregroundMuted, fontWeight: "600" }}>{item.checked === undefined ? item.marker : item.checked ? "☑" : "☐"}</Text>
      <View style={{ flex: 1, minWidth: 0 }}><ProseText theme={theme} text={item.text} agentId={agentId} replyRef={replyRef} style={body} /></View>
    </View>)}</View>;
    return <ProseText key={key} theme={theme} text={block.text} agentId={agentId} replyRef={replyRef} style={body} />;
  })}</View>;
}
