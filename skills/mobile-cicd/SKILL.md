---
name: mobile-cicd
description: Sets up complete CI/CD on GitHub Actions for a mobile app built with Capacitor, Expo or React Native. Generates ci.yml (lint, types, tests, build), security.yml (Gitleaks, dependency audit, Semgrep) and mobile-release.yml, where pushing a vX.Y.Z tag on main builds, signs and ships the app to App Store and Google Play production through fastlane. Then walks the user through every store secret (App Store Connect API key, distribution certificate, provisioning profile, Android upload keystore, Play service account) with a script they run themselves, so the values never pass through the chat. Use it whenever someone wants CI, CD, a release pipeline, GitHub Actions, fastlane, automatic TestFlight / App Store / Google Play uploads, or help with signing and store secrets for a mobile app, even if they only mention one of these pieces.
license: MIT
compatibility: Needs Node.js 18+, git and the GitHub CLI (gh). The iOS secret checks need macOS. Generated workflows use GitHub-hosted macOS and Ubuntu runners.
---

# Mobile CI/CD

Turn a Capacitor or Expo / React Native app into one that releases itself: a tag on `main` ends
in both stores. Detection and rendering are done by bundled scripts, so the output is the same
every time. Your job is the judgment around them: confirming what was detected, merging with
what the project already has, and getting the secrets and store accounts ready.

`${CLAUDE_SKILL_DIR}` below is the folder that holds this file. If it is not substituted in
your environment, use that folder's path.

## What the app gets

| File | What it does |
| --- | --- |
| `.github/workflows/ci.yml` | Lint, format, types, tests, build on every push and PR to `main` |
| `.github/workflows/security.yml` | Gitleaks over the whole history, dependency audit, Semgrep; also weekly |
| `.github/workflows/mobile-release.yml` | On a `vX.Y.Z` tag that is on `main`: gate, CI and Security again, next build number, then iOS (macOS) and Android (Ubuntu) to production |
| `fastlane/Fastfile`, `fastlane/Appfile`, `Gemfile` | The build, sign, upload and submit lanes |
| `.github/mobile-cicd/config.json` | Every setting. The source for re-rendering |
| `.github/mobile-cicd/set-versions.mjs` | Writes the version and build number into the app during the build |
| `.github/mobile-cicd/setup-secrets.sh`, `check-store-access.mjs` | Sets and checks the secrets (the user runs it) |
| `.github/mobile-cicd/README.md` | How to release, the production switches, the one-time setup, fixes |

Design decisions already agreed for this pipeline. Explain them if asked, and don't "fix" them:

- **Every tag is a production release.** No internal or beta tracks. Native builds happen only
  here, because macOS minutes cost about ten times Linux minutes in private repos.
- **The build number is the highest one either store has seen, plus one.** Nothing is committed
  back to `main`, so it works with branch protection and never collides. The version comes from the tag.
- **iOS submit runs on a Linux job.** Waiting 5-30 minutes for Apple's processing on macOS
  would be expensive.
- **Android signing uses Gradle's `android.injected.signing.*` properties.** These are the ones
  Android Studio uses, so the project's build.gradle needs no signing config. The job checks the
  bundle's signature against the upload key before uploading.
- Switches at the top of `mobile-release.yml`: `IOS_SUBMIT_FOR_REVIEW`, `IOS_AUTOMATIC_RELEASE`,
  `ANDROID_ROLLOUT`.

## Ground rules

1. **Secret values never pass through you.** Don't ask for them. Don't read `.env*` files,
   keystores, `.p8`, `.p12` or service-account JSON. Don't put them on a command line. The user
   runs `setup-secrets.sh` in their own terminal, and it sends values from files and hidden
   prompts straight to `gh secret set`. Names are fine: `--check` lists names only, and you may
   run it. If the user pastes a secret anyway, don't repeat it or write it anywhere. Tell them it
   is now in the chat log and should be rotated, using the "Rotating" notes in
   [references/secrets.md](references/secrets.md).
2. **Don't overwrite what the project has.** Existing workflows often carry jobs the generic
   pipeline doesn't know about: database tests, edge functions, local plugin builds, store
   checks. Render to a scratch folder, diff, and merge with the user's OK.
3. **Committing, pushing, tagging and creating repos are the user's call.** Ask first. Pushing a
   tag is a production release in both stores.

## Workflow

### 1. Detect

```bash
node "${CLAUDE_SKILL_DIR}/scripts/detect.mjs" <repo root>
```

It prints `summary`, a draft `config`, `notes.warnings`, `notes.questions` and `existing`, and
writes nothing.

- **Exit code 2** means the stack is unsupported (Flutter, native, Cordova, not a mobile app).
  Say so plainly. Flutter and native are planned. Stop there.
- The app must be the repo root. Monorepos are not supported yet.
- If `existing.workflows` has CI or release workflows, read them now. Note anything
  project-specific that must survive.

