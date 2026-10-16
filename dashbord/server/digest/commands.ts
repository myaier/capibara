import { t } from "../../shared/text";
import type { CheckKind } from "../../shared/digest";

type CommandAnalysis = { program: string; check: CheckKind | null; git: string | null };
type Token = { kind: "word" | "separator" | "redirect"; value: string; quoted?: boolean };
const MAX_INPUT = 65_536;
const MAX_TOKENS = 2_048;
const MAX_COMMANDS = 128;
const CHECK_ORDER: readonly CheckKind[] = ["test", "typecheck", "lint", "build", "install"];
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
const basename = (value: string) => value.slice(value.lastIndexOf("/") + 1).toLowerCase();
const executable = (value: string) => basename(value).replace(/@[^@]+$/, "");
const excerpt = (value: string) => {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length <= 40 ? line : `${line.slice(0, 39)}…`;
};

/** A deliberately small, bounded shell lexer. It never evaluates expansions or follows files. */
function lex(input: string): Token[] {
  const source = input.slice(0, MAX_INPUT);
  const tokens: Token[] = [];
  const heredocs: { delimiter: string; tabs: boolean }[] = [];
  let pendingHeredoc: boolean | null = null;
  let word = "", open = false, quote = "", quoted = false;
  const flush = () => {
    if (!open) return;
    tokens.push({ kind: "word", value: word, quoted });
    if (pendingHeredoc !== null) { heredocs.push({ delimiter: word, tabs: pendingHeredoc }); pendingHeredoc = null; }
    word = ""; open = false; quoted = false;
  };
  for (let i = 0; i < source.length && tokens.length < MAX_TOKENS; i++) {
    const char = source[i]!;
    if (quote) {
      if (char === quote) { quote = ""; continue; }
      if (char === "\\" && quote === '"' && /[\\"$`\n]/.test(source[i + 1] ?? "")) {
        if (source[i + 1] !== "\n") word += source[i + 1];
        i++; continue;
      }
      word += char; continue;
    }
    if (char === "'" || char === '"') { quote = char; open = true; quoted = true; continue; }
    if (char === "\\") {
      if (i + 1 < source.length) { if (source[i + 1] !== "\n") { word += source[i + 1]; open = true; quoted = true; } i++; }
      continue;
    }
    // Keep substitutions opaque, including any shell operators inside them.
    if (char === "`" || (char === "$" && /[({]/.test(source[i + 1] ?? ""))) {
      open = true;
      const closing = char === "`" ? "`" : source[i + 1] === "(" ? ")" : "}";
      const opening = char === "`" ? "`" : source[i + 1]!;
      let depth = 1, nestedQuote = "", j = i + (char === "`" ? 1 : 2);
      for (; j < source.length; j++) {
        const next = source[j]!;
        if (next === "\\") { j++; continue; }
        if (nestedQuote) { if (next === nestedQuote) nestedQuote = ""; continue; }
        if (next === "'" || next === '"') { nestedQuote = next; continue; }
        if (next === closing && --depth === 0) break;
        if (next === closing) continue;
        if (opening !== "`" && next === opening) depth++;
      }
      word += "${…}"; i = j; continue;
    }
    if (char === "#" && !open) { while (i < source.length && source[i] !== "\n") i++; i--; continue; }
    if (/\s/.test(char)) {
      flush();
      if (char === "\n") {
        tokens.push({ kind: "separator", value: "\n" });
        for (const here of heredocs.splice(0)) {
          let found = false;
          while (i + 1 < source.length) {
            const start = i + 1, next = source.indexOf("\n", start), end = next < 0 ? source.length : next;
            const line = source.slice(start, end).replace(/\r$/, "");
            i = end;
            if ((here.tabs ? line.replace(/^\t+/, "") : line) === here.delimiter) { found = true; break; }
          }
          if (!found) return tokens;
        }
      }
      continue;
    }
    if (char === ">" || char === "<") {
      if (/^\d+$/.test(word)) { word = ""; open = false; } else flush();
      let operator = char;
      if (source[i + 1] === char) operator += source[++i];
      if (operator === "<<" && source[i + 1] === "<") operator += source[++i];
      if (operator === "<<" && source[i + 1] === "-") operator += source[++i];
      if (/[&|]/.test(source[i + 1] ?? "")) operator += source[++i];
      if (operator === "<<" || operator === "<<-") pendingHeredoc = operator === "<<-";
      tokens.push({ kind: "redirect", value: operator }); continue;
    }
    if (/[;&|(){}]/.test(char)) {
      flush(); let separator = char;
      if (source[i + 1] === char && /[;&|]/.test(char)) separator += source[++i];
      tokens.push({ kind: "separator", value: separator }); continue;
    }
    word += char; open = true;
  }
  // An incomplete quote or truncated final token cannot safely identify a command.
  if (!quote && input.length <= MAX_INPUT && tokens.length < MAX_TOKENS) flush();
  return tokens;
}

function simpleCommands(input: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [], skipTarget = false, functionDepth = 0, functionPending = false, conditional = false;
  const tokens = lex(input);
  for (let i = 0; i < tokens.length && commands.length < MAX_COMMANDS; i++) {
    const token = tokens[i]!;
    // && and || inside [[ ... ]] combine predicates, not executable commands. Quoted ]] is data.
    if (conditional) {
      if (token.kind === "word" && token.value === "]]" && !token.quoted) conditional = false;
      continue;
    }
    if (functionDepth) {
      if (token.kind === "separator" && token.value === "{") functionDepth++;
      if (token.kind === "separator" && token.value === "}") functionDepth--;
      continue;
    }
    if (token.kind === "separator") {
      if (token.value === "(" && (words.length === 1 || words[0] === "function") && tokens[i + 1]?.value === ")" && tokens[i + 2]?.value === "{") {
        words = []; functionPending = true; continue;
      }
      if (token.value === "{" && (functionPending || words[0] === "function")) { words = []; functionPending = false; functionDepth = 1; continue; }
      if (words.length) commands.push(words);
      words = []; skipTarget = false; continue;
    }
    if (token.kind === "redirect") { skipTarget = true; continue; }
    if (skipTarget) { skipTarget = false; continue; }
    if (token.value === "[[" && !token.quoted && words.every(word => ["!", "if", "elif", "while", "until", "then", "do", "else"].includes(word))) {
      words.push(token.value); conditional = true; continue;
    }
    words.push(token.value);
  }
  if (words.length && commands.length < MAX_COMMANDS) commands.push(words);
  return commands;
}

function skipOptions(words: string[], start: number, withValue: ReadonlySet<string>): number {
  let index = start;
  while (index < words.length && words[index]!.startsWith("-")) {
    const flag = words[index++]!;
    if (flag === "--") break;
    if (withValue.has(flag)) index++;
  }
  return index;
}

const sudoValues = new Set(["-u", "-g", "-h", "-p", "-C", "-T", "-R", "-D", "--user", "--group", "--host", "--prompt", "--close-from", "--command-timeout", "--chroot", "--chdir"]);
const timeoutValues = new Set(["-k", "-s", "--kill-after", "--signal"]);
const envValues = new Set(["-u", "--unset", "-C", "--chdir"]);
const runnerValues = new Set(["-p", "--package", "-c", "--call", "--cache", "--registry", "--userconfig"]);
const packageValues = new Set(["--prefix", "--cwd", "--dir", "-C", "--filter", "-F", "--workspace", "-w"]);
/** `uv run`, `poetry run` and `pipenv run` options that take a value, before and after `run`. */
const envRunValues = new Set(["--with", "--with-editable", "--with-requirements", "-p", "--python", "--package", "--extra", "--group", "--only-group",
  "--no-group", "--env-file", "--index", "--index-url", "--default-index", "--extra-index-url", "-f", "--find-links", "--directory", "--project",
  "-C", "-P", "--cache-dir", "--config-file", "--color"]);

function unwrap(words: string[], depth: number): string[][] {
  let args = words;
  for (let step = 0; step < 24 && args.length; step++) {
    while (assignment.test(args[0] ?? "") || ["!", "then", "do", "else", "if", "elif", "while", "until"].includes(args[0] ?? "")) args = args.slice(1);
    const program = basename(args[0] ?? "");
    if (!program || ["cd", "export", "unset", "function"].includes(program)) return [];
    if (program === "sudo") { args = args.slice(skipOptions(args, 1, sudoValues)); continue; }
    if (program === "timeout") { args = args.slice(skipOptions(args, 1, timeoutValues) + 1); continue; }
    if (program === "time") { args = args.slice(skipOptions(args, 1, new Set(["-f", "--format", "-o", "--output"]))); continue; }
    if (program === "env") {
      const index = skipOptions(args, 1, envValues);
      const inline = args.slice(1, index).find(flag => flag.startsWith("--split-string="));
      if (inline) return depth < 6 ? commandsFrom(inline.slice("--split-string=".length), depth + 1) : [args];
      if (args.slice(1, index).some(flag => flag === "-S" || flag === "--split-string")) {
        return depth < 6 ? commandsFrom(args.slice(index).join(" "), depth + 1) : [args];
      }
      args = args.slice(index); continue;
    }
    if (["command", "exec", "nohup"].includes(program)) {
      if (program === "command" && args.slice(1).some(flag => flag === "-v" || flag === "-V")) return [args];
      args = args.slice(skipOptions(args, 1, new Set(["-a"]))); continue;
    }
    if (["bash", "sh", "zsh", "dash", "ksh"].includes(program)) {
      for (let i = 1; i < args.length; i++) {
        const flag = args[i]!;
        if (!flag.startsWith("-")) break;
        if (/^-[^-]*c/.test(flag)) return depth < 6 && args[i + 1] !== undefined ? commandsFrom(args[i + 1]!, depth + 1) : [args];
        if (flag === "--") break;
      }
      return [args];
    }
    if (["npx", "bunx", "uvx"].includes(program)) {
      if (program === "npx") {
        const call = args.findIndex(arg => arg === "-c" || arg === "--call");
        if (call > 0) return depth < 6 && args[call + 1] !== undefined ? commandsFrom(args[call + 1]!, depth + 1) : [args];
      }
      args = args.slice(skipOptions(args, 1, program === "uvx" ? new Set(["--from", "--with", "--python", "--index", "--index-url"]) : runnerValues)); continue;
    }
    if (["pnpm", "npm"].includes(program)) {
      const index = skipOptions(args, 1, packageValues);
      if (args[index] === "exec" || (program === "pnpm" && args[index] === "dlx")) {
        args = args.slice(skipOptions(args, index + 1, runnerValues)); continue;
      }
    }
    // The project's environment runs the command: `uv run pytest -q` is pytest.
    if (["uv", "poetry", "pipenv"].includes(program)) {
      const index = skipOptions(args, 1, envRunValues);
      if (args[index] === "run") { args = args.slice(skipOptions(args, index + 1, envRunValues)); continue; }
    }
    // `yarn workspace app test` is `yarn test` inside that workspace.
    if (program === "yarn") {
      const index = skipOptions(args, 1, packageValues);
      if (args[index] === "workspace" && args.length > index + 2) { args = [args[0]!, ...args.slice(index + 2)]; continue; }
    }
    return [args];
  }
  return args.length ? [args] : [];
}

function commandsFrom(input: string, depth = 0): string[][] {
  return simpleCommands(input).flatMap(words => unwrap(words, depth)).slice(0, MAX_COMMANDS);
}

function scriptKind(script: string): CheckKind | null {
  // Script variants such as test:unit count; ordinary filenames and arbitrary substrings do not.
  const name = script.toLowerCase().split(":", 1)[0];
  if (["test", "tests", "pytest", "jest", "vitest", "mocha", "rspec"].includes(name!)) return "test";
  if (["typecheck", "type-check", "check-types"].includes(name!)) return "typecheck";
  if (["lint", "eslint", "ruff", "flake8", "pylint", "clippy"].includes(name!)) return "lint";
  if (name === "build") return "build";
  return null;
}

const nodeValueOptions = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions",
  "--input-type", "--inspect-port", "--title", "--icu-data-dir", "--env-file", "--env-file-if-exists", "--tsconfig",
  "--test-reporter", "--test-reporter-destination", "--test-name-pattern", "--test-skip-pattern", "--test-concurrency", "--test-timeout"]);
function invokesNodeTests(args: readonly string[]): boolean {
  let found = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    // Node/tsx stop reading runtime options at the script name; later --test belongs to that script.
    if (arg === "--" || arg === "-" || !arg.startsWith("-")) break;
    if (["-e", "--eval", "-p", "--print", "-c", "--check", "-h", "-v"].includes(arg)
      || /^--(?:eval|print)=/.test(arg) || /^-[epc].+/.test(arg)) return false;
    if (arg === "--test" || arg.startsWith("--test=")) found = true;
    if (nodeValueOptions.has(arg)) index++;
  }
  return found;
}

