# One-time setup outside the repo

Go through these with the user before the first tag. The ones marked **blocks** stop a first
release if skipped.

## Apple

1. **Apple Developer Program membership** (paid). The Team ID is under Membership.
2. **App ID** for the bundle ID (Apple Developer -> Identifiers), with the capabilities the app
   uses (Push Notifications, Sign in with Apple...). Xcode or fastlane may have created it already.
3. **App record** in App Store Connect -> Apps -> "+" -> New App, with the same bundle ID. **Blocks.**
4. **First version only:** fill in the store listing (screenshots for the required sizes,
   description, keywords, support URL, privacy policy URL, App Privacy answers, age rating,
   category, price). Without these the build uploads, but submission is refused. Later versions
   only need the "What's New" text, which comes from the tag message. **Blocks the first submission.**
5. **Export compliance:** add `ITSAppUsesNonExemptEncryption` = `NO` to Info.plist (Expo:
   `ios.config.usesNonExemptEncryption: false`) if the app uses only HTTPS and standard OS
   crypto. The pipeline also answers it at submission from `release.iosUsesNonExemptEncryption`.
   Without either, builds wait at "Missing Compliance".
6. Sign in with Apple, push, and similar capabilities must be enabled on the App ID before a
   build that uses them can be signed.

## Google

1. **Play Console developer account** (one-time fee). Personal or organisation.
2. **Create the app** in Play Console with the right default language. Fill in the App content
   declarations: privacy policy, ads, data safety, content rating, target audience. Fill in the
   store listing basics too.
3. **Upload the first `.aab` by hand.** The Play API cannot create an app or accept its very
   first bundle. Build one locally, or let the release run once and download the
   `android-<build>` artifact from the failed run's page. Upload it to an internal or closed
   testing track. This also enrolls Play App Signing with the upload key. **Blocks.**
4. **Personal accounts created after November 13, 2023:** before production access, Google
   requires a closed test with at least **12 testers opted in for 14 days in a row**, then an
   application for production access. Until that's granted, uploads to production fail. Plan
   for this with the user. It's the most common surprise. **Blocks** for those accounts.
5. **Invite the service account** (see secrets.md). **Blocks.**
6. **Draft app:** until the first release is published in Play Console, Google accepts only
   draft releases. The pipeline detects this and uploads a draft. The user publishes that first
   one by hand, and later releases go out by themselves.
7. If the app uses Google Sign-In: once Play App Signing exists, add its SHA-1 (App integrity
   page) to the Android OAuth client in Google Cloud. Otherwise sign-in fails only in the store
   build.

## GitHub

- Actions must be enabled for the repo. Workflows run from the default branch's files: merge
  the generated files into `main` before the first tag.
- **Cost:** in private repos, macOS runner minutes count roughly ten times against the account's
  included minutes. A release takes about 20-40 macOS minutes for iOS. Ubuntu jobs (CI, security,
  Android, the iOS submit wait) count once. Public repos are free.
- Optional hardening: put the signing secrets in a GitHub **Environment** named `production`,
  limited to tags `v*`, and add `environment: production` to the `ios`, `ios-submit`, `android`
  and `resolve` jobs. Then only release jobs can read them. Environment secrets in private
  repos need a paid GitHub plan.
- Tag protection (Settings -> Rules -> rulesets targeting tags `v*`) can limit who may push
  release tags.

## A good first release

- Pick a version the user is happy to ship, or play it safe: set `IOS_SUBMIT_FOR_REVIEW: 'false'`
  and a small `ANDROID_ROLLOUT` (Play still needs the first release published by hand if the
  app is a draft).
- Push the tag and watch: `gh run watch`. The first iOS run takes longest because of CocoaPods
  and a cold build.
- After it works, switch to the normal settings.