### 2. Confirm with the user

Show a short table: framework, package manager, bundle ID, Team ID, package name, Xcode
scheme, CI steps, build env file and Firebase files. Then ask only what is open:

- every entry in `notes.questions`
- any warning that needs a decision, such as two release pipelines or app extensions
- the production defaults: submit for review, go live on approval, Android at 100%. Mention
  that each is a one-line switch later.

Keep it to one round of questions if you can.

### 3. Write the config

```bash
node "${CLAUDE_SKILL_DIR}/scripts/detect.mjs" <repo root> --write
```

Then edit `.github/mobile-cicd/config.json` with the answers. Every field is described in
[references/config.md](references/config.md). Things you'll often set by hand:

- `hooks.afterInstall` for build prerequisites, such as compiling local Capacitor plugins
- `ci.*` to point at the project's real commands
- `release.*` for the production switches
- `android.reactNativeArchitectures` to speed up React Native builds

### 4. Render

```bash
node "${CLAUDE_SKILL_DIR}/scripts/render.mjs" --root <repo root>
```

Files that exist and would change are left alone and listed (exit code 3). For those, render
to a scratch folder with `--out <tmp dir>`, diff each one against the repo, and show the user
what changes. Then write the merged result, usually the generated file plus the project's
extra jobs. Use `--force` only when the user agrees to replace a file.

The Gemfile is kept if it already has fastlane. If it exists without fastlane, add
`gem "fastlane", "~> 2.241"` to it. If Ruby and Bundler work locally, run
`bundle lock --add-platform x86_64-linux arm64-darwin` so CI and Macs resolve the same gems.

### 5. Check the result

Run the checks that are available:

- `actionlint` (if it isn't installed, offer `brew install actionlint` and ask first)
- `ruby -c fastlane/Fastfile`
- `bash -n .github/mobile-cicd/setup-secrets.sh`
- `node --check .github/mobile-cicd/*.mjs`
- **the project's own lint and format check**, the same commands as `ci.lint` and
  `ci.format`. The generated `.mjs` files carry `/* eslint-disable */`, and render adds the
  generated files to `.prettierignore` when the project uses Prettier. Some setups still need a
  hand edit, such as typed ESLint (`parserOptions.project`) or a lint step that checks YAML. If
  so, add `.github/mobile-cicd/` and the three workflow files to that tool's ignore list. A CI
  that fails on its own files on day one is the worst first impression this skill can make.

Then read `mobile-release.yml` once with this app in mind. Check that the prebuild versus
committed steps, the paths and the scheme make sense.

Optionally run `set-versions.mjs` locally with a test version, look at the diff, then
`git checkout --` the touched files.

### 6. Secrets

First make sure the GitHub CLI is ready. The script itself only reports problems; helping
fix them is your job here:

- `gh --version`: if it's missing or older than 2.40, offer to install or upgrade it. On macOS
  with Homebrew that's `brew install gh` / `brew upgrade gh`; elsewhere point to
  https://github.com/cli/cli#installation. Ask before installing anything.
- `gh auth status`: if it isn't signed in, ask the user to run `gh auth login` in their own
  terminal. It opens a browser and uses their GitHub account, so it's theirs to do.

Then check what is already set:

```bash
bash .github/mobile-cicd/setup-secrets.sh --check
```

This shows names only. For each missing secret, explain where it
comes from, using the matching section of [references/secrets.md](references/secrets.md) and
only what this user needs. Then give them the command to run in **their own terminal**:

```bash
bash .github/mobile-cicd/setup-secrets.sh          # everything
bash .github/mobile-cicd/setup-secrets.sh ios      # or one part: env | ios | android | play | firebase
```

Tell them what it will ask for. If they have no Android upload key, the script creates one,
and they must back up the keystore and its password. Don't run the interactive script
yourself: it needs their files, their passwords and a terminal. When they're done, run
`--check` again.

### 7. One-time store setup

Go through [references/store-setup.md](references/store-setup.md) with the user. The items that
block a first release are:

- the first `.aab` must be uploaded by hand
- the Google Play closed-testing rule (12 testers for 14 days) for newer personal accounts
- the first iOS version's store listing
- export compliance

### 8. First release

Offer to commit the files on a branch or PR, following how this repo works. Once they are on
`main`, the release is:

```bash
git tag -a v1.2.3 -m "What's new" && git push origin v1.2.3
gh run watch
```

For a cautious first run, suggest `IOS_SUBMIT_FOR_REVIEW: 'false'` (upload only) and a small
`ANDROID_ROLLOUT`. Raise them once the pipeline has proven itself.

## Later changes

To change a setting, edit `config.json` and render again, diffing first. After a skill update,
render again to pick up template fixes. When a run fails, `gh run view --log-failed` shows the
failing step. Match it in [references/troubleshooting.md](references/troubleshooting.md).
