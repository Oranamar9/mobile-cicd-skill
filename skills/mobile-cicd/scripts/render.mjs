#!/usr/bin/env node
// Renders the mobile-cicd templates for one app from its config (.github/mobile-cicd/config.json).
//
//   node render.mjs --root <app repo> [--config <file>] [--out <dir>] [--force]
//
// --config defaults to <root>/.github/mobile-cicd/config.json and --out to --root. A file that
// already exists and would change is left alone and listed (so you can show the user a diff)
// unless --force is given. Render to a scratch --out to compare before writing into the repo.
//
// Exit codes: 0 every file written or unchanged, 1 bad input, 3 some files were left alone.
//
// Template language (kept tiny on purpose):
//   @@path.to.value@@          the value, raw. Multi-line values are indented like the line.
//   @@json:path@@ / @@ruby:path@@ / @@sh:path@@ / @@shlist:path@@
//                              the value as a JSON / Ruby / single-quoted shell literal, or a
//                              shell array body ('a' 'b').
//   # @if <expr> / # @elif <expr> / # @else / # @endif   (also // or <!-- ... --> instead of #)
//                              keep or drop lines. <expr>: path, !path, path == word,
//                              path != word, joined by && and || (no parentheses).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = path.join(SKILL_DIR, 'templates');
const GENERATOR = 'mobile-cicd 0.1.0';

const FILES = [
  { template: 'workflows/ci.yml', output: '.github/workflows/ci.yml' },
  { template: 'workflows/security.yml', output: '.github/workflows/security.yml' },
  { template: 'workflows/mobile-release.yml', output: '.github/workflows/mobile-release.yml' },
  { template: 'fastlane/Fastfile', output: 'fastlane/Fastfile' },
  { template: 'fastlane/Appfile', output: 'fastlane/Appfile' },
  { template: 'Gemfile', output: 'Gemfile', gemfile: true },
  { template: 'mobile-cicd/set-versions.mjs', output: '.github/mobile-cicd/set-versions.mjs', mode: 0o755 },
  { template: 'mobile-cicd/check-store-access.mjs', output: '.github/mobile-cicd/check-store-access.mjs', mode: 0o755 },
  { template: 'mobile-cicd/setup-secrets.sh', output: '.github/mobile-cicd/setup-secrets.sh', mode: 0o755 },
  { template: 'mobile-cicd/README.md', output: '.github/mobile-cicd/README.md' },
];

const PACKAGE_MANAGERS = {
  npm: {
    install: 'npm ci',
    cache: 'npm',
    lockfile: 'package-lock.json',
    audit: 'npm audit --audit-level=high --omit=dev',
  },
  pnpm: {
    install: 'pnpm install --frozen-lockfile',
    cache: 'pnpm',
    lockfile: 'pnpm-lock.yaml',
    audit: 'pnpm audit --audit-level high --prod',
  },
  yarn: {
    install: 'yarn install --frozen-lockfile',
    cache: 'yarn',
    lockfile: 'yarn.lock',
    audit: 'yarn audit --level high --groups dependencies',
  },
  'yarn-berry': {
    install: 'yarn install --immutable',
    cache: 'yarn',
    lockfile: 'yarn.lock',
    audit: 'yarn npm audit --environment production --severity high --recursive',
  },
};

