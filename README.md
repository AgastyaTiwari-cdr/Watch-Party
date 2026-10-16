# SyncVibe — synchronized YouTube watch party

SyncVibe is a responsive watch-party MVP with a dark, polished interface and a separate Socket.IO realtime backend. It supports room codes/invite links, host-authorized playback commands, YouTube IFrame Player API playback, late joins, short reconnect recovery, shared chat, reactions, playlist queueing, polls, host transfer, fuzzy search over a small curated catalogue, and a health endpoint.

> **Honest release status:** this is a deployable MVP, not a hardened commercial service. Room state is in memory and is lost when the backend restarts. There are no accounts, durable database, moderation dashboard, Redis adapter, or guaranteed performance SLA. A real YouTube playback test requires a browser with network access and depends on each video's embed permissions.

## Architecture

- `public/` — static website; deploy this to Vercel.
- `server/` — Node.js + Express + Socket.IO; deploy this as a long-running web service (Render is configured in `render.yaml`).
- `tests/` — URL parser unit tests, frontend contract checks, and a Socket.IO integration test.
- `vercel.json` — static output and basic response headers.
- `render.yaml` — backend service configuration.

**Why two deployments?** Vercel announced WebSocket support for Functions in public beta in June 2026, but this project currently runs a standalone Express/Socket.IO server with in-memory room state. Deploying that stateful server on an instance-based/serverless platform needs an explicit architecture for instance routing, reconnects, and shared state. For the most straightforward setup, keep this backend as a long-running Node web service on Render and host the static frontend on Vercel. If you later move realtime to Vercel, redesign around its WebSocket/Function model and shared durable state rather than copying this in-memory server unchanged.

## Run locally on Windows

Requirements: Node.js 20+ (Node 22 LTS recommended), npm, VS Code, and the VS Code Live Server extension or another static HTTP server.

### 1. Start the backend

Open Command Prompt or the VS Code terminal in the extracted project:

```bat
cd server
npm install
set CLIENT_ORIGINS=http://localhost:5500,http://127.0.0.1:5500,http://localhost:5173,http://127.0.0.1:5173
npm run dev
```

