# Family Tracker

Kitchen Board. `web/index.html` is the entire UI and the only copy: Docker serves it, Android bundles it. Never fork it per platform.

- Storage contract the page expects from the server: `GET /api/state` -> `{rev, data}`, `PUT|DELETE /api/<collection>/<id>`. Collections are listed in `server/server.js`. Change both sides together.
- `npm test` must pass. Server has no dependencies, keep it that way.
- ASCII only in scripts. No em dashes in docs.

## Deploying to UnRAID

Target is the UnRAID host in the user env vars `UNRAID_HOST`, `UNRAID_USER`, `UNRAID_PASSWORD`. Never print, log or write the password to a file.

1. Survey first and read-only: `docker ps -a`, used ports, free space on the array/cache, existing appdata layout. Report before changing anything.
2. Create only a new container named `kitchen-board`. Do not touch, restart or remove any existing container.
3. Pull `ghcr.io/savoxis/family-tracker:latest`. If the package is private or CI has not run yet, clone this repo on the host and build with `docker build -f server/Dockerfile -t kitchen-board .`.
4. Data at `/mnt/user/appdata/kitchen-board`, run as `--user 99:100` (UnRAID appdata is nobody:users, the image defaults to uid 1000 and cannot write there). Pick a free host port, 8080 internal.
5. Verify: `curl http://<host>:<port>/api/health` and `/api/state`, then restart the container and confirm data survives.
6. The user adds the Nginx Proxy Manager and DNS entries. Tell them the host, port and which access rules you recommend.

## Working together (chat Claude and the coding agent)

Two Claudes touch this repo: a chat session that designs and edits `web/index.html`, and this coding agent that owns the server, Android build, CI and the UnRAID deploy.

- Always `git pull --ff-only` before starting, and again before pushing. Small commits, clear messages, no force pushes.
- Default for this project: after a change, run `npm test`, then commit and push to `main` without asking for a go-ahead. The owner has pre-approved this. It does not cover force pushes, history rewrites or anything outside this repo.
- The coding agent has direct access to the UnRAID host and the container. The chat session does not and should not try.
- Live board: https://family.awesomazing.com (container `kitchen-board`). Nginx Proxy Manager restricts it to the home LAN, so it is not reachable from cloud sessions. Verify from inside the LAN or on the host with `curl http://<host>:<port>/api/health`.
- The repo is public. Never commit family names, chores, seed data, backups or credentials.
- After a change to `web/`, the coding agent redeploys. The chat session says so in the commit message when a redeploy is needed.
