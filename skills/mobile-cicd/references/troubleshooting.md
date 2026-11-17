# When a run fails

Start with `gh run view --log-failed` (or `gh run view <id> --log-failed`), find the failing job
and step below. Re-run with "Re-run failed jobs": the build number from the first attempt is kept.

## CI / Security

| Symptom | Cause and fix |
| --- | --- |
| `npm ci` fails: lockfile out of sync | Run the install locally and commit the lockfile |
| Type check fails on CI only | The project didn't type-check before; fix it or set `ci.typecheck` to `null` for now |
| Gitleaks finds a secret | Rotate it (see secrets.md). Then rewrite history, or mark a false positive in `.gitleaks.toml` / `.gitleaksignore` |
| Audit fails | Update the package; if there's no fix and it doesn't apply, document it and use `overrides` / `resolutions` |
| Semgrep ERROR finding | Fix it, or add a `nosemgrep` comment on the line with a reason |

## Gate and build number

| Symptom | Cause and fix |
| --- | --- |
| "is not on main" | The tag points at a commit that isn't in `main`. Merge, then `git tag -d vX && git push origin :refs/tags/vX` and tag the right commit |
| Workflow didn't start | The tag isn't `vX.Y.Z` (e.g. `v1.2` or `1.2.3`), or the workflow file isn't on the tagged commit |
| "Could not find app" (App Store) | No App Store Connect app with that bundle ID, or the API key belongs to another team |
| "Google Play did not answer" | Service account not invited, API not enabled, or the first `.aab` was never uploaded by hand |

## Secret check (CI and gate)

`check-workflow-secrets.mjs` prints `file:line [rule] message`. Fix the workflow, don't weaken the check.

| Rule | Fix |
| --- | --- |
| `job-env` | Move the secret from the job's `env:` to the `env:` of the one step that needs it |
| `inline-secret` | Replace `${{ secrets.X }}` in `run:` with a step `env:` entry and `"$X"` in the script |
| `after-deps` | A store secret on or after a step that installs or builds. Use it in a job of its own (like `android-release`) or in a step before `setup-node` (like "Prepare signing") |
| `password-arg` | A password expanded as an argument. Use the tool's `:env` option (`keytool -storepass:env NAME`, `jarsigner -keypass:env NAME`) |
| `xtrace` | Remove `set -x` from the step |
| `cache` | No `bundler-cache: true` in a build job; no `actions/cache` before a store secret is used |
| `unpinned` | Pin the action to its full commit SHA, with the version in a comment |

## iOS build job

| Symptom | Cause and fix |
| --- | --- |
| "Could not import the distribution certificate" / "MAC verification failed" | Wrong `.p12` password: `setup-secrets.sh ios` |
| "fastlane ios build runs the app's build code, which must not see store secrets" | A store secret was added to the build step or the job's `env`: remove it |
| "No profile for team ... matching" / sigh errors | The API key's role can't create profiles: make an App Store profile by hand and set `IOS_PROVISIONING_PROFILE` |
| "Provisioning profile doesn't include signing certificate" | The profile was made with another certificate: regenerate it with this one |
| Pods fail with encoding errors | The locale is set in the workflow (`LANG`, `LC_ALL`); check that a step didn't override it |
| Build needs a newer SDK | Apple now requires a newer Xcode: the `macos-26` image's default Xcode may lag; select a newer one in "Select Xcode" or bump the runner |
| App extension target fails to sign | Extensions need their own profiles: not handled yet; add them in the `prepare_signing` lane and `export_options` |

## iOS upload job

| Symptom | Cause and fix |
| --- | --- |
| "No build/ios/app.ipa" | `ios-build` failed or its artifact expired: re-run the failed jobs |
| "Redundant Binary Upload" | That build number already exists: re-running after a successful upload. Push a new tag (a new number is picked) |

## iOS submit job

| Symptom | Cause and fix |
| --- | --- |
| Waits, then "still processing after an hour" | Apple is slow today: submit by hand in App Store Connect |
| Processing FAILED / INVALID | Read Apple's email (missing usage descriptions in Info.plist, invalid icons, etc.) |
| Missing metadata / screenshots on submit | First version: complete the store listing (store-setup.md) |
| Export compliance error | Set `ITSAppUsesNonExemptEncryption` in Info.plist, or `release.iosUsesNonExemptEncryption` |
| "A version is already waiting for review" | Only one submission at a time: wait, or remove the pending one in App Store Connect |
| Something in `deliver` fails only on Linux | Change `ios-submit` to `runs-on: macos-26` and report it |

## Android jobs

`android-build` builds the bundle with a throwaway key and no secrets; `android-release` replaces
that signature with the upload key (`jarsigner`), checks it, and uploads.

| Symptom | Cause and fix |
| --- | --- |
| "not signed with the upload key" (`android-release`) | `ANDROID_KEYSTORE` or `ANDROID_KEY_ALIAS` is wrong, or `ANDROID_KEY_PASSWORD` is missing for a key whose password differs: `setup-secrets.sh android` |
| `jarsigner` / `keytool`: "keystore password was incorrect" | Wrong `ANDROID_KEYSTORE_PASSWORD`: `setup-secrets.sh android` |
| Gradle: SDK platform / build-tools missing | Add a step before the build: `yes \| sdkmanager "platforms;android-XX" "build-tools;XX.0.0"` |
| Out of memory | Add `org.gradle.jvmargs=-Xmx4g` to `android/gradle.properties`; for React Native set `android.reactNativeArchitectures` |
| Very slow first build (React Native) | Normal: C++ for every ABI. ccache helps later runs; fewer ABIs help most |
| Play: "Version code N has already been used" | Someone uploaded by hand with a higher number in a track not checked (custom closed track): push a new tag |
| Play: "draft app" | Expected before the first published release: the pipeline uploads a draft; publish it in Play Console |
| Play: 403 / "The caller does not have permission" | The service account lacks release rights for this app |
| Play: production not allowed | Closed-testing requirement for new personal accounts (store-setup.md) |
