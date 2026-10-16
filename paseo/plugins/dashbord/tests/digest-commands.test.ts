import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCommand } from "../server/digest/commands";
import type { CheckKind } from "../shared/digest";

test("command extraction unwraps environments, launchers and shell scripts", () => {
  const cases: [string, string][] = [
    ["  FOO=bar BAR='two words' pytest -q", "pytest"],
    ["cd '/work/a b' && npm test", "npm"],
    ["cd /work; cd subdir && env CI=1 npm test", "npm"],
    ["sudo -u somebody -E -- timeout -k 2s --signal TERM 5m time -p env -u FOO X=1 pytest", "pytest"],
    ["/usr/bin/time -f '%e' /usr/bin/env --chdir /work CI=1 npx --yes vitest", "vitest"],
    ["npx --package tsx tsx --test a.test.ts", "tsx"],
    ["pnpm dlx --package typescript tsc --noEmit", "tsc"],
    ["pnpm exec tsc --noEmit", "tsc"],
    ["pnpm -C /work dlx tsx --test tests", "tsx"],
    ["npm exec -- tsc --noEmit", "tsc"],
    ["npx -c 'npm test'", "npm"],
    ["bunx --yes eslint .", "eslint"],
    ["uvx --from ruff --python 3.12 ruff check .", "ruff"],
    ['bash -lc "cd /work && npm test"', "npm"],
    ["sh -c 'env CI=1 bash -lc \"npx vitest run\"'", "vitest"],
    ["env -S 'pytest -q'", "pytest"],
    ["env --split-string='pytest -q'", "pytest"],
    ["command -- pytest", "pytest"],
    ["exec -a custom pytest", "pytest"],
    ["nohup pytest >run.log 2>&1 &", "pytest"],
    ["/opt/bin/pytest -q", "pytest"],
    ["/tmp/paseo-e2e/e2e.sh start x 1", "e2e.sh"],
    ["2>/dev/null pytest", "pytest"],
    ["'pytest' -q", "pytest"],
    ["FOO=1", ""],
    ["cd /work", ""],
    ["", ""],
  ];
  for (const [command, program] of cases) assert.equal(analyzeCommand(command).program, program);
});

test("check classification covers the contract's executable and package-script tables", () => {
  const cases: [string, CheckKind][] = [
    ...["pytest -q", "jest", "vitest run", "mocha", "playwright test", "go test ./...", "cargo test", "cargo +nightly test", "tsx --test file.test.ts", "node --test", "node --test=path", "rspec", "ctest", "python3 -m pytest", "npm test", "npm run test:unit", "pnpm --filter app test", "yarn test", "bun test"].map(command => [command, "test"] as [string, CheckKind]),
    ...["tsc --noEmit", "typecheck", "mypy .", "pyright", "npm run typecheck", "pnpm typecheck", "yarn run type-check", "npx tsc --noEmit"].map(command => [command, "typecheck"] as [string, CheckKind]),
    ...["lint", "eslint .", "ruff check .", "flake8", "pylint .", "golangci-lint run", "clippy", "cargo clippy", "prettier --check .", "biome check .", "npm run lint", "pnpm lint:fix", "python -m ruff check ."].map(command => [command, "lint"] as [string, CheckKind]),
    ...["build", "make", "cmake --build .", "cargo build", "go build", "vite build", "webpack", "esbuild app.ts", "tsc -b", "tsc --build", "gradle assemble", "./gradlew build", "mvn package", "npm run build", "pnpm build"].map(command => [command, "build"] as [string, CheckKind]),
    ...["npm ci", "npm install", "npm i", "pnpm install", "yarn", "yarn --immutable", "pip install package", "pip3 install package", "python3 -m pip install package", "uv sync", "uv pip install package", "poetry install"].map(command => [command, "install"] as [string, CheckKind]),
  ];
  for (const [command, check] of cases) assert.equal(analyzeCommand(command).check, check);
  assert.equal(analyzeCommand("npx vitest@latest run").check, "test");
  assert.equal(analyzeCommand("npx @biomejs/biome@2 check .").check, "lint");
  assert.equal(analyzeCommand("npm run --if-present test").check, "test");
});

test("compound commands select the first CHECK_KINDS category", () => {
  assert.equal(analyzeCommand("npm run build && npm run lint && npm test").check, "test");
  assert.equal(analyzeCommand("npm install; tsc --noEmit && eslint .").check, "typecheck");
  assert.equal(analyzeCommand("npm run build | tee output").program, "npm");
  assert.equal(analyzeCommand("echo ready && npm test").check, "test");
  assert.equal(analyzeCommand("(npm test) && npm run build").check, "test");
  // The `test` builtin only guards the real step.
  assert.equal(analyzeCommand("if test -f package.json; then npm run build; fi").check, "build");
});

