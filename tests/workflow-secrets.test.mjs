// Renders the templates for many kinds of apps and checks that no store secret can reach
// dependency code, a command line or a log. Run: npm test  (or: node --test tests/*.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { renderTemplate, validateConfig, deriveVars } from '../skills/mobile-cicd/scripts/render.mjs';
import { checkWorkflow, parseYaml, STORE_SECRETS } from '../skills/mobile-cicd/templates/mobile-cicd/check-workflow-secrets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = path.join(ROOT, 'skills/mobile-cicd/templates');
const template = (f) => fs.readFileSync(path.join(TEMPLATES, f), 'utf8');

function config(over = {}) {
  const base = {
    framework: 'expo',
    nativeProjects: 'prebuild',
    packageManager: 'npm',
    nodeVersion: '22',
    javaVersion: '17',
    rubyVersion: '3.3',
    ci: { lint: 'npm run lint', format: null, typecheck: 'npx tsc --noEmit', test: 'npm test', build: null },
    hooks: { afterInstall: 'npm run build:plugins' },
    ios: {
      bundleId: 'com.example.app',
      teamId: 'ABCDE12345',
      xcodeproj: 'ios/App.xcodeproj',
      workspace: 'ios/App.xcworkspace',
      scheme: 'App',
      target: 'App',
      infoPlist: 'ios/App/Info.plist',
      podInstall: 'pod install',
    },
    android: {
      packageName: 'com.example.app',
      dir: 'android',
      appGradle: 'android/app/build.gradle',
      aab: 'android/app/build/outputs/bundle/release/app-release.aab',
      reactNativeArchitectures: 'arm64-v8a,armeabi-v7a',
    },
    env: { secret: 'ENV_PRODUCTION', file: '.env.production', required: ['EXPO_PUBLIC_API_URL'] },
    firebase: { ios: { path: 'ios/App/GoogleService-Info.plist' }, android: { path: 'android/app/google-services.json' } },
    release: {
      iosSubmitForReview: true,
      iosAutomaticRelease: true,
      iosUsesNonExemptEncryption: false,
      androidRollout: 1,
      defaultNotes: 'Bug fixes and improvements.',
    },
  };
  return { ...base, ...over };
}

const STACKS = [
  { framework: 'expo', nativeProjects: 'prebuild' },
  { framework: 'expo', nativeProjects: 'committed' },
  { framework: 'react-native', nativeProjects: 'committed' },
  {
    framework: 'capacitor',
    nativeProjects: 'committed',
    javaVersion: '21',
    web: { buildCommand: 'npm run build', webDir: 'dist' },
    ios: { ...config().ios, xcodeproj: 'ios/App/App.xcodeproj', workspace: null, podInstall: null },
    android: { ...config().android, reactNativeArchitectures: null },
  },
];
const VARIANTS = [];
for (const stack of STACKS) {
  for (const packageManager of ['npm', 'pnpm', 'yarn', 'yarn-berry']) {
    VARIANTS.push(config({ ...stack, packageManager, pnpmVersion: packageManager === 'pnpm' ? '9' : undefined }));
  }
  VARIANTS.push(config({ ...stack, env: null, firebase: null, hooks: {}, release: { ...config().release, androidRollout: 0.2 } }));
}

function render(file, c, text = template(file)) {
  assert.deepEqual(validateConfig(c), [], 'test config is valid');
  return renderTemplate(text, deriveVars(c), file);
}

const label = (c) => `${c.framework}/${c.nativeProjects}/${c.packageManager}${c.env ? '' : ' (no env, no firebase)'}`;

// ------------------------------------------------------------------ the generated workflows pass

for (const c of VARIANTS) {
  test(`generated workflows pass the secret check: ${label(c)}`, () => {
    for (const f of ['workflows/mobile-release.yml', 'workflows/ci.yml', 'workflows/security.yml']) {
      const findings = checkWorkflow(render(f, c), f);
      assert.deepEqual(findings, [], `${f}:\n${findings.map((x) => `  ${x.line} [${x.rule}] ${x.message}`).join('\n')}`);
    }
  });
}