/** GNU make options with a value, separate (`-C dir`) or attached (`-Cdir`, `--directory=dir`); `-O` takes only an attached one. */
const makeValues = new Set(["-C", "--directory", "-f", "--file", "--makefile", "-I", "--include-dir", "-o", "--old-file", "--assume-old",
  "-W", "--what-if", "--new-file", "--assume-new", "-E", "--eval", "-O"]);
/** Options whose value is optional: a separate one is taken only when it is a number (`-j 8`). */
const makeCounts = new Set(["-j", "--jobs", "-l", "--load-average", "--max-load"]);
/** Dry runs, queries, touch-only runs, help and version run no recipe. */
const makeNonRuns = new Set(["-n", "--just-print", "--dry-run", "--recon", "-q", "--question", "-t", "--touch", "-h", "--help", "-v", "--version"]);
/** check is GNU's test target and all its default build; test-unit, lint_go or build-image count by their first word. */
function makeTargetKind(target: string): CheckKind | null {
  const name = target.toLowerCase();
  return name === "check" ? "test" : name === "all" ? "build" : scriptKind(name.split(/[-_]/, 1)[0]!);
}
/** `make` by its targets (none is the default build), in the fixed category order; help, clean and dry runs are not checks. */
function makeKind(args: readonly string[]): CheckKind | null {
  const targets: string[] = [];
  const number = (value: string | undefined) => /^\d+(?:\.\d+)?$/.test(value ?? "");
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") { targets.push(...args.slice(index + 1).filter(value => !assignment.test(value))); break; }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("="), name = equals < 0 ? arg : arg.slice(0, equals);
      if (makeNonRuns.has(name)) return null;
      if (equals < 0 && (makeValues.has(name) || (makeCounts.has(name) && number(args[index + 1])))) index++;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      // Flags bundle (-kn); a value option ends the bundle and takes the rest, or the next word when it ends it.
      for (let short = 1; short < arg.length; short++) {
        const name = `-${arg[short]}`, last = short === arg.length - 1;
        if (makeNonRuns.has(name)) return null;
        if (makeValues.has(name)) { if (last && name !== "-O") index++; break; }
        if (makeCounts.has(name)) { if (last && number(args[index + 1])) index++; break; }
      }
      continue;
    }
    // VAR=value overrides a variable; it is not a target.
    if (!assignment.test(arg)) targets.push(arg);
  }
  if (!targets.length) return "build";
  const kinds = new Set(targets.map(makeTargetKind));
  return CHECK_ORDER.find(kind => kinds.has(kind)) ?? null;
}

