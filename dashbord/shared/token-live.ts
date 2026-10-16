export interface TimedOutput { at: number; start: number | null; output: number }
export const LIVE_BUCKET_MS = 10_000;
/** Cumulative rounding conserves output across adjacent buckets on both server and fleet client. */
export function outputPortion(call: TimedOutput, left: number, right: number): number {
  if (call.start === null || call.start >= call.at) return call.at >= left && call.at <= right ? call.output : 0;
  const progress = (at: number) => Math.max(0, Math.min(1, (at - call.start!) / (call.at - call.start!)));
  return Math.max(0, Math.round(call.output * progress(right)) - Math.round(call.output * progress(left)));
}
export function spreadOutput(call: TimedOutput, start: number, output: number[]): void {
  const endIndex = Math.floor((call.at - start) / LIVE_BUCKET_MS);
  if (call.start === null || call.start >= call.at) { if (endIndex >= 0 && endIndex < output.length) output[endIndex] += call.output; return; }
  const first = Math.max(0, Math.floor((call.start - start) / LIVE_BUCKET_MS)), last = Math.min(output.length - 1, endIndex);
  for (let index = first; index <= last; index++) output[index] += outputPortion(call, start + index * LIVE_BUCKET_MS, start + (index + 1) * LIVE_BUCKET_MS);
}
