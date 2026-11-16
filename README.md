# mobile-cicd

A [Claude](https://claude.com) skill that gives a mobile app complete CI/CD on GitHub Actions:
push a tag, and the app ships to the **App Store** and **Google Play**.

It detects how the app is built (Capacitor, Expo or React Native) and generates three workflows
plus the fastlane lanes behind them. Then it walks you through every store secret with a script
**you** run, so the values never pass through the chat.

```
push / PR to main      -> ci.yml        lint, types, tests, build
                       -> security.yml  Gitleaks (whole history), dependency audit, Semgrep
tag vX.Y.Z on main     -> mobile-release.yml
                            gate (tag on main, semver)
                            ci + security again
                            next build number = max(App Store, Google Play) + 1
                            iOS (macOS)  -> App Store Connect -> App Review
                            Android      -> Google Play production
```

## Install

As a Claude Code plugin:

```bash
/plugin marketplace add Oranamar9/mobile-cicd-skill
/plugin install mobile-cicd@mobile-cicd-skill
```

Or copy `skills/mobile-cicd/` into `~/.claude/skills/` (all your projects) or
`.claude/skills/` (one project). The skill folder also works anywhere that reads the open Agent
Skills format.

Then, in your app's repo, ask something like *"set up CI/CD for this app"* or *"automate our App
Store and Play releases"*.

## What you get

| File | Purpose |
| --- | --- |
| `.github/workflows/ci.yml` | Lint, format, types, tests, build. Your existing scripts are detected |
| `.github/workflows/security.yml` | Secret scanning, dependency audit, static analysis. Weekly too |
| `.github/workflows/mobile-release.yml` | Tag-driven production release for both stores |
| `fastlane/Fastfile`, `fastlane/Appfile`, `Gemfile` | Build, sign, upload, submit |
| `.github/mobile-cicd/config.json` | Every setting, to re-render from |
| `.github/mobile-cicd/setup-secrets.sh` | Sets the secrets, checking each one first |
| `.github/mobile-cicd/README.md` | How to release, the switches, troubleshooting |

Releasing afterwards:

```bash
git tag -a v1.2.3 -m "What's new in this version"   # the message becomes the App Store "What's New"
git push origin v1.2.3
```

## How it works

- **The stores are the source of truth for build numbers.** Each release asks App Store Connect
  and Google Play for the highest build number they've seen and adds one. Nothing is committed
  back, so it works with protected branches and two releases can never collide.
- **No signing config in your project.** iOS signs with a temporary keychain and manual signing
  applied at build time. Android gets the upload key through Gradle's `android.injected.signing.*`
  properties, and the bundle's signature is checked against the upload key before upload.
- **Cheap where it can be.** Native builds run only on release. The 5-30 minute wait for Apple's
  processing runs on Linux, not macOS.
- **Secrets are checked before they're stored.** `.p12` passwords, certificate expiry,
  provisioning profile vs bundle ID and certificate, keystore alias and password. It also makes a
  real API call to App Store Connect and Google Play with the keys you give it. Values go from
  files and hidden prompts to `gh secret set` over stdin. They're never printed, written to the
  repo, or put on a command line.
- **Production switches** at the top of `mobile-release.yml`: submit for review or upload only,
  go live on approval or by hand, Android staged rollout percentage.

## Supported

| Stack | Status |
| --- | --- |
| Capacitor (iOS + Android, CocoaPods or SPM) | Supported |
| Expo with `expo prebuild` (native folders generated in CI, no EAS needed) | Supported |
| Expo bare / React Native CLI (native folders committed) | Supported |
| npm, pnpm, Yarn classic, Yarn Berry | Supported |
| Flutter, native Swift / Kotlin | Planned |
| Monorepos (app not at the repo root), app extensions (widgets, notification services) | Not yet |

## Requirements

- A GitHub repo with Actions. macOS runner minutes count about 10x in private repos.
- Node.js 18+, git and the [GitHub CLI](https://cli.github.com) locally; macOS for the iOS
  secret checks.
- Apple Developer Program and Google Play developer accounts. One-time store setup is covered
  by the skill: app records, the first manual `.aab` upload, Google's closed-testing rule for
  new personal accounts.

## Repository layout

```
.claude-plugin/           plugin + marketplace manifests
skills/mobile-cicd/
  SKILL.md                what Claude follows
  scripts/detect.mjs      looks at the app, drafts config.json
  scripts/render.mjs      renders the templates from config.json
  templates/              workflows, fastlane, setup and version scripts
  references/             config fields, per-secret guides, store setup, troubleshooting
```

Try the scripts without Claude:

```bash
node skills/mobile-cicd/scripts/detect.mjs /path/to/app            # prints what it found
node skills/mobile-cicd/scripts/detect.mjs /path/to/app --write    # saves .github/mobile-cicd/config.json
node skills/mobile-cicd/scripts/render.mjs --root /path/to/app --out /tmp/preview
```

## Contributing

Issues and pull requests are welcome, especially Flutter and native support, app extension
signing, and reports from real releases. Please run `detect.mjs` and `render.mjs` against a
sample app and include what changed in the generated files.

## License

[MIT](LICENSE)