function classify(words: string[]): CheckKind | null {
  let program = executable(words[0] ?? ""), args = words.slice(1);
  if (!program) return null;
  if (program === "python" || /^python\d(?:\.\d+)?$/.test(program)) {
    let moduleIndex = 0;
    while (moduleIndex < args.length && args[moduleIndex]!.startsWith("-") && args[moduleIndex] !== "-m") {
      if (["-c", "--"].includes(args[moduleIndex]!)) return null;
      moduleIndex += ["-W", "-X"].includes(args[moduleIndex]!) ? 2 : 1;
    }
    if (args[moduleIndex] !== "-m" || !args[moduleIndex + 1]) return null;
    program = args[moduleIndex + 1]!; args = args.slice(moduleIndex + 2);
  }
  if (args.includes("--help") || args.includes("--version")) return null;
  if (["npm", "pnpm", "yarn", "bun"].includes(program)) {
    const index = skipOptions(args, 0, packageValues);
    const action = args[index];
    if (!action) return program === "yarn" ? "install" : null;
    if (["ci", "install", "i", "add"].includes(action)) return "install";
    if (action === "run" || action === "run-script") return scriptKind(args[skipOptions(args, index + 1, packageValues)] ?? "");
    if (["exec", "dlx"].includes(action)) return null;
    return scriptKind(action);
  }
  // `test` is the shell's condition builtin (`test -f package.json`), like `[`: it checks a file or a variable, never runs tests.
  if (["pytest", "py.test", "jest", "vitest", "mocha", "rspec", "ctest", "tox", "nosetests"].includes(program)) return "test";
  if (program === "make" || program === "gmake") return makeKind(args);
  if (program === "playwright" && args[0] === "test") return "test";
  if (["tsx", "node"].includes(program) && invokesNodeTests(args)) return "test";
  if (program === "go" || program === "cargo") {
    const action = args[0]?.startsWith("+") ? args[1] : args[0];
    if (action === "test") return "test";
    if (action === "build") return "build";
    if (program === "cargo" && action === "clippy") return "lint";
    return null;
  }
  if (program === "tsc") return args.some(arg => arg === "-b" || arg === "--build" || arg.startsWith("--build=")) ? "build" : "typecheck";
  if (["typecheck", "type-check", "mypy", "pyright", "basedpyright"].includes(program)) return "typecheck";
  if (["lint", "eslint", "ruff", "flake8", "pylint", "golangci-lint", "clippy", "biome"].includes(program)) return "lint";
  if (program === "prettier" && args.some(arg => arg === "--check" || arg === "-c")) return "lint";
  if (["build", "cmake", "webpack", "esbuild", "gradle", "gradlew", "mvn", "mvnw"].includes(program)) return "build";
  if (program === "vite" && args[0] === "build") return "build";
  if (/^pip(?:\d(?:\.\d+)?)?$/.test(program) && args[0] === "install") return "install";
  if (program === "uv" && args[0] === "sync") return "install";
  if (program === "uv" && args[0] === "pip" && args[1] === "install") return "install";
  if (program === "poetry" && args[0] === "install") return "install";
  return null;
}

