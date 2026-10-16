import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View, type ViewStyle } from "react-native";

// Keep the badge's original ring without loading every motion in the screen chunk.
const web = Platform.OS === "web";
const styles = web ? StyleSheet.create({ ring: { animationIterationCount: "infinite", animationKeyframes: [{ "0%": { transform: "scale(1)", opacity: 0.6 }, "75%": { transform: "scale(2.3)", opacity: 0 }, "100%": { transform: "scale(2.3)", opacity: 0 } }], animationDuration: "1.7s", animationTimingFunction: "cubic-bezier(0, 0, 0.2, 1)" } } as never) : { ring: {} };
export function BadgePing({ size, color, active }: { size: number; color: string; active: boolean }) {
  const [reduce, setReduce] = useState(false), value = useRef(new Animated.Value(0)).current;
  useEffect(() => { let live = true; AccessibilityInfo.isReduceMotionEnabled?.().then(next => { if (live) setReduce(next); }).catch(() => {}); const listener = AccessibilityInfo.addEventListener?.("reduceMotionChanged", setReduce); return () => { live = false; listener?.remove(); }; }, []);
  useEffect(() => { if (web || reduce || !active) return; const animation = Animated.loop(Animated.timing(value, { toValue: 1, duration: 1700, easing: Easing.out(Easing.quad), useNativeDriver: true, isInteraction: false })); animation.start(); return () => animation.stop(); }, [active, reduce, value]);
  if (reduce) return null;
  const ring: ViewStyle = { pointerEvents: "none", position: "absolute", width: size, height: size, borderRadius: size / 2, backgroundColor: color };
  return web ? <View style={[ring, styles.ring, !active ? { animationPlayState: "paused" } as ViewStyle : null]} /> : <Animated.View style={[ring, { opacity: value.interpolate({ inputRange: [0, 0.75, 1], outputRange: [0.6, 0, 0] }), transform: [{ scale: value.interpolate({ inputRange: [0, 0.75, 1], outputRange: [1, 2.3, 2.3] }) }] }]} />;
}