test("the shell's test builtin is a condition, like [, never a test run (opus-F75)", () => {
  for (const command of ["test -f package.json && cat package.json", 'test -n "$CI" && echo ci', "test -e dist/index.js; echo $?", "test -d node_modules",
    "/usr/bin/test -f x", "! test -f x", "[ -f package.json ] && cat package.json"]) assert.equal(analyzeCommand(command).check, null, command);
  assert.equal(analyzeCommand("test -f x || npm ci").check, "install");
  assert.equal(analyzeCommand("test -d node_modules || npm ci").check, "install");
  assert.equal(analyzeCommand("if test -f tsconfig.json; then npx tsc --noEmit; fi").check, "typecheck");
  assert.equal(analyzeCommand("test -f pytest.ini && pytest -q").check, "test");
});

test("make counts by its targets: test/check, lint, the default build; help, clean, install and dry runs are no check (opus-F75)", () => {
  const cases: [string, CheckKind | null][] = [
    ["make", "build"], ["make all", "build"], ["make build", "build"], ["gmake", "build"], ["/usr/bin/make -f Makefile.ci", "build"],
    ["make test", "test"], ["make check", "test"], ["make tests", "test"], ["make test-unit", "test"], ["make -C sub check", "test"], ["make --directory=sub test", "test"],
    ["make lint", "lint"], ["make lint_go", "lint"], ["make typecheck", "typecheck"], ["make build-image", "build"],
    ["make help", null], ["make clean", null], ["make install", null], ["make dist", null], ["make check-format", null],
    // Option values and variable assignments are not targets.
    ["make -j 8", "build"], ["make -j8 test", "test"], ["make -sj 4 check", "test"], ["make --jobs 4 lint", "lint"], ["make -Oline test", "test"], ["make V=1 test", "test"], ["make -f test.mk", "build"],
    ["make -C test", "build"], ["make -I test help", null],
    // Several targets: the fixed category order, as for a compound command.
    ["make clean test", "test"], ["make clean all", "build"], ["make help clean", null],
    // Dry runs, queries, touch-only runs, help and version execute nothing; GNU make reads options after targets too.
    ["make -n test", null], ["make test -n", null], ["make --dry-run", null], ["make --just-print build", null], ["make -q all", null], ["make --question", null],
    ["make -t", null], ["make -kn", null], ["make -h", null], ["make --help", null], ["make -v", null], ["make --version", null],
    ["cd sub && make test", "test"], ["make clean && make test", "test"], ["make help || true", null],
  ];
  for (const [command, check] of cases) assert.equal(analyzeCommand(command).check, check, command);
});

test("project runners and workspaces unwrap to the command they run (opus-F75)", () => {
  const cases: [string, CheckKind | null, string][] = [
    ["uv run pytest -q", "test", "pytest"], ["uv run --with pytest-cov --python 3.12 pytest", "test", "pytest"], ["uv --directory sub run pytest", "test", "pytest"],
    ["uv run python -m pytest", "test", "python"], ["uv run -- mypy .", "typecheck", "mypy"], ["uv run ruff check .", "lint", "ruff"],
    ["poetry run pytest", "test", "pytest"], ["poetry -C sub run mypy src", "typecheck", "mypy"], ["pipenv run pytest", "test", "pytest"], ["pipenv run python -m pytest", "test", "python"],
    ["yarn workspace app test", "test", "yarn"], ["yarn workspace app run build", "build", "yarn"], ["yarn workspace app add lodash", "install", "yarn"], ["yarn workspace app lint", "lint", "yarn"],
    ["uv sync", "install", "uv"], ["uv run app.py", null, "app.py"], ["poetry show", null, "poetry"], ["yarn workspace app", null, "yarn"], ["yarn workspaces list", null, "yarn"],
  ];
  for (const [command, check, program] of cases) assert.deepEqual([analyzeCommand(command).check, analyzeCommand(command).program], [check, program], command);
});

