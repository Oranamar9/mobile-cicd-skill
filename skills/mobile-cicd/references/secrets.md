# Store secrets, one by one

Give the user only the sections they need. The setup script
(`bash .github/mobile-cicd/setup-secrets.sh`) asks for each of these and checks it before
upload. This file is for explaining where things come from and what the checks mean.

Contents: [App Store Connect API key](#app-store-connect-api-key) ·
[Distribution certificate](#apple-distribution-certificate) ·
[Provisioning profile](#app-store-provisioning-profile-optional) ·
[Android upload key](#android-upload-key) · [Play service account](#google-play-service-account) ·
[Build environment](#build-environment) · [Firebase files](#firebase-config-files) ·
[Rotating](#rotating-a-leaked-secret)

## Where the workflow uses them

| Secret | Job and step | Runs dependency code? |
| --- | --- | --- |
| App Store Connect API key | `resolve`, `ios-build` "Prepare signing", `ios-upload`, `ios-submit` | No ("Prepare signing" runs before node is set up) |
| Distribution certificate, profile | `ios-build` "Prepare signing" | No. The key is imported non-extractable; later build steps can sign with it but not copy it |
| Android upload key | `android-release` "Sign the bundle" (`jarsigner`, passwords via `:env`) | No: a fresh runner, fastlane and the JDK only |
| Play service account | `resolve`, `android-release` "Upload to Google Play" | No |
| Build environment, Firebase files | the build jobs | Yes, by necessity: they ship inside the app |

If the user asks why a step can't just get the secret it needs, this table is the answer: build
code from any dependency could read it and send it anywhere, and GitHub's log masking doesn't
stop that.

## App Store Connect API key

Secrets: `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`,
`APP_STORE_CONNECT_API_KEY` (the `.p8`, base64).

- App Store Connect -> Users and Access -> Integrations -> App Store Connect API -> Team Keys ->
  "+". Pick the **App Manager** role. **Admin** is needed only if fastlane should create
  provisioning profiles itself and App Manager is refused.
- The `.p8` downloads **once**. The Key ID is in its name (`AuthKey_<KEYID>.p8`). The Issuer ID
  is the UUID above the list of keys.
- The script signs a token with the key and asks App Store Connect for the app with this bundle
  ID. "almost" means the key works but the app record doesn't exist yet. That's fine to upload
  now, but the app must be created before the first release.
- Account Holder or Admin rights are needed to create keys. If the user has neither, someone on
  the team must make the key.

## Apple Distribution certificate

Secrets: `IOS_DISTRIBUTION_CERTIFICATE` (the `.p12`, base64), `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`.

- If one exists on a Mac: Keychain Access -> My Certificates -> "Apple Distribution: <name>
  (<team>)". Expand it to see the private key underneath; without the key the export is useless.
  Right click -> Export -> `.p12` with a new password.
- If none exists: Apple Developer -> Certificates -> "+" -> Apple Distribution, with a CSR from
  Keychain Access (Certificate Assistant -> Request a Certificate from a Certificate Authority ->
  saved to disk). Double-click the downloaded `.cer` to install it, then export it as above.
- A team can have only a few distribution certificates (usually 2-3). Reuse one across apps of
  the same team rather than making new ones.
- The script checks that the password opens the file, that it is a Distribution certificate,
  and that it hasn't expired. It also prints its expiry date: certificates last a year, so the
  user should put that date in their calendar.

## App Store provisioning profile (optional)

Secret: `IOS_PROVISIONING_PROFILE` (base64).

- Without it, fastlane fetches a matching App Store profile with the API key on every build, or
  creates one. That is the simple choice. Set this only if fetching fails (the key's role) or
  the team wants a fixed profile.
- Apple Developer -> Profiles -> "+" -> **App Store Connect** (Distribution) -> the app's App ID ->
  the distribution certificate above.
- The script checks that it's an App Store profile (no device list), that it's for
  `<TeamID>.<bundle ID>`, that it isn't expired, and that it contains the certificate that was
  just set.

## Android upload key

Secrets: `ANDROID_KEYSTORE` (base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD` (only when it differs from the keystore password).

- With Play App Signing (the default for new apps), Google holds the key that signs what users
  install. The developer signs uploads with an **upload key**, and that is this keystore.
- **No key yet?** The script creates one (`~/.mobile-cicd/<package>/upload.keystore`, alias
  `upload`, random password kept in the macOS Keychain). Google learns this key when the first
  `.aab` is uploaded by hand.
- **App already on Play?** Use the upload key it already knows. The script prints the key's
  SHA-256. It must equal Play Console -> Test and release -> App integrity -> "Upload key
  certificate". A lost upload key can be reset through Play Console (App integrity -> request
  upload key reset). That takes a few days.
- **Back up** the keystore and its password in a password manager. The script says so, and it's
  worth repeating.

## Google Play service account

Secret: `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (the raw JSON).

1. Google Cloud console: pick or create a project -> APIs & Services -> enable **Google Play
   Android Developer API**.
2. IAM & Admin -> Service accounts -> Create (no roles needed) -> Keys -> Add key -> JSON.
3. Play Console -> Users and permissions -> Invite new users -> the service account's email ->
   App permissions -> this app -> **Release to production, exclude devices, and use Play App
   Signing** plus **Release apps to testing tracks** -> Invite.

Notes:

- One service account can serve every app in the developer account, so a team with several
  apps can reuse one key.
- The script gets a token with the key and opens (then deletes) an edit for the package.
- "almost" with 404 usually means the app has no uploaded bundle yet: the first `.aab` must go
  up by hand.
- "almost" with 403 means the account isn't invited for this app, or the API isn't enabled.
- Permissions can take a while to apply after an invite. If the check says 403 right after
  inviting, wait a few minutes and run `setup-secrets.sh play` again.

## Build environment

Secret: `ENV_PRODUCTION` (the whole `.env.production`, or whatever `env.file` is in the config).

- The values the app is built with: API URLs, public keys, feature flags. Vite reads
  `VITE_*`; Expo reads `EXPO_PUBLIC_*`.
- These end up **inside the shipped app**, so they must be public client values (like a
  Supabase publishable key). They must never be server secrets (like a Supabase service-role
  key). If the user's file has a server secret, raise it: it's a security bug whether or not
  CI is involved.
- The script warns when the file lacks a variable the code reads.

## Firebase config files

Secrets: `GOOGLE_SERVICE_INFO_PLIST`, `GOOGLE_SERVICES_JSON` (base64). These are needed only
when the files are gitignored.

- Firebase console -> Project settings -> Your apps -> the iOS / Android app -> download.
- The script checks that each file belongs to this bundle ID or package name.
- These files aren't really secret (they ship inside the app), so committing them is also
  acceptable. Then CI doesn't need the secrets: set `firebase.*` to `null` and render again.

## Rotating a leaked secret

If a value was pasted into a chat, committed, or printed in a log:

| What | How |
| --- | --- |
| API key `.p8` | App Store Connect -> Integrations -> revoke the key, create a new one, `setup-secrets.sh ios` |
| `.p12` password | Export the certificate again with a new password. If the `.p12` file itself leaked, revoke the certificate in Apple Developer and create a new one (profiles that use it must be regenerated). |
| Upload keystore or password | Play Console -> App integrity -> request an upload key reset with a new key. It takes days. |
| Service account JSON | Google Cloud -> the service account -> Keys -> delete that key, add a new one, `setup-secrets.sh play` |
| `.env.production` value | Rotate it at its source (e.g. a new Supabase key), then `setup-secrets.sh env` |
