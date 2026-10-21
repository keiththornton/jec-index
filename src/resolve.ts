import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { FileEntry, LangId, ProjectConfig } from './types.js';

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

/**
 * Strip JSONC comments and trailing commas without touching string contents —
 * tsconfig files routinely contain both `/* comments *\/` and globs like "@/*".
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\') j++;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function readJson(path: string): any | undefined {
  try {
    return JSON.parse(stripJsonComments(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

/** Detects tsconfig paths, python roots, composer PSR-4, and test runners. */
export function loadProjectConfig(root: string, files: string[]): ProjectConfig {
  const config: ProjectConfig = { pythonRoots: [], psr4: {}, runners: {} };
  const fileSet = new Set(files);
  const hasDir = (d: string) => files.some((f) => f.startsWith(d + '/'));

  // --- TypeScript / JavaScript ---
  for (const name of ['tsconfig.json', 'jsconfig.json', 'tsconfig.base.json']) {
    const ts = readJson(join(root, name));
    const co = ts?.compilerOptions;
    if (co) {
      if (typeof co.baseUrl === 'string') config.tsBaseUrl = posix.normalize(co.baseUrl.replace(/\\/g, '/')).replace(/^\.\/?/, '');
      if (co.paths && typeof co.paths === 'object') config.tsPaths = co.paths;
      if (config.tsBaseUrl !== undefined || config.tsPaths) break;
    }
  }
  const pkg = readJson(join(root, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const testScript: string = pkg.scripts?.test ?? '';
    if (deps.vitest || /\bvitest\b/.test(testScript)) config.runners.js = 'vitest';
    else if (deps.jest || /\bjest\b/.test(testScript)) config.runners.js = 'jest';
    else if (deps.mocha || /\bmocha\b/.test(testScript)) config.runners.js = 'mocha';
    else if (/\bbun test\b/.test(testScript)) config.runners.js = 'bun';
    else if (/node\s+(--test|--experimental-test)/.test(testScript)) config.runners.js = 'node-test';
    if (typeof pkg.packageManager === 'string') {
      const pm = pkg.packageManager.split('@')[0];
      if (pm === 'pnpm' || pm === 'yarn' || pm === 'bun' || pm === 'npm') config.packageManager = pm;
    }
  }
  if (!config.packageManager) {
    if (existsSync(join(root, 'pnpm-lock.yaml'))) config.packageManager = 'pnpm';
    else if (existsSync(join(root, 'yarn.lock'))) config.packageManager = 'yarn';
    else if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) config.packageManager = 'bun';
    else if (existsSync(join(root, 'package-lock.json'))) config.packageManager = 'npm';
  }
  if (!config.runners.js && files.some((f) => /\.(test|spec)\.[tj]sx?$/.test(f))) {
    // No runner declared: only infer one that is actually installed. Guessing `node --test`
    // for a project that merely contains someone else's *.test.ts files produces commands that fail.
    if (existsSync(join(root, 'node_modules/vitest'))) config.runners.js = 'vitest';
    else if (existsSync(join(root, 'node_modules/jest'))) config.runners.js = 'jest';
    else if (existsSync(join(root, 'node_modules/mocha'))) config.runners.js = 'mocha';
  }

  // --- Python ---
  const roots = new Set<string>();
  if (files.some((f) => f.endsWith('.py'))) {
    roots.add('');
    for (const cand of ['src', 'lib', 'app', 'python', 'backend']) if (hasDir(cand)) roots.add(cand);
    for (const f of files) {
      const m = f.match(/^([^/]+)\/[^/]+\/__init__\.py$/);
      if (m) roots.add(m[1]);
    }
    config.pythonRoots = [...roots];
    const pyproject = existsSync(join(root, 'pyproject.toml')) ? readFileSync(join(root, 'pyproject.toml'), 'utf8') : '';
    const hasPytest =
      existsSync(join(root, 'pytest.ini')) ||
      existsSync(join(root, 'conftest.py')) ||
      /\[tool\.pytest/.test(pyproject) ||
      /pytest/.test(pyproject) ||
      files.some((f) => /(^|\/)conftest\.py$/.test(f));
    config.runners.py = hasPytest ? 'pytest' : 'unittest';
  }

  // --- PHP ---
  const composer = readJson(join(root, 'composer.json'));
  if (composer) {
    for (const section of ['autoload', 'autoload-dev']) {
      const psr4 = composer[section]?.['psr-4'];
      if (psr4 && typeof psr4 === 'object') {
        for (const [ns, dirs] of Object.entries(psr4)) {
          const list = (Array.isArray(dirs) ? dirs : [dirs]).map((d) => String(d).replace(/\\/g, '/').replace(/\/$/, ''));
          config.psr4[ns.replace(/\\$/, '')] = list;
        }
      }
    }
  }
  if (files.some((f) => f.endsWith('.php'))) {
    if (fileSet.has('tests/Pest.php') || composer?.['require-dev']?.['pestphp/pest']) config.runners.php = 'pest';
    else config.runners.php = 'phpunit';
  }

  return config;
}

export class Resolver {
  private readonly fileSet: Set<string>;
  private readonly phpClasses = new Map<string, string>();
  private readonly dirSet: Set<string>;

  constructor(
    private readonly config: ProjectConfig,
    files: Iterable<FileEntry>,
  ) {
    this.fileSet = new Set();
    this.dirSet = new Set();
    for (const f of files) {
      this.fileSet.add(f.path);
      let d = posix.dirname(f.path);
      while (d && d !== '.' && !this.dirSet.has(d)) {
        this.dirSet.add(d);
        d = posix.dirname(d);
      }
      if (f.lang === 'php') {
        for (const s of f.symbols) {
          if (s.parent) continue;
          if (s.kind === 'class' || s.kind === 'interface' || s.kind === 'trait' || s.kind === 'enum') {
            const fqcn = f.namespace ? `${f.namespace}\\${s.name}` : s.name;
            this.phpClasses.set(fqcn, f.path);
          }
        }
      }
    }
  }

  resolve(fromFile: string, lang: LangId, raw: string): string | undefined {
    switch (lang) {
      case 'typescript':
      case 'tsx':
      case 'javascript':
        return this.resolveJs(fromFile, raw);
      case 'python':
        return this.resolvePy(fromFile, raw);
      case 'php':
        return this.resolvePhp(fromFile, raw);
    }
  }

  private has(p: string): boolean {
    return this.fileSet.has(p);
  }

  private tryJsCandidates(base: string): string | undefined {
    const norm = posix.normalize(base);
    if (this.has(norm) && /\.[cm]?[jt]sx?$/.test(norm)) return norm;
    // Imports in ESM TS often say ./foo.js meaning ./foo.ts
    const stripped = norm.replace(/\.(m|c)?js$/, '').replace(/\.jsx$/, '');
    for (const ext of JS_EXTS) if (this.has(stripped + ext)) return stripped + ext;
    for (const ext of JS_EXTS) if (this.has(norm + ext)) return norm + ext;
    for (const ext of JS_EXTS) if (this.has(posix.join(norm, 'index' + ext))) return posix.join(norm, 'index' + ext);
    return undefined;
  }

  private resolveJs(fromFile: string, raw: string): string | undefined {
    if (raw.startsWith('.')) {
      return this.tryJsCandidates(posix.join(posix.dirname(fromFile), raw));
    }
    if (raw.startsWith('/')) return undefined; // absolute FS path: not ours
    // tsconfig paths
    const paths = this.config.tsPaths;
    const baseUrl = this.config.tsBaseUrl ?? '';
    if (paths) {
      for (const [pattern, targets] of Object.entries(paths)) {
        const star = pattern.indexOf('*');
        let rest: string | undefined;
        if (star < 0) {
          if (raw === pattern) rest = '';
        } else {
          const prefix = pattern.slice(0, star);
          const suffix = pattern.slice(star + 1);
          if (raw.startsWith(prefix) && raw.endsWith(suffix) && raw.length >= prefix.length + suffix.length) {
            rest = raw.slice(prefix.length, raw.length - suffix.length);
          }
        }
        if (rest === undefined) continue;
        for (const t of targets) {
          const target = t.replace('*', rest).replace(/^\.\//, '');
          const hit = this.tryJsCandidates(posix.join(baseUrl, target));
          if (hit) return hit;
        }
      }
    }
    if (this.config.tsBaseUrl !== undefined) {
      const hit = this.tryJsCandidates(posix.join(baseUrl, raw));
      if (hit) return hit;
    }
    // Common convention without tsconfig: "@/x" or "~/x" → src/x
    if (/^[@~]\//.test(raw)) {
      for (const base of ['src', '']) {
        const hit = this.tryJsCandidates(posix.join(base, raw.slice(2)));
        if (hit) return hit;
      }
    }
    return undefined;
  }

  private tryPyModule(base: string): string | undefined {
    const norm = posix.normalize(base);
    if (this.has(norm + '.py')) return norm + '.py';
    if (this.has(posix.join(norm, '__init__.py'))) return posix.join(norm, '__init__.py');
    if (this.has(norm + '.pyi')) return norm + '.pyi';
    return undefined;
  }

  private resolvePy(fromFile: string, raw: string): string | undefined {
    const m = raw.match(/^(\.*)(.*)$/);
    const dots = m?.[1].length ?? 0;
    const modulePath = (m?.[2] ?? '').replace(/\./g, '/');
    if (dots > 0) {
      let dir = posix.dirname(fromFile);
      for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
      if (dir === '.') dir = '';
      const base = modulePath ? posix.join(dir, modulePath) : dir;
      const hit = this.tryPyModule(base);
      if (hit) return hit;
      // `from . import x` – treat the package itself as the dependency
      if (!modulePath) return this.tryPyModule(dir);
      // `from .mod import name` where mod is a symbol in package __init__ – fall back to the package
      const parent = posix.dirname(base);
      return this.tryPyModule(parent === '.' ? '' : parent);
    }
    for (const root of this.config.pythonRoots) {
      let segs = modulePath.split('/');
      // try the full path, then drop trailing segments (they may be symbols, not modules)
      while (segs.length > 0) {
        const hit = this.tryPyModule(posix.join(root, ...segs));
        if (hit) return hit;
        segs = segs.slice(0, -1);
      }
    }
    return undefined;
  }

  private resolvePhp(fromFile: string, raw: string): string | undefined {
    if (raw.startsWith('__DIR__')) {
      const rel = raw.slice('__DIR__'.length);
      const p = posix.normalize(posix.join(posix.dirname(fromFile), rel));
      return this.has(p) ? p : undefined;
    }
    if (/\.php$/.test(raw)) {
      const rel = posix.normalize(posix.join(posix.dirname(fromFile), raw));
      if (this.has(rel)) return rel;
      const fromRoot = posix.normalize(raw.replace(/^\.\//, ''));
      return this.has(fromRoot) ? fromRoot : undefined;
    }
    const fqcn = raw.replace(/^\\/, '');
    const direct = this.phpClasses.get(fqcn);
    if (direct) return direct;
    // PSR-4 mapping
    let bestNs = '';
    for (const ns of Object.keys(this.config.psr4)) {
      if ((fqcn === ns || fqcn.startsWith(ns + '\\')) && ns.length > bestNs.length) bestNs = ns;
    }
    if (bestNs) {
      const rest = fqcn.slice(bestNs.length).replace(/^\\/, '').replace(/\\/g, '/');
      for (const dir of this.config.psr4[bestNs]) {
        const p = posix.normalize(posix.join(dir, rest + '.php'));
        if (this.has(p)) return p;
      }
    }
    return undefined;
  }
}