test("non-runs, quoted data, comments, substitutions and heredocs do not become checks", () => {
  const cases = [
    "grep test file", "rg 'npm test' .", "cat tests/test.ts", "ls test", "echo pytest", "printf '%s' 'npm test && eslint .'",
    'echo "npm test; tsc --noEmit"', "node -e 'console.log(\"npm test\")'", "python -c 'print(\"pytest\")'",
    "npm run contest", "npm view test", "npm run build-not-really", "git show HEAD:test.ts", "playwright install",
    "go version", "cargo fmt", "prettier --write .", "tsc --help", "pytest --version", "command -v pytest",
    "# npm test\necho done", "echo done # npm test", "echo $(printf 'a'; npm test)", "echo `npm test`",
    "cat <<'EOF'\nnpm test\nEOF\nls", "cat <<-EOF\n\tnpm test\n\tEOF\nls", "cat <<< 'npm test'", "cat <<EOF\nnpm test",
    "verify() { npm test; }", "function verify { npm test; }", "function verify() { npm test; }", "bash -lc 'echo \"npm test\"'",
    "python -c 'pass' -m pytest", "python script.py -m pytest", "npm test --help",
  ];
  for (const command of cases) assert.equal(analyzeCommand(command).check, null);
  assert.equal(analyzeCommand("cat <<EOF\necho ignored\nEOF\nnpm test").check, "test");
  assert.equal(analyzeCommand("cat <<ONE <<TWO\nnpm test\nONE\neslint .\nTWO\nls").check, null);
});

test("shell predicates keep quoted executable names and internal operators as data", () => {
  const cases = [
    '[[ -n present && "pytest" ]] && echo ok',
    'if [[ -n present && "pytest" ]]; then echo ok; fi',
    '[[ "closed" == "]]" || "vitest" ]] && echo ok',
    'bash -lc \'[[ -n present && "pytest" ]] && echo ok\'',
  ];
  for (const command of cases) assert.equal(analyzeCommand(command).check, null, command);
  assert.equal(analyzeCommand('[[ -n present && "pytest" ]] && npm test').check, "test");
  assert.equal(analyzeCommand('if [[ "closed" == "]]" ]]; then tsc --noEmit; fi').check, "typecheck");
});

test("node and tsx only classify runtime --test flags, not script arguments or option values", () => {
  const negative = ["node app.js --test", "tsx app.ts --test", "node app.js --test=unit", "tsx watch app.ts --test",
    "node -- --test", "node --require --test app.js", "node -r --test app.js", "node --import=--test app.js",
    "node --test-name-pattern --test app.js", "node -e --test", "node --eval=code --test", "node --check --test app.js"];
  for (const command of negative) assert.equal(analyzeCommand(command).check, null, command);
  const positive = ["node --require setup.js --test tests", "node --test --import setup.js tests", "node -rsetup.js --test",
    "tsx --tsconfig tsconfig.json --test tests", "node --test-name-pattern smoke --test", "node --test=unit"];
  for (const command of positive) assert.equal(analyzeCommand(command).check, "test", command);
});

test("git milestones identify actual git and GitHub commands", () => {
  const cases: [string, string | null][] = [
    ["git commit -m message", "已提交代码"], ["git -C /work -c user.name=somebody commit -m message", "已提交代码"],
    ["git commit -n -m message", "已提交代码"],
    ["git push origin main", "已推送代码"], ["cd /work && git merge topic", "已合并代码"],
    ["gh pr create --title example", "已创建 PR"], ["gh --repo org/repo pr merge 1 --squash", "已合并 PR"],
    ["echo 'git commit'", null], ["git status", null], ["git commit --dry-run", null], ["git push -n", null], ["git merge --abort", null], ["gh pr create --dry-run", null],
  ];
  for (const [command, git] of cases) assert.equal(analyzeCommand(command).git, git);
});

test("git dry-run detection respects flag bundles, option values and command-specific -n", () => {
  const negative = ["git push -nv", "git push -vn origin main", "git commit -o --dry-run", "git merge --squash --help",
    "git merge --quit", "git push --dry-run", "gh pr create --title example --dry-run"];
  for (const command of negative) assert.equal(analyzeCommand(command).git, null, command);
  const positive = [["git commit -n -m message", "已提交代码"], ["git commit -am --dry-run", "已提交代码"],
    ["git commit --message=--help", "已提交代码"], ["git push -o --dry-run origin main", "已推送代码"],
    ["git push -- origin --help", "已推送代码"], ["gh pr create --title --dry-run", "已创建 PR"]] as const;
  for (const [command, git] of positive) assert.equal(analyzeCommand(command).git, git, command);
});

test("work and returned program are bounded for malformed and large commands", () => {
  const oversized = "x".repeat(100_000);
  assert.equal(analyzeCommand(oversized).program, "");
  assert.equal(analyzeCommand(`${"x".repeat(100)} arg`).program.length, 40);
  assert.equal(analyzeCommand("'a\nb' arg").program, "a b");
  assert.equal(analyzeCommand("echo 'unterminated npm test").check, null);
  assert.equal(analyzeCommand(`echo '${oversized}'; npm test`).check, null);
  assert.equal(analyzeCommand(`${"echo;".repeat(10_000)}npm test`).check, null);
  assert.equal(analyzeCommand("bash -c").check, null);
});
