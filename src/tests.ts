import { posix } from 'node:path';
import type { LangId, ProjectConfig } from './types.js';

export function isTestPath(path: string, lang: LangId): boolean {
  const base = posix.basename(path);
  const inTestDir = /(^|\/)(__tests__|__test__|tests?|specs?|testing)\//.test(path);
  const inSupportDir = /(^|\/)(fixtures?|__fixtures__|helpers?|utils?|support|mocks?|__mocks__|stubs?|data|snapshots?|__snapshots__)\//.test(path);
  if (inTestDir && inSupportDir) return false;
  switch (lang) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
      if (/\.stories\.[jt]sx?$/.test(base)) return false;
      return inTestDir;
    case 'python':
      if (/^test_.*\.py$|_test\.py$|^conftest\.py$/.test(base)) return true;
      return inTestDir && base !== '__init__.py' && /test/i.test(base);
    case 'php':
      if (/Test\.php$|\.pest\.php$/.test(base)) return true;
      if (/^(TestCase|Pest|bootstrap|CreatesApplication)\.php$/.test(base)) return false;
      return inTestDir && /Test/.test(base);
  }
}

/** Candidate test files for a source file based purely on naming conventions. */
export function nameMappedTests(sourcePath: string, lang: LangId, allTests: Iterable<string>): string[] {
  const base = posix.basename(sourcePath);
  const stem = base.replace(/\.[^.]+$/, '');
  const out: string[] = [];
  for (const t of allTests) {
    const tb = posix.basename(t);
    const ts = tb.replace(/\.[^.]+$/, '');
    let match = false;
    switch (lang) {
      case 'typescript':
      case 'tsx':
      case 'javascript':
        match = ts === `${stem}.test` || ts === `${stem}.spec` || (t.includes('__tests__/') && (ts === stem || ts === `${stem}.test`));
        break;
      case 'python':
        match = ts === `test_${stem}` || ts === `${stem}_test` || ts === `tests_${stem}`;
        break;
      case 'php':
        match = ts === `${stem}Test`;
        break;
    }
    if (match && t !== sourcePath) out.push(t);
  }
  return out;
}

export interface TestCommand {
  lang: 'js' | 'py' | 'php';
  runner: string;
  command: string;
  files: string[];
}

function pmExec(pm: ProjectConfig['packageManager']): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm exec';
    case 'yarn':
      return 'yarn';
    case 'bun':
      return 'bunx';
    default:
      return 'npx';
  }
}

function pyModule(path: string): string {
  return path.replace(/\.py$/, '').replace(/\/__init__$/, '').replace(/\//g, '.');
}

const q = (f: string) => (/[\s"'$`\\]/.test(f) ? `'${f.replace(/'/g, `'\\''`)}'` : f);

/** Build one shell command per language for the given test files. */
export function buildTestCommands(config: ProjectConfig, testFiles: string[]): TestCommand[] {
  const js = testFiles.filter((f) => /\.[cm]?[jt]sx?$/.test(f));
  const py = testFiles.filter((f) => f.endsWith('.py'));
  const php = testFiles.filter((f) => f.endsWith('.php'));
  const out: TestCommand[] = [];
  if (js.length) {
    const runner = config.runners.js ?? 'vitest';
    const x = pmExec(config.packageManager);
    const files = js.map(q).join(' ');
    const command =
      runner === 'vitest'
        ? `${x} vitest run ${files}`
        : runner === 'jest'
          ? `${x} jest ${files}`
          : runner === 'mocha'
            ? `${x} mocha ${files}`
            : runner === 'bun'
              ? `bun test ${files}`
              : `node --test ${files}`;
    out.push({ lang: 'js', runner, command, files: js });
  }
  if (py.length) {
    const runner = config.runners.py ?? 'pytest';
    const command = runner === 'pytest' ? `python -m pytest -q ${py.map(q).join(' ')}` : `python -m unittest ${py.map(pyModule).join(' ')}`;
    out.push({ lang: 'py', runner, command, files: py });
  }
  if (php.length) {
    const runner = config.runners.php ?? 'phpunit';
    const command = runner === 'pest' ? `vendor/bin/pest ${php.map(q).join(' ')}` : `vendor/bin/phpunit ${php.map(q).join(' ')}`;
    out.push({ lang: 'php', runner, command, files: php });
  }
  return out;
}
