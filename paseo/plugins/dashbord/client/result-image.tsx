import { useEffect, useState } from "react";
import { Image, Text, View } from "react-native";
import { useRpc } from "./fleet-client";
import type { PluginTheme } from "@getpaseo/plugin";
import { imageSourceKind } from "../shared/prose";
import { getResultImage, loadResultImage, resultImageFailure } from "../shared/result-image";
import { t } from "../shared/text";
import { Button, fontSize, hairline, radius, space } from "./kit";

export function ResultImage({ theme, url, alt, agentId, replyRef }: { theme: PluginTheme; url: string; alt: string; agentId?: string; replyRef?: string }) {
  const read = useRpc(getResultImage), kind = imageSourceKind(url);
  const [attempt, setAttempt] = useState(0), [uri, setUri] = useState<string | null>(null), [failed, setFailed] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false), [width, setWidth] = useState(320), [ratio, setRatio] = useState(1.6);
  useEffect(() => {
    let cancelled = false;
    setUri(null); setFailed(false); setReason(null); setLoaded(false); setRatio(1.6);
    if (kind === "remote") setUri(url);
    else if (kind === "local" && agentId) {
      void loadResultImage(read, agentId, url, () => cancelled, replyRef).then(value => { if (!cancelled) setUri(value); }).catch(error => { if (!cancelled) { setReason(resultImageFailure(error)); setFailed(true); } });
    } else setFailed(true);
    return () => { cancelled = true; };
  }, [read, kind, url, agentId, replyRef, attempt]);
  const { colors } = theme;
  return <View testID="result-image" onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ minWidth: 0, gap: space.xs }}>
    {failed ? <View style={{ padding: space.md, gap: space.xs, borderWidth: hairline, borderColor: colors.border, borderRadius: radius.md }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small }}>{t("secondaryResultView.imageUnavailable")}{alt ? ` · ${alt}` : ""}</Text>
      {reason ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.small }}>{reason}</Text> : null}
      <Text selectable style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{url}</Text>
      <Button theme={theme} label={t("secondaryResultView.retryImage")} variant="ghost" size="sm" icon="RefreshCw" onPress={() => setAttempt(value => value + 1)} />
    </View> : <>
      {!loaded ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{t("secondaryResultView.loadingImage")}</Text> : null}
      {uri ? <Image key={attempt} source={{ uri }} accessibilityLabel={alt || t("secondaryResultView.image")} resizeMode="contain"
        style={{ width: "100%", height: Math.min(480, width / ratio), borderRadius: radius.md }}
        onLoad={event => { const source = event.nativeEvent.source; if (source?.width > 0 && source?.height > 0) setRatio(source.width / source.height); setLoaded(true); }}
        onError={() => setFailed(true)} /> : null}
    </>}
  </View>;
}
