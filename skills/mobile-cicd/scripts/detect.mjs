#!/usr/bin/env node
// Looks at a mobile app's repo and prints a draft mobile-cicd config for it, with notes.
//
//   node detect.mjs [app repo] [--write] [--force]
//
// Prints JSON: { supported, summary, config, notes: { warnings, questions }, existing }.
// --write also saves `config` to <repo>/.github/mobile-cicd/config.json (an existing one is kept
// unless --force). Nothing else is written. Exit codes: 0 supported, 2 unsupported, 1 error.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const root = path.resolve(args.find((a) => !a.startsWith('--')) ?? '.');
const warnings = [];
const questions = [];

const p = (...parts) => path.join(root, ...parts);
const exists = (rel) => fs.existsSync(p(rel));
const read = (rel) => {
  try {
    return fs.readFileSync(p(rel), 'utf8');
  } catch {
    return null;
  }
};
const readJson = (rel) => {
  const t = read(rel);
  if (t == null) return null;
  try {
    return JSON.parse(t);
  } catch {
    warnings.push(`${rel} is not valid JSON; it was skipped.`);
    return null;
  }
};
const firstExisting = (...rels) => rels.find((r) => r && exists(r)) ?? null;
const git = (...a) => {
  try {
    return execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};
const insideGit = git('rev-parse', '--is-inside-work-tree') === 'true';
const tracked = (rel) => (insideGit ? (git('ls-files', '--', rel) ?? '') !== '' : null);
// A file that exists here but is not committed has to reach CI some other way (a secret).
const needsSecret = (rel) => exists(rel) && tracked(rel) === false;

function done(result, code) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(code);
}

function unsupported(framework, why) {
  done({ supported: false, framework, notes: { warnings: [why, ...warnings], questions } }, 2);
}

