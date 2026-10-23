# Family Tracker (Kitchen Board)

Touch-first family board for a kitchen screen: per-kid chores and routines with stars, a reward shop, calendar, dinner plan, groceries, timers, countdowns and notes. No accounts, no subscription.

```
web/       the whole UI, one index.html plus bundled fonts (no internet needed)
server/    zero-dependency Node server: serves web/ and keeps the board in one JSON file
android/   WebView wrapper that bundles web/, or points at the home server
deploy/    UnRAID container template
```

The page picks its storage at load: the home server if `/api/state` answers, otherwise browser storage on that device.

## Run it

```
npm start                      # http://localhost:8080, data in server/data/
npm test
docker compose up -d --build   # port 8080, data in the kitchen-board-data volume
```

Image from CI: `ghcr.io/savoxis/family-tracker:latest` (amd64 and arm64).
UnRAID: copy `deploy/unraid/kitchen-board.xml` to `/boot/config/plugins/dockerMan/templates-user/`.

There is no login. Keep it on the home network.

## Android

```
cd android && bash gradlew assembleDebug
```

APK lands in `android/app/build/outputs/apk/debug/`. In Setup, More, "Home server" points the app at the Docker server so every screen shares one board. CI uploads the APK as a build artifact.
