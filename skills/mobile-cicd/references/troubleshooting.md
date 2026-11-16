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

## iOS job

| Symptom | Cause and fix |
| --- | --- |
| `import_certificate` / "MAC verification failed" | Wrong `.p12` password: `setup-secrets.sh ios` |
| "No profile for team ... matching" / sigh errors | The API key's role can't create profiles: make an App Store profile by hand and set `IOS_PROVISIONING_PROFILE` |
| "Provisioning profile doesn't include signing certificate" | The profile was made with another certificate: regenerate it with this one |
| Pods fail with encoding errors | The locale is set in the workflow (`LANG`, `LC_ALL`); check that a step didn't override it |
| Build needs a newer SDK | Apple now requires a newer Xcode: the `macos-26` image's default Xcode may lag; select a newer one in "Select Xcode" or bump the runner |
| App extension target fails to sign | Extensions need their own profiles: not handled yet; add them in `install_ios_signing` and `export_options` |
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

## Android job

| Symptom | Cause and fix |
| --- | --- |
| "not signed with the upload key" | The bundle was signed with another key: check `ANDROID_KEYSTORE`/alias, or an override in build.gradle (`signingConfig`) that ignores the injected properties |
| Gradle: SDK platform / build-tools missing | Add a step before the build: `yes \| sdkmanager "platforms;android-XX" "build-tools;XX.0.0"` |
| Out of memory | Add `org.gradle.jvmargs=-Xmx4g` to `android/gradle.properties`; for React Native set `android.reactNativeArchitectures` |
| Very slow first build (React Native) | Normal: C++ for every ABI. ccache helps later runs; fewer ABIs help most |
| Play: "Version code N has already been used" | Someone uploaded by hand with a higher number in a track not checked (custom closed track): push a new tag |
| Play: "draft app" | Expected before the first published release: the pipeline uploads a draft; publish it in Play Console |
| Play: 403 / "The caller does not have permission" | The service account lacks release rights for this app |
| Play: production not allowed | Closed-testing requirement for new personal accounts (store-setup.md) |