// ---------------------------------------------------------------- stack
const pkg = readJson('package.json');
if (!pkg) {
  if (exists('pubspec.yaml')) unsupported('flutter', 'Flutter is not supported yet (planned). Only Capacitor and Expo / React Native apps for now.');
  const ls = fs.existsSync(root) ? fs.readdirSync(root) : [];
  if (ls.some((f) => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace')) || ls.includes('settings.gradle') || ls.includes('settings.gradle.kts'))
    unsupported('native', 'Native iOS / Android projects are not supported yet (planned). Only Capacitor and Expo / React Native apps for now.');
  unsupported('unknown', `No package.json in ${root}. Run this from the app's repo root.`);
}
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const major = (v) => Number(String(v ?? '').match(/\d+/)?.[0] ?? NaN);

let framework;
let nativeProjects = 'committed';
if (deps['@capacitor/core'] || deps['@capacitor/ios'] || deps['@capacitor/android']) {
  framework = 'capacitor';
} else if (deps.expo) {
  framework = 'expo';
  const committed = insideGit ? tracked('ios') || tracked('android') : exists('ios') && !/^\/?(ios|android)\/?$/m.test(read('.gitignore') ?? '');
  nativeProjects = committed ? 'committed' : 'prebuild';
} else if (deps['react-native']) {
  framework = 'react-native';
} else if (deps['cordova-android'] || deps['cordova-ios'] || exists('config.xml')) {
  unsupported('cordova', 'Cordova is not supported. Capacitor and Expo / React Native only.');
} else {
  unsupported('unknown', 'package.json has no Capacitor, Expo or React Native dependency. Is this the mobile app?');
}

const top = git('rev-parse', '--show-toplevel');
if (top && path.resolve(top) !== root) {
  warnings.push(`This folder is not the git repo root (${top}). The workflows must live at the repo root and monorepos are not supported yet: the app has to be the repo.`);
}

// ---------------------------------------------------------------- package manager, Node
let packageManager = 'npm';
let installCommand;
let pnpmVersion;
if (exists('pnpm-lock.yaml')) {
  packageManager = 'pnpm';
  if (!String(pkg.packageManager ?? '').startsWith('pnpm@')) {
    const lockVersion = major((read('pnpm-lock.yaml') ?? '').match(/lockfileVersion:\s*'?([\d.]+)/)?.[1]);
    pnpmVersion = lockVersion >= 9 ? '9' : '8';
  }
} else if (exists('yarn.lock')) {
  packageManager = exists('.yarnrc.yml') || /^yarn@[2-9]/.test(pkg.packageManager ?? '') ? 'yarn-berry' : 'yarn';
} else if (exists('package-lock.json')) {
  packageManager = 'npm';
} else {
  installCommand = 'npm install';
  warnings.push(
    exists('bun.lockb') || exists('bun.lock')
      ? 'Bun is not supported yet: CI will use npm install (no lockfile). Consider committing a package-lock.json.'
      : 'No lockfile: CI uses `npm install`, so builds are not reproducible. Commit package-lock.json (or your package manager\'s lockfile).',
  );
}
const nodeFromFile = (read('.nvmrc') ?? read('.node-version') ?? '').trim().replace(/^v/, '');
const nodeVersion = nodeFromFile || (pkg.engines?.node ? String(major(pkg.engines.node)) : '22');

// ---------------------------------------------------------------- CI commands
const scripts = pkg.scripts ?? {};
const run = (s) => (packageManager === 'npm' ? `npm run ${s}` : packageManager === 'pnpm' ? `pnpm run ${s}` : `yarn ${s}`);
const exec = (cmd) => (packageManager === 'npm' ? `npx ${cmd}` : packageManager === 'pnpm' ? `pnpm exec ${cmd}` : `yarn ${cmd}`);
const firstScript = (...names) => names.find((n) => scripts[n]);

const ci = { lint: null, format: null, typecheck: null, test: null, build: null };
if (scripts.lint) ci.lint = run('lint');
const fmt = firstScript('format:check', 'check:format', 'prettier:check', 'format-check', 'lint:format', 'fmt:check');
if (fmt) ci.format = run(fmt);
const tc = firstScript('typecheck', 'type-check', 'check-types', 'types:check', 'check:types', 'tsc');
if (tc) ci.typecheck = run(tc);
else if (exists('tsconfig.json')) {
  ci.typecheck = exec('tsc --noEmit');
  questions.push('There is no typecheck script, so CI runs `tsc --noEmit`. Does the project type-check cleanly today? If not, drop ci.typecheck for now.');
}
if (scripts.test && !/no test specified/.test(scripts.test)) {
  ci.test = packageManager === 'npm' ? 'npm test' : packageManager === 'pnpm' ? 'pnpm test' : 'yarn test';
  if (/--watch\b(?!All=false)/.test(scripts.test)) warnings.push('The test script runs in watch mode; CI would hang. Point ci.test at a single-run command.');
}
if (!ci.lint && !ci.typecheck && !ci.test) warnings.push('No lint, typecheck or test script found: ci.yml will only install and build.');

let web;
if (framework === 'capacitor') {
  if (scripts.build) {
    ci.build = run('build');
    web = { buildCommand: run('build') };
  } else {
    web = { buildCommand: null };
    questions.push('Capacitor needs a web build before `cap sync`, but package.json has no build script. What command builds the web app?');
  }
}

// ---------------------------------------------------------------- iOS
const capConfigFile = firstExisting('capacitor.config.ts', 'capacitor.config.js', 'capacitor.config.mjs', 'capacitor.config.json');
const capConfig = capConfigFile ? read(capConfigFile) : '';
const capField = (re) => capConfig.match(re)?.[1] ?? null;
const appJson = framework === 'expo' ? readJson('app.json') : null;
const expo = appJson?.expo ?? appJson ?? {};
const appConfigFile = framework === 'expo' ? firstExisting('app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs') : null;

const iosDir = framework === 'capacitor' ? capField(/ios\s*:\s*\{[^}]*?path\s*:\s*['"`]([^'"`]+)/s) ?? 'ios' : 'ios';
const androidDir = framework === 'capacitor' ? capField(/android\s*:\s*\{[^}]*?path\s*:\s*['"`]([^'"`]+)/s) ?? 'android' : 'android';

function xcodeprojIn(dir) {
  try {
    return fs.readdirSync(p(dir)).filter((f) => f.endsWith('.xcodeproj') && f !== 'Pods.xcodeproj').sort()[0] ?? null;
  } catch {
    return null;
  }
}

let ios;
if (framework === 'capacitor') {
  const appDir = `${iosDir}/App`;
  ios = {
    xcodeproj: `${appDir}/App.xcodeproj`,
    workspace: exists(`${appDir}/App.xcworkspace`) || exists(`${appDir}/Podfile`) ? `${appDir}/App.xcworkspace` : null,
    scheme: 'App',
    target: 'App',
    infoPlist: `${appDir}/App/Info.plist`,
    podInstall: null, // cap sync installs the pods
  };
} else {
  let name = xcodeprojIn(iosDir)?.replace(/\.xcodeproj$/, '');
  if (!name) {
    name = String(expo.name ?? pkg.name ?? 'app').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\W_]+/g, '') || 'app';
    if (nativeProjects === 'prebuild') warnings.push(`ios/ is not generated here yet, so the Xcode project name "${name}" is inferred from the app name the way expo prebuild does it. Run \`npx expo prebuild -p ios\` once locally to confirm.`);
  }
  const hasPodfile = nativeProjects === 'prebuild' || exists(`${iosDir}/Podfile`);
  const gemfile = read('Gemfile') ?? '';
  ios = {
    xcodeproj: `${iosDir}/${name}.xcodeproj`,
    workspace: hasPodfile ? `${iosDir}/${name}.xcworkspace` : null,
    scheme: name,
    target: name,
    infoPlist: `${iosDir}/${name}/Info.plist`,
    podInstall: hasPodfile ? (/cocoapods/.test(gemfile) && nativeProjects === 'committed' ? 'bundle exec pod install' : 'pod install') : null,
  };
}

const pbxproj = read(`${ios.xcodeproj}/project.pbxproj`) ?? '';
const pbxBundleIds = [...pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/g)].map((m) => m[1]).filter((v) => !v.includes('$('));
const capAppId = capField(/appId\s*:\s*['"`]([^'"`]+)/) ?? capField(/"appId"\s*:\s*"([^"]+)"/);
const appConfigText = appConfigFile ? read(appConfigFile) : '';
let bundleId =
  framework === 'capacitor'
    ? capAppId ?? pbxBundleIds[0]
    : nativeProjects === 'prebuild'
      ? expo.ios?.bundleIdentifier ?? appConfigText.match(/bundleIdentifier\s*:\s*['"`]([^'"`]+)/)?.[1]
      : pbxBundleIds.sort((a, b) => a.length - b.length)[0] ?? expo.ios?.bundleIdentifier;
bundleId ??= null;
if (!bundleId) questions.push('What is the iOS bundle ID (as registered in App Store Connect)?');
if (bundleId && pbxBundleIds.length && !pbxBundleIds.includes(bundleId)) warnings.push(`The Xcode project uses ${pbxBundleIds.join(', ')}, not ${bundleId}. Check which one is the App Store app.`);

const teamId = pbxproj.match(/DEVELOPMENT_TEAM = "?([A-Z0-9]{10})"?;/)?.[1] ?? expo.ios?.appleTeamId ?? appConfigText.match(/appleTeamId\s*:\s*['"`]([A-Z0-9]{10})/)?.[1] ?? null;
if (!teamId) questions.push('What is the Apple Team ID (10 characters, Apple Developer -> Membership)?');

const extensions = (pbxproj.match(/productType = "com\.apple\.product-type\.(app-extension|extensionkit-extension|watchkit2-extension|application\.watchapp2)"/g) ?? []).length;
if (extensions) warnings.push(`The Xcode project has ${extensions} app extension target(s) (widget, notification service...). Each needs its own App Store profile, which this pipeline does not set up yet: signing will fail until that is added by hand in fastlane/Fastfile.`);

// Export compliance: without an answer, App Store Connect holds the build at "Missing Compliance".
let encryption = null;
if (nativeProjects === 'committed') {
  const plist = read(ios.infoPlist) ?? '';
  const m = plist.match(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<(true|false)\s*\/>/);
  if (m) encryption = m[1] === 'true';
} else {
  const v = expo.ios?.config?.usesNonExemptEncryption ?? expo.ios?.infoPlist?.ITSAppUsesNonExemptEncryption;
  if (typeof v === 'boolean') encryption = v;
}
if (encryption === null) {
  questions.push('Does the app use encryption beyond HTTPS and the standard OS APIs? Most apps do not (answer: no). The answer goes to App Store Connect with each submission; adding ITSAppUsesNonExemptEncryption to Info.plist (Expo: ios.config.usesNonExemptEncryption) also stops the "Missing Compliance" hold in TestFlight.');
}

// ---------------------------------------------------------------- Android
const appGradle = firstExisting(`${androidDir}/app/build.gradle`, `${androidDir}/app/build.gradle.kts`) ?? `${androidDir}/app/build.gradle`;
const gradleText = read(appGradle) ?? '';
const gradleAppId = gradleText.match(/applicationId\s*=?\s*["']([^"']+)["']/)?.[1];
let packageName =
  nativeProjects === 'prebuild'
    ? expo.android?.package ?? appConfigText.match(/package\s*:\s*['"`]([\w.]+)['"`]/)?.[1]
    : gradleAppId ?? (framework === 'capacitor' ? capAppId : expo.android?.package);
packageName ??= null;
if (!packageName) questions.push('What is the Android package name (applicationId, as in Play Console)?');
if (nativeProjects === 'committed' && gradleText && !/versionCode\s*=?\s*\d+/.test(gradleText)) {
  warnings.push(`${appGradle} has no literal versionCode (like \`versionCode 12\`): set-versions.mjs writes the build number there, so make it a plain number.`);
}
let javaVersion = '17';
if (framework === 'capacitor' && major(deps['@capacitor/android'] ?? deps['@capacitor/core']) >= 7) javaVersion = '21';
if (/VERSION_21|JvmTarget\.JVM_21|jvmToolchain\(21\)/.test(gradleText)) javaVersion = '21';

// ---------------------------------------------------------------- build-time environment
const SKIP_DIRS = new Set(['node_modules', '.git', 'ios', 'android', 'dist', 'build', 'www', '.expo', '.next', 'coverage', 'Pods', '.output', 'supabase']);
const envPattern = framework === 'capacitor' ? /(?:import\.meta\.env|process\.env)\.(VITE_[A-Z0-9_]+)/g : /process\.env\.(EXPO_PUBLIC_[A-Z0-9_]+)/g;
const envVars = new Set();
let scanned = 0;
(function walk(dir, depth) {
  if (depth > 8 || scanned > 6000) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
    } else if (/\.(m?[jt]sx?|cjs|vue|svelte)$/.test(e.name)) {
      scanned++;
      const st = fs.statSync(full);
      if (st.size > 1_000_000) continue;
      for (const m of fs.readFileSync(full, 'utf8').matchAll(envPattern)) envVars.add(m[1]);
    }
  }
})(root, 0);

let env = null;
const envFile = '.env.production';
if (tracked(envFile)) {
  warnings.push(`${envFile} is committed, so CI reads it from the repo and no secret is needed. Make sure it holds no secret values (only public client config).`);
} else if (envVars.size || exists(envFile)) {
  env = { secret: 'ENV_PRODUCTION', file: envFile, required: [...envVars].sort() };
  if (!exists(envFile)) questions.push(`The code reads ${[...envVars].slice(0, 4).join(', ')}${envVars.size > 4 ? '...' : ''} at build time, but there is no ${envFile} here. Where do the production values live? The setup script uploads that file as the ENV_PRODUCTION secret.`);
}

// ---------------------------------------------------------------- Firebase files
let fbIos = null;
let fbAndroid = null;
if (nativeProjects === 'prebuild') {
  const iosFile = expo.ios?.googleServicesFile;
  const androidFile = expo.android?.googleServicesFile;
  if (iosFile && tracked(iosFile.replace(/^\.\//, '')) !== true) fbIos = iosFile.replace(/^\.\//, '');
  if (androidFile && tracked(androidFile.replace(/^\.\//, '')) !== true) fbAndroid = androidFile.replace(/^\.\//, '');
  if (/googleServicesFile/.test(appConfigText) && !iosFile && !androidFile) warnings.push(`${appConfigFile} sets googleServicesFile in code. If that file is not committed, add firebase.ios / firebase.android to the config so CI writes it from a secret.`);
} else {
  const iosPlist = path.posix.join(path.posix.dirname(ios.infoPlist), 'GoogleService-Info.plist');
  const androidJson = `${androidDir}/app/google-services.json`;
  if (needsSecret(iosPlist) || (!exists(iosPlist) && pbxproj.includes('GoogleService-Info.plist'))) fbIos = iosPlist;
  if (needsSecret(androidJson)) fbAndroid = androidJson;
}

// ---------------------------------------------------------------- what is already there
const workflows = (() => {
  try {
    return fs.readdirSync(p('.github/workflows')).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return [];
  }
})();
const gemfileText = read('Gemfile');
const existing = {
  workflows,
  fastfile: exists('fastlane/Fastfile'),
  gemfile: gemfileText == null ? null : { hasFastlane: /gem\s+["']fastlane["']/.test(gemfileText), hasCocoapods: /cocoapods/.test(gemfileText) },
  gemfileLock: exists('Gemfile.lock'),
  config: exists('.github/mobile-cicd/config.json'),
};
for (const wf of ['ci.yml', 'security.yml', 'mobile-release.yml']) {
  if (workflows.includes(wf)) warnings.push(`.github/workflows/${wf} already exists: compare it with the generated one and keep project-specific jobs (render to a scratch --out and diff).`);
}
const otherReleaseFlows = workflows.filter((w) => /release|deploy|upload|store|testflight|play|internal|beta|mobile/i.test(w) && w !== 'mobile-release.yml');
if (otherReleaseFlows.length) warnings.push(`Other release workflows exist (${otherReleaseFlows.join(', ')}). Two pipelines uploading to the stores would fight over build numbers: decide with the user which one stays.`);
if (existing.fastfile) warnings.push('fastlane/Fastfile already exists: the generated one replaces its lanes. Diff first and carry over anything project-specific.');

// ---------------------------------------------------------------- result
const config = {
  configVersion: 1,
  framework,
  nativeProjects,
  packageManager,
  ...(installCommand ? { installCommand } : {}),
  ...(pnpmVersion ? { pnpmVersion } : {}),
  nodeVersion,
  javaVersion,
  rubyVersion: '3.3',
  ci,
  hooks: { afterInstall: null },
  ...(web ? { web } : {}),
  ...(framework === 'expo' && nativeProjects === 'prebuild' ? { expo: { appJson: 'app.json' } } : {}),
  ios: { bundleId, teamId, ...ios },
  android: {
    packageName,
    dir: androidDir,
    appGradle,
    aab: `${androidDir}/app/build/outputs/bundle/release/app-release.aab`,
    reactNativeArchitectures: null,
  },
  env,
  firebase: { ios: fbIos ? { path: fbIos } : null, android: fbAndroid ? { path: fbAndroid } : null },
  release: {
    iosSubmitForReview: true,
    iosAutomaticRelease: true,
    iosUsesNonExemptEncryption: encryption ?? false,
    androidRollout: 1.0,
    defaultNotes: 'Bug fixes and improvements.',
  },
};

if (framework === 'expo' && nativeProjects === 'prebuild') {
  if (!appJson) warnings.push('Expo prebuild projects need an app.json: set-versions.mjs writes the version and build number there before prebuild.');
  if (appConfigFile && /\b(version|buildNumber|versionCode)\s*:/.test(appConfigText)) {
    warnings.push(`${appConfigFile} sets version / buildNumber / versionCode itself. It must take them from app.json (the \`config\` argument) or the release build numbers will be ignored.`);
  }
}

const summary = {
  framework: `${framework}${framework === 'expo' ? ` (${nativeProjects === 'prebuild' ? 'prebuild: ios/ and android/ generated in CI' : 'native folders committed'})` : ''}`,
  packageManager,
  node: nodeVersion,
  java: javaVersion,
  iosBundleId: bundleId,
  appleTeamId: teamId,
  androidPackage: packageName,
  xcode: `${ios.workspace ?? ios.xcodeproj} (scheme ${ios.scheme})`,
  ciSteps: Object.entries(ci).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`),
  buildEnv: env ? `${env.file} -> secret ${env.secret} (${env.required.length} variables read in code)` : 'none',
  firebaseFromSecrets: [fbIos, fbAndroid].filter(Boolean),
};

const result = { supported: true, summary, config, notes: { warnings, questions }, existing };
if (flags.has('--write')) {
  const target = p('.github/mobile-cicd/config.json');
  if (fs.existsSync(target) && !flags.has('--force')) {
    warnings.push('.github/mobile-cicd/config.json already exists and was kept (use --force to replace it).');
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
    result.wrote = '.github/mobile-cicd/config.json';
  }
}
done(result, 0);
