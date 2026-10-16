import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, View } from "react-native";
import { useReducedMotion } from "./motion";

/** Expand a live arrival's actual height so the rows below move down with it. */
export function TimelineArrival({ arrivedAt, children }: { arrivedAt?: number; children: ReactNode }) {
  const reduce = useReducedMotion();
  // Virtualized rows mounted later (or revisited after scrolling) are already history.
  const [entering, setEntering] = useState(() => !!arrivedAt && Date.now() - arrivedAt < 1000 && !reduce);
  const progress = useRef(new Animated.Value(entering ? 0 : 1)).current;
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!entering) return;
    if (reduce) { progress.setValue(1); setEntering(false); return; }
    if (!height) return;
    // Height must participate in layout, including on native; a transform alone would make siblings jump.
    const animation = Animated.timing(progress, { toValue: 1, duration: 360, easing: Easing.out(Easing.cubic), useNativeDriver: false, isInteraction: false });
    animation.start(({ finished }) => { if (finished) setEntering(false); });
    return () => animation.stop();
  }, [entering, height, reduce, progress]);
  return <Animated.View testID="timeline-arrival" style={entering ? { height: progress.interpolate({ inputRange: [0, 1], outputRange: [0, height] }), overflow: "hidden", opacity: progress } : undefined}>
    <View onLayout={entering ? event => setHeight(event.nativeEvent.layout.height) : undefined} style={{ flexShrink: 0 }}>
      {children}
    </View>
  </Animated.View>;
}