// The same promises, checked directly on the rendered text rather than through the checker's rules.
for (const c of VARIANTS) {
  test(`build jobs get no store secret at all, and passwords never reach a command line: ${label(c)}`, () => {
    const text = render('workflows/mobile-release.yml', c);
    const jobs = parseYaml(text).value.jobs.value;
    const secretsIn = (node) => [...JSON.stringify(node).matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);

    assert.deepEqual(secretsIn(jobs['android-build']).filter((s) => STORE_SECRETS.includes(s)), []);

    // ios-build: store secrets only in "Prepare signing", which comes before any dependency code.
    const iosSteps = jobs['ios-build'].value.steps.value;
    const prepare = iosSteps.findIndex((s) => s.value.name?.value === 'Prepare signing');
    const firstNode = iosSteps.findIndex((s) => /setup-node|action-setup/.test(s.value.uses?.value ?? '') || /corepack/.test(s.value.run?.value ?? ''));
    assert.ok(prepare >= 0 && firstNode > prepare, 'Prepare signing runs before node is set up');
    iosSteps.forEach((s, i) => {
      if (i !== prepare) assert.deepEqual(secretsIn(s).filter((x) => STORE_SECRETS.includes(x)), [], `ios-build step ${i + 1}`);
    });

    for (const [id, job] of Object.entries(jobs)) {
      assert.deepEqual(secretsIn(job.value.env ?? {}), [], `${id} has no job-level secrets`);
    }
    assert.doesNotMatch(text, /\$\{?ANDROID_KEY(STORE)?_PASSWORD\}?"? *\\?$|="\$\{?ANDROID_KEY(STORE)?_PASSWORD/m);
    assert.doesNotMatch(text, /\$\{?IOS_DISTRIBUTION_CERTIFICATE_PASSWORD/);
    assert.match(text, /-storepass:env ANDROID_KEYSTORE_PASSWORD/);
  });
}

// ------------------------------------------------------------------ the checker catches mistakes

const good = render('workflows/mobile-release.yml', config());
const rulesFor = (text) => [...new Set(checkWorkflow(text).map((f) => f.rule))].sort();

test('0.1.0 (store secrets at job level, passwords as Gradle arguments) fails the check', () => {
  const old = render('workflows/mobile-release.yml', config(), fs.readFileSync(path.join(ROOT, 'tests/fixtures/mobile-release-0.1.0.yml'), 'utf8'));
  const rules = rulesFor(old);
  for (const r of ['job-env', 'after-deps', 'password-arg', 'unpinned']) assert.ok(rules.includes(r), `expected ${r}, got ${rules}`);
});

test('job-env: a store secret in a job-level env', () => {
  const bad = good.replace(
    /( {2}android-build:\n(?: {4}.*\n)*? {4}env:\n)/,
    '$1      GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: ${{ secrets.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON }}\n',
  );
  assert.notEqual(bad, good);
  assert.ok(rulesFor(bad).includes('job-env'));
});

test('inline-secret: ${{ secrets.X }} pasted into a run script', () => {
  const bad = good.replace('run: bundle exec fastlane android release', 'run: echo "${{ secrets.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON }}" > key.json');
  assert.deepEqual(rulesFor(bad), ['inline-secret']);
});

test('inline-secret: toJSON(secrets)', () => {
  const bad = good.replace('run: bundle exec fastlane android release', 'run: echo \'${{ toJSON(secrets) }}\' | wc -c');
  assert.ok(rulesFor(bad).includes('inline-secret'));
});

test('after-deps: a store secret on the step that runs the dependency install', () => {
  const bad = good.replace(
    /( {6}- name: Install dependencies\n)/,
    '$1        env:\n          ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}\n',
  );
  assert.ok(rulesFor(bad).includes('after-deps'));
});

test('after-deps: a store secret on a step after the dependency install', () => {
  const bad = good.replace(
    '      - name: Build and sign the .ipa\n        env:\n',
    '      - name: Build and sign the .ipa\n        env:\n          APP_STORE_CONNECT_API_KEY: ${{ secrets.APP_STORE_CONNECT_API_KEY }}\n',
  );
  assert.notEqual(bad, good);
  assert.ok(rulesFor(bad).includes('after-deps'));
});

test('after-deps: a store secret is fine in a job of its own', () => {
  assert.deepEqual(rulesFor(good), []);
  assert.match(good, /android-release:[\s\S]*ANDROID_KEYSTORE_PASSWORD: \$\{\{ secrets\.ANDROID_KEYSTORE_PASSWORD \}\}/);
});

test('password-arg: a password expanded into a Gradle property', () => {
  const bad = good.replace(
    '-storepass:env ANDROID_KEYSTORE_PASSWORD -keypass:env "$keypass_var"',
    '-storepass "$ANDROID_KEYSTORE_PASSWORD" -keypass:env "$keypass_var"',
  );
  assert.notEqual(bad, good);
  assert.deepEqual(rulesFor(bad), ['password-arg']);
});

test('password-arg: tests, assignments and printf pipes are allowed', () => {
  const script = [
    'if [[ -z "$ANDROID_KEYSTORE_PASSWORD" ]]; then exit 1; fi',
    'pw="${ANDROID_KEY_PASSWORD:-$ANDROID_KEYSTORE_PASSWORD}"',
    'printf \'%s\' "$ANDROID_KEYSTORE_PASSWORD" | wc -c',
  ].join('\n          ');
  const yml = `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          ${script}\n`;
  assert.deepEqual(checkWorkflow(yml), []);
});

test('xtrace: set -x in a step with secrets', () => {
  const bad = good.replace(
    '          for s in ANDROID_KEYSTORE ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS; do',
    '          set -x\n          for s in ANDROID_KEYSTORE ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS; do',
  );
  assert.deepEqual(rulesFor(bad), ['xtrace']);
});

test('unpinned: an action on a tag in a job with store secrets', () => {
  const bad = good.replace(
    /( {2}android-release:[\s\S]*?)uses: ruby\/setup-ruby@[0-9a-f]{40} # v[\d.]+/,
    '$1uses: ruby/setup-ruby@v1',
  );
  assert.notEqual(bad, good);
  assert.deepEqual(rulesFor(bad), ['unpinned']);
});

test('cache: bundler-cache in a job that runs dependency code', () => {
  const bad = good.replace(/( {2}ios-build:[\s\S]*?bundler-cache: )false/, '$1true');
  assert.notEqual(bad, good);
  assert.deepEqual(rulesFor(bad), ['cache']);
});

test('cache: a dependency cache restored before a store secret is used', () => {
  const bad = good.replace(
    /( {2}android-release:[\s\S]*?)( {6}- uses: actions\/setup-java)/,
    '$1      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0\n        with:\n          path: ~/.gradle/caches\n          key: gradle\n\n$2',
  );
  assert.notEqual(bad, good);
  assert.deepEqual(rulesFor(bad), ['cache']);
});

// ------------------------------------------------------------------ the YAML reader

test('the YAML reader understands the generated workflows', () => {
  const doc = parseYaml(good).value;
  assert.deepEqual(Object.keys(doc.jobs.value), [
    'gate', 'ci', 'security', 'resolve', 'ios-build', 'ios-upload', 'ios-submit', 'android-build', 'android-release',
  ]);
  const sign = doc.jobs.value['android-release'].value.steps.value.find((s) => s.value.name?.value === 'Sign the bundle with the upload key');
  assert.match(sign.value.run.value, /^for s in ANDROID_KEYSTORE/);
  assert.equal(doc.env.value.ANDROID_ROLLOUT.value, '1.0');
});

test('the YAML reader agrees with PyYAML, when Python has it', (t) => {
  try {
    execFileSync('python3', ['-c', 'import yaml'], { stdio: 'ignore' });
  } catch {
    t.skip('python3 with PyYAML not available');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-cicd-'));
  for (const c of VARIANTS) {
    for (const f of ['workflows/mobile-release.yml', 'workflows/ci.yml', 'workflows/security.yml']) {
      const text = render(f, c);
      const file = path.join(dir, 'w.yml');
      fs.writeFileSync(file, text);
      const py = JSON.parse(
        execFileSync('python3', ['-I', '-c', 'import json,sys,yaml; d=yaml.safe_load(open(sys.argv[1])); d["on"]=d.pop(True, d.get("on")); print(json.dumps(d, default=str))', file]),
      );
      const plain = (n) => (n.kind === 'map' ? Object.fromEntries(Object.entries(n.value).map(([k, v]) => [k, plain(v)])) : n.kind === 'seq' ? n.value.map(plain) : n.value);
      const ours = plain(parseYaml(text));
      // Compare the jobs (scalars as strings: PyYAML types numbers and booleans).
      const norm = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'number' || typeof x === 'boolean' ? String(x) : x)));
      const strip = (s) => (typeof s === 'string' ? s.replace(/\n$/, '') : s);
      const deep = (v) => (Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : strip(v));
      assert.deepEqual(deep(norm(ours.jobs)), deep(norm(py.jobs)), `${label(c)} ${f}`);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the other generated files

test('the generated Fastfile is valid Ruby, and setup-secrets.sh valid bash', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-cicd-'));
  const fastfile = path.join(dir, 'Fastfile');
  fs.writeFileSync(fastfile, render('fastlane/Fastfile', config()));
  const sh = path.join(dir, 'setup-secrets.sh');
  fs.writeFileSync(sh, render('mobile-cicd/setup-secrets.sh', config()));
  execFileSync('bash', ['-n', sh]);
  try {
    execFileSync('ruby', ['-c', fastfile], { stdio: 'pipe' });
  } catch (e) {
    if (e.code === 'ENOENT') t.skip('ruby not available');
    else throw new Error(String(e.stderr));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the build lane refuses to run with a store secret in its environment', () => {
  const fastfile = render('fastlane/Fastfile', config());
  assert.match(fastfile, /lane :build do\n\s+ensure_no_store_secrets!/);
  for (const s of STORE_SECRETS) assert.ok(fastfile.includes(s), `Fastfile STORE_SECRETS lists ${s}`);
});