function parseArgs(argv) {
  const args = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--root' || a === '--config' || a === '--out') args[a.slice(2)] = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function get(obj, dotted) {
  return dotted.split('.').reduce((v, k) => (v == null ? undefined : v[k]), obj);
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function evalExpr(expr, vars, where) {
  const orParts = expr.split('||').map((s) => s.trim());
  return orParts.some((orPart) =>
    orPart.split('&&').map((s) => s.trim()).every((term) => {
      let m;
      if ((m = term.match(/^([\w.]+)\s*(==|!=)\s*([\w.-]+)$/))) {
        const equal = String(get(vars, m[1])) === m[3];
        return m[2] === '==' ? equal : !equal;
      }
      if ((m = term.match(/^(!?)([\w.]+)$/))) {
        const t = truthy(get(vars, m[2]));
        return m[1] ? !t : t;
      }
      throw new Error(`${where}: cannot read condition "${term}"`);
    }),
  );
}

function rubyLiteral(v) {
  return JSON.stringify(String(v)).replace(/#\{/g, '\\#{');
}

function shLiteral(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

function format(filter, value, where, name) {
  if (filter === 'json') return JSON.stringify(value ?? null);
  if (filter === 'shlist') {
    if (!Array.isArray(value)) throw new Error(`${where}: @@shlist:${name}@@ is not a list`);
    return value.map(shLiteral).join(' ');
  }
  if (value === undefined || value === null) throw new Error(`${where}: no value for @@${filter ? filter + ':' : ''}${name}@@`);
  if (filter === 'ruby') return rubyLiteral(value);
  if (filter === 'sh') return shLiteral(value);
  if (typeof value === 'object') throw new Error(`${where}: @@${name}@@ is an object; use @@json:${name}@@`);
  return String(value);
}

export function renderTemplate(text, vars, file = 'template') {
  const out = [];
  const stack = []; // { parentActive, taken, active }
  const active = () => (stack.length ? stack[stack.length - 1].active : true);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const where = `${file}:${i + 1}`;
    const d = line.match(/^\s*(?:#|\/\/|<!--)\s*@(if|elif|else|endif)\b\s*(.*?)\s*(?:-->)?\s*$/);
    if (d) {
      const [, kw, expr] = d;
      if (kw === 'if') {
        const parentActive = active();
        const val = parentActive && evalExpr(expr, vars, where);
        stack.push({ parentActive, taken: val, active: val });
      } else if (kw === 'elif' || kw === 'else') {
        const top = stack[stack.length - 1];
        if (!top) throw new Error(`${where}: @${kw} without @if`);
        const val = !top.taken && top.parentActive && (kw === 'else' || evalExpr(expr, vars, where));
        top.active = val;
        top.taken = top.taken || val;
      } else {
        if (!stack.pop()) throw new Error(`${where}: @endif without @if`);
      }
      return;
    }
    if (!active()) return;
    const indent = line.match(/^\s*/)[0];
    out.push(
      line.replace(/@@(?:(json|ruby|sh|shlist):)?([\w.]+)@@/g, (_, filter, name) => {
        const value = format(filter, get(vars, name), where, name);
        return value.includes('\n') ? value.split('\n').join(`\n${indent}`) : value;
      }),
    );
  });
  if (stack.length) throw new Error(`${file}: ${stack.length} @if block(s) not closed`);
  return out.join('\n');
}

export function validateConfig(c) {
  const errors = [];
  const need = (p, test = truthy, hint = 'is required') => {
    if (!test(get(c, p))) errors.push(`${p} ${hint}`);
  };
  need('framework', (v) => ['capacitor', 'expo', 'react-native'].includes(v), 'must be capacitor, expo or react-native');
  need('nativeProjects', (v) => ['committed', 'prebuild'].includes(v), 'must be committed or prebuild');
  need('packageManager', (v) => v in PACKAGE_MANAGERS, `must be one of ${Object.keys(PACKAGE_MANAGERS).join(', ')}`);
  for (const p of ['nodeVersion', 'javaVersion', 'rubyVersion']) need(p);
  need('ios.bundleId', (v) => /^[A-Za-z0-9.-]+$/.test(v ?? ''), 'must be a bundle ID like com.example.app');
  need('ios.teamId', (v) => /^[A-Z0-9]{10}$/.test(v ?? ''), 'must be the 10-character Apple Team ID');
  for (const p of ['ios.xcodeproj', 'ios.scheme', 'ios.target', 'ios.infoPlist']) need(p);
  need('android.packageName', (v) => /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(v ?? ''), 'must be a package name like com.example.app');
  for (const p of ['android.dir', 'android.appGradle', 'android.aab']) need(p);
  if (c.framework === 'capacitor') need('web.buildCommand', truthy, 'is required for Capacitor (the web build before cap sync)');
  need('release.androidRollout', (v) => typeof v === 'number' && v > 0 && v <= 1, 'must be a number above 0 and at most 1');
  for (const p of ['release.iosSubmitForReview', 'release.iosAutomaticRelease', 'release.iosUsesNonExemptEncryption'])
    need(p, (v) => typeof v === 'boolean', 'must be true or false');
  need('release.defaultNotes');
  if (c.env) {
    need('env.secret', (v) => /^[A-Z][A-Z0-9_]*$/.test(v ?? ''), 'must be a secret name in CAPS');
    need('env.file');
    need('env.required', Array.isArray, 'must be a list (can be empty)');
  }
  return errors;
}

export function deriveVars(c) {
  const pm = { ...PACKAGE_MANAGERS[c.packageManager] };
  if (c.installCommand) pm.install = c.installCommand;
  const rollout = c.release.androidRollout;
  return {
    ...c,
    generator: GENERATOR,
    pm,
    isPnpm: c.packageManager === 'pnpm',
    isYarnBerry: c.packageManager === 'yarn-berry',
    pnpmVersion: c.pnpmVersion ?? null,
    isCapacitor: c.framework === 'capacitor',
    isPrebuild: c.nativeProjects === 'prebuild',
    isReactNative: c.framework !== 'capacitor',
    ci: c.ci ?? {},
    hooks: c.hooks ?? {},
    web: c.web ?? {},
    ios: { ...c.ios, workspace: c.ios.workspace ?? '', podInstall: c.ios.podInstall ?? null },
    android: { ...c.android, reactNativeArchitectures: c.android.reactNativeArchitectures ?? null },
    envSecret: c.env?.secret ?? '',
    envFile: c.env?.file ?? '',
    envRequired: c.env?.required ?? [],
    firebaseIos: c.firebase?.ios?.path ?? '',
    firebaseAndroid: c.firebase?.android?.path ?? '',
    release: {
      ...c.release,
      androidRolloutText: Number.isInteger(rollout) ? rollout.toFixed(1) : String(rollout),
      iosSubmitForReviewText: String(c.release.iosSubmitForReview),
      iosAutomaticReleaseText: String(c.release.iosAutomaticRelease),
    },
    versionTargets: {
      framework: c.framework,
      nativeProjects: c.nativeProjects,
      appJson: c.expo?.appJson ?? 'app.json',
      xcodeproj: c.ios.xcodeproj,
      infoPlist: c.ios.infoPlist,
      appGradle: c.android.appGradle,
    },
  };
}

// A project that runs `prettier --check .` (directly or through eslint-plugin-prettier) would
// fail on the generated files, which follow their own formatting. They are re-rendered rather
// than hand-edited, so they go in .prettierignore, in a block of their own.
const PRETTIER_BLOCK_START = '# mobile-cicd: generated files, re-rendered from .github/mobile-cicd/config.json';
const PRETTIER_BLOCK = [
  PRETTIER_BLOCK_START,
  '.github/workflows/ci.yml',
  '.github/workflows/security.yml',
  '.github/workflows/mobile-release.yml',
  '.github/mobile-cicd/',
  '# end mobile-cicd',
].join('\n');

function usesPrettier(root) {
  const pkgPath = path.join(root, 'package.json');
  const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.prettier || pkg.prettier) return true;
  return fs.readdirSync(root).some((f) => /^\.prettier(rc|ignore)|^prettier\.config\./.test(f));
}

function ensurePrettierIgnore(root, out) {
  if (!usesPrettier(root)) return null;
  const file = '.prettierignore';
  const source = [path.join(out, file), path.join(root, file)].find((f) => fs.existsSync(f));
  const existing = source ? fs.readFileSync(source, 'utf8') : '';
  if (existing.includes(PRETTIER_BLOCK_START)) return { status: 'unchanged', file };
  const text = `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${existing ? '\n' : ''}${PRETTIER_BLOCK}\n`;
  fs.writeFileSync(path.join(out, file), text);
  return { status: existing ? 'appended' : 'created', file, note: 'generated files kept out of Prettier' };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.root) {
    console.log('Usage: node render.mjs --root <app repo> [--config <file>] [--out <dir>] [--force]');
    process.exit(args.help ? 0 : 1);
  }
  const root = path.resolve(args.root);
  const configPath = path.resolve(args.config ?? path.join(root, '.github/mobile-cicd/config.json'));
  const out = path.resolve(args.out ?? root);
  if (!fs.existsSync(configPath)) {
    console.error(`No config at ${configPath}. Run detect.mjs --write first.`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const errors = validateConfig(config);
  if (errors.length) {
    console.error(`Fix these in ${configPath}:\n  - ${errors.join('\n  - ')}`);
    process.exit(1);
  }
  const vars = deriveVars(config);

  const results = [];
  for (const f of FILES) {
    const target = path.join(out, f.output);
    const inRepo = path.join(root, f.output);
    if (f.gemfile && fs.existsSync(inRepo)) {
      const existing = fs.readFileSync(inRepo, 'utf8');
      results.push(
        /gem\s+["']fastlane["']/.test(existing)
          ? { status: 'kept', file: f.output, note: 'already has fastlane' }
          : { status: 'left', file: f.output, note: 'exists without fastlane: add  gem "fastlane", "~> 2.241"  to it' },
      );
      continue;
    }
    let text;
    try {
      text = renderTemplate(fs.readFileSync(path.join(TEMPLATES, f.template), 'utf8'), vars, f.template);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (existing === text) {
      results.push({ status: 'unchanged', file: f.output });
      continue;
    }
    if (existing !== null && !args.force) {
      results.push({ status: 'left', file: f.output, note: 'exists and differs (render to a scratch --out to diff, or --force)' });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, f.mode ? { mode: f.mode } : undefined);
    if (f.mode) fs.chmodSync(target, f.mode);
    results.push({ status: existing === null ? 'created' : 'replaced', file: f.output });
  }

  const prettier = ensurePrettierIgnore(root, out);
  if (prettier) results.push(prettier);

  for (const r of results) console.log(`${r.status.padEnd(10)}${r.file}${r.note ? `  (${r.note})` : ''}`);
  const left = results.filter((r) => r.status === 'left');
  process.exit(left.length ? 3 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