/** Keep option values and positional arguments out of dry-run/help detection; support short flag bundles. */
function optionFlags(args: readonly string[], withValue: ReadonlySet<string>): Set<string> {
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("="), name = equals < 0 ? arg : arg.slice(0, equals);
      flags.add(name); if (equals < 0 && withValue.has(name)) index++;
    } else if (arg.startsWith("-")) for (let short = 1; short < arg.length; short++) {
      const name = `-${arg[short]}`; flags.add(name);
      if (withValue.has(name)) { if (short === arg.length - 1) index++; break; }
    }
  }
  return flags;
}

function gitMilestone(words: string[]): string | null {
  const program = basename(words[0] ?? "");
  if (program === "git") {
    const index = skipOptions(words, 1, new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]));
    const valueOptions = words[index] === "commit" ? ["-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message",
      "--author", "--date", "--fixup", "--squash", "-t", "--template", "--trailer", "--pathspec-from-file"]
      : words[index] === "push" ? ["-o", "--push-option", "--receive-pack", "--exec", "--repo"]
      : ["-m", "--message", "-F", "--file", "-s", "--strategy", "-X", "--strategy-option", "--into-name"];
    const flags = optionFlags(words.slice(index + 1), new Set(valueOptions));
    if (flags.has("--dry-run") || flags.has("--help") || flags.has("-h")) return null;
    if (words[index] === "commit") return t("serverDigestCommands.m001");
    if (words[index] === "push" && !flags.has("-n")) return t("serverDigestCommands.m002");
    if (words[index] === "merge" && !flags.has("--abort") && !flags.has("--quit")) return t("serverDigestCommands.m003");
  }
  if (program === "gh") {
    const index = skipOptions(words, 1, new Set(["-R", "--repo", "--hostname"]));
    const flags = optionFlags(words.slice(index + 2), new Set(["-t", "--title", "-b", "--body", "-F", "--body-file", "-a", "--assignee", "-B", "--base",
      "-H", "--head", "-l", "--label", "-m", "--milestone", "-p", "--project", "-r", "--reviewer", "-T", "--template", "--subject", "--author-email", "--match-head-commit"]));
    if (flags.has("--dry-run") || flags.has("--help") || flags.has("-h")) return null;
    if (words[index] === "pr" && words[index + 1] === "create") return t("serverDigestCommands.m004");
    if (words[index] === "pr" && words[index + 1] === "merge") return t("serverDigestCommands.m005");
  }
  return null;
}

/** Classify one shell tool call; category priority is fixed even for compound commands. */
export function analyzeCommand(command: string): CommandAnalysis {
  const commands = commandsFrom(command);
  const kinds = new Set(commands.map(classify));
  return {
    // Scripts run by path group and display by their file name ("/tmp/tools/e2e.sh" → "e2e.sh").
    program: excerpt((commands[0]?.[0] ?? "").replace(/^.*\/(?=.)/s, "")),
    check: CHECK_ORDER.find(kind => kinds.has(kind)) ?? null,
    git: commands.map(gitMilestone).find(Boolean) ?? null,
  };
}