Keep that terminal open. The backend should log that it is listening on port `3000`. Check [http://localhost:3000/health](http://localhost:3000/health); it should return JSON with `"ok":true`.

### 2. Start the frontend

Open the `public` folder in VS Code, right-click `index.html`, and choose **Open with Live Server**. The default Live Server address is usually `http://127.0.0.1:5500` or `http://localhost:5500`.

If the page says it cannot connect, open **Settings** (gear icon) and set the realtime server URL to `http://localhost:3000`. Do not open `index.html` directly as `file://`.

### 3. Test with two browser contexts

1. In browser A, create a room and choose a display name.
2. Copy the invite link. Open it in browser B or an incognito window and join with another name.
3. In the host window, load a public YouTube video that allows embedding.
4. Test play, pause, seek, playback speed, chat, reactions, playlist add/play/remove, poll create/vote/close, host transfer, and leaving/rejoining.
5. Test an embed-restricted/private video and confirm SyncVibe displays a helpful error rather than claiming playback succeeded.

## Deploy to GitHub + Vercel + Render

### 1. Push the project to GitHub

Create a repository and upload the contents of this project (the `public`, `server`, and `tests` folders plus root configuration files). Do not upload `node_modules` or secrets.

### 2. Deploy the static frontend to Vercel

1. Import the GitHub repository in Vercel.
2. Use the project root and the included `vercel.json` (`outputDirectory: public`). If Vercel asks for a framework, choose **Other**.
3. Deploy once and copy the deployed frontend origin, e.g. `https://your-project.vercel.app` (no path and no trailing slash).

### 3. Deploy the backend to Render

1. Create a Render **Web Service** from the same GitHub repository. The included `render.yaml` sets `rootDir: server`, `npm install`, `npm start`, and `/health`.
2. After Render creates the service, open its Environment settings and set:

   - `CLIENT_ORIGINS` = `https://your-project.vercel.app`
   - `MAX_MEMBERS` = `30` (optional; valid range is 10–100)

   If you use a custom domain, add it as another comma-separated origin. For example: `https://your-project.vercel.app,https://watch.example.com`. Use exact origins, with no trailing slash. Do not use `*` in production.
3. Redeploy/restart the backend and test `https://YOUR-SERVICE.onrender.com/health`.

### 4. Point Vercel at the live backend

Edit `public/config.js` and replace the local default with your Render URL:

```js
window.SYNCVIBE_SERVER_URL = 'https://YOUR-SERVICE.onrender.com';
```

Commit and push the change; Vercel redeploys automatically. You can also set a different URL in the site's Settings dialog for local development.

**Deployment order matters:** deploy the frontend once to get its domain, configure that exact origin in Render, deploy the backend, then update `public/config.js` to use the Render URL and redeploy the frontend.

### Hosting notes

- Render's free tier may sleep when idle, so the first connection after a quiet period can take longer.
- Use HTTPS on production. The frontend uses `strict-origin-when-cross-origin`, and the player is configured with `enablejsapi`, the current origin, and `youtube-nocookie.com` as the player host.
- If you use a Vercel preview URL, add that exact preview origin to `CLIENT_ORIGINS` if you want it to connect.
- A server restart clears active rooms and their messages. Use a persistent database and a Socket.IO adapter for a larger or multi-instance deployment.

## YouTube integration: what works and what does not

- SyncVibe uses the official **YouTube IFrame Player API** for embedded playback. You do **not** need a YouTube Data API key to embed a video or control it through this API.
- Video ID parsing supports bare 11-character IDs, `/watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`, and `/live/` URLs.
- The recommendation list is curated locally, with fuzzy search over its titles/categories/tags. It is **not** a global YouTube search. A global search needs the YouTube Data API, an API key, quota management, and additional error handling.
- A valid video ID does not guarantee playback: videos may be private, removed, age-restricted, region-restricted, or blocked from embedding by their owners. SyncVibe cannot override those restrictions.
- Error 153 usually means YouTube did not receive a Referer or equivalent client identification. Check HTTPS hosting, the document referrer policy, and browser privacy extensions. Do not bypass users' privacy settings.
- Browser autoplay policies can prevent a viewer from automatically starting playback. If that happens, ask the viewer to press play once; YouTube playback may then synchronize normally.

## Tests and performance checks

From the `server` directory, after `npm install`:

```bat
npm test
npm run test:latency
```

`npm test` includes YouTube URL parser tests, static integration checks, and a Socket.IO server integration test. `npm run test:latency` reports round-trip ping percentiles from one client. Ping RTT is **not** the same as host-command-to-viewer propagation latency and is not a guarantee of the product's targets.

Acceptance targets from the brief:

- At least 10 concurrent participants in a room.
- Host-control event propagation p95 ≤ 250 ms on the target local network.
- Drift corrected to ≤ 500 ms.

These targets have **not been claimed as measured** in this package. To validate them, run 10 separate browser contexts on the target network, execute at least 500 host play/pause/seek commands, record p50/p95/p99 command-to-viewer event times, and sample player positions every 250–500 ms. Repeat with a late join and a reconnect. YouTube buffering, browser scheduling, Wi-Fi, and clock synchronization affect real playback drift.

## Security and product limitations

- Room codes are invitations, not authentication. Anyone who obtains a code can attempt to join. Share links thoughtfully.
- Resume tokens are bearer credentials stored in browser local storage. Do not share them or log them.
- The backend validates host-only actions, video IDs, names, poll inputs, and message size, and applies per-socket event rate limits. This is baseline protection, not a substitute for production abuse monitoring or moderation.
- Room state and chat are in memory; no durable persistence is configured.
- Use a persistent data store, shared Socket.IO adapter, robust rate limiting, moderation/reporting, token revocation, and monitoring before offering this as a public commercial service.
