import type { DigestCheck, DigestCommand, DigestFile, DigestTurn } from "../../shared/digest";
import type { FoldState } from "./model";

/** Derive aggregates from final tool facts, so lifecycle updates never count as additional calls. */
export function buildAggregates(state: FoldState, turns: DigestTurn[], now: number) {
  const files = new Map<string, DigestFile>(), commands = new Map<string, DigestCommand>(), checks: DigestCheck[] = [];
  const edited = new Set<string>(), turnFiles = new Map<number, Set<string>>();
  for (const tool of [...state.tools.values()].sort((a, b) => a.start - b.start || a.seq - b.seq)) {
    const turn = turns[tool.turn - 1]; if (!turn) continue;
    if (tool.path && (tool.lane === "read" || tool.lane === "edit")) {
      const key = tool.pathKey ?? tool.path;
      const file = files.get(key) ?? { path: tool.path, reads: 0, edits: 0, added: 0, removed: 0, lastAt: 0, turns: [] };
      if (tool.lane === "read") file.reads++;
      else {
        file.edits++; file.added += tool.added; file.removed += tool.removed; edited.add(key);
        const paths = turnFiles.get(tool.turn) ?? new Set<string>(); paths.add(key); turnFiles.set(tool.turn, paths);
      }
      file.lastAt = Math.max(file.lastAt, tool.end);
      if (!file.turns.includes(tool.turn)) file.turns.push(tool.turn);
      files.set(key, file);
    }
    if (tool.lane === "edit") { turn.added += tool.added; turn.removed += tool.removed; }
    if (tool.lane !== "shell") continue;
    turn.commands++;
    const program = tool.program || "shell", entry = commands.get(program) ?? { program, runs: 0, failures: 0, ms: 0, sample: "" };
    entry.runs++; entry.failures += Number(tool.status === "failed");
    entry.ms += Math.max(0, (tool.status === "running" && turn.outcome === "running" ? Math.max(now, tool.end) : tool.end) - tool.start);
    entry.sample = tool.command; commands.set(program, entry);
    if (tool.check) {
      const ok = tool.status === "ok" ? true : tool.status === "failed" ? false : null;
      checks.push({ kind: tool.check, start: tool.start, end: tool.status === "running" ? null : tool.end,
        command: tool.command, ok, turn: tool.turn, seq: tool.seq });
      if (ok === true) turn.checksPassed++; if (ok === false) turn.checksFailed++;
    }
  }
  for (const turn of turns) turn.files = turnFiles.get(turn.index)?.size ?? 0;
  return { files: [...files.values()].map(file => ({ ...file, turns: file.turns.sort((a, b) => a - b).slice(-20) }))
    .sort((a, b) => b.edits + b.reads - a.edits - a.reads || b.lastAt - a.lastAt || a.path.localeCompare(b.path)),
    commands: [...commands.values()].sort((a, b) => b.runs - a.runs || a.program.localeCompare(b.program)),
    checks, editedFiles: edited.size };
}
