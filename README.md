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

Google Calendar: in Google Calendar open the calendar's Settings and sharing, Integrate calendar, and copy the "Secret address in iCal format". Give it to the server as `ICS_URLS=Family|https://...basic.ics` (several calendars: separate with commas, each as `Label|url`). The server reads it every 15 minutes (`ICS_MINUTES`) and keeps the events from 45 days back to 200 days ahead on the board, repeats included, in `BOARD_TZ` (default: the calendar's own zone). It is read-only: those events have ids starting `gcal-` and edits made to them on the board are overwritten at the next sync. Events typed in on the board are never touched. The link is a secret: keep it in an env file on the host (for Docker, `--env-file`), never in the repo. If it leaks, press Reset next to it in Google Calendar and update the env file.

Google Keep shopping list (unofficial, can break): Google has no Keep API for personal accounts, so `server/keep.js` speaks the private protocol the Keep app uses (ported from the open source gpsoauth and gkeepapi). Use a dedicated Google account that the list is shared with, never your main one. Get a master token for that account (see the gpsoauth project: `exchange_token` with the `oauth_token` cookie from accounts.google.com/EmbeddedSetup) and set `KEEP_EMAIL`, `KEEP_MASTER_TOKEN` and `KEEP_LIST` (the list's exact title) in the env file. The list is expected to work like this: category headers stay unchecked, items sit under a header, checked means bought, unchecked means on the list. The board then shows only the unchecked items. An item added on the board first unchecks an existing item with the same name (emoji and case are ignored), and only creates a new one if nothing matches, under the category its words fit, else "Other". Checking on either side checks on the other. Removing an item on the board checks it in Keep and never deletes Keep history. An item deleted in Keep leaves the board. It syncs every `KEEP_MINUTES` (2) and a few seconds after a grocery change. `KEEP_HEADERS` names headers that have no items yet, so they are not mistaken for items. `KEEP_DRYRUN=1` only logs what would change. The token is a long-lived credential: keep it in the env file, never in the repo, and revoke it by removing the account's access to the list or changing that account's password.

Backups: the server copies the board to `<data dir>/backups/board-<UTC time>.json` at start and every 6 hours, skips it when nothing changed, and keeps the newest 28. Set `BACKUP_HOURS` (0 turns it off) and `BACKUP_KEEP` to change that. To restore, stop the container and copy a backup over `board.json`.

## Android

```
cd android && bash gradlew assembleDebug
```

APK lands in `android/app/build/outputs/apk/debug/`. In Setup, More, "Home server" points the app at the Docker server so every screen shares one board. CI uploads the APK as a build artifact.
