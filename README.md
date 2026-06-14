# CloudDriveOptimiser

A web application that lets you analyse your Google Drive and Google Photos library to identify the largest files and videos, view them with thumbnails, and optimise selectable videos by re-encoding them at a lower resolution — all without leaving your browser.

---

## Features

- **Google OAuth 2.0** — sign in securely with your Google account
- **Drive analysis** — lists your largest Drive items sorted by size, with file name, upload date, and size
- **Google Photos Picker** — select specific videos from your Google Photos library using the official Google Photos Picker API
- **Thumbnails** — optional thumbnail view for images and videos
- **Video optimisation** — select one or more Drive or Google Photos videos and re-encode them at 720 p (configurable) using FFmpeg
- **Job tracking** — real-time progress display for each transcoding job
- **Upload summary** — completed optimisations list the original file size, new file size, capture timestamp, and filenames
- **Pagination** — load more files on demand

---

## Architecture

```
┌──────────────────────────────────────┐
│          Browser (Vue 3 SPA)         │
│   localhost:80   (nginx container)   │
└────────────┬─────────────────────────┘
             │  /auth/*  /api/*  (proxied)
┌────────────▼─────────────────────────┐
│       Backend (Node.js / Express)    │
│         localhost:3000               │
│  • Google OAuth flow                 │
│  • Drive API (list / download /      │
│    upload / delete)                  │
│  • Photos Picker API (session        │
│    creation / item retrieval)        │
│  • Photos Library API (download /    │
│    upload for selected items)        │
│  • FFmpeg transcoding jobs           │
└──────────────────────────────────────┘
```

Both services are orchestrated with Docker Compose.

---

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| Docker | 24 |
| Docker Compose | v2 (plugin) |
| A Google Cloud project | — |

> **Local development only** (without Docker): Node.js ≥ 20 and FFmpeg must be installed on your machine.

---

## Google Cloud Setup

### 1 — Create a project

1. Go to [console.cloud.google.com](https://console.cloud.google.com/).
2. Click the project drop-down and choose **New Project**. Give it a name (e.g. `CloudDriveOptimiser`) and click **Create**.

### 2 — Enable the required APIs

Inside your project navigate to **APIs & Services → Library** and enable:

- **Google Drive API**
- **Google Photos Library API**
- **Google People API** (for profile information)
- **Photos Picker API** (for the new photo picker functionality)

### 3 — Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** (unless you are in a Google Workspace organisation).
3. Fill in the required fields:
   - **App name**: CloudDriveOptimiser
   - **User support email**: your email
   - **Developer contact email**: your email
4. On the **Scopes** step add:
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/photoslibrary.appendonly`
   - `https://www.googleapis.com/auth/photoslibrary.readonly`
   - `https://www.googleapis.com/auth/userinfo.profile`
   - `https://www.googleapis.com/auth/userinfo.email`
5. Add your own Google account as a **Test user** (required while the app is in testing mode).
6. Save and continue.

### 4 — Create OAuth 2.0 credentials

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Add the following **Authorised redirect URIs** (adjust the host/port if you change defaults):
   ```
   http://localhost:3000/auth/google/callback
   ```
4. Click **Create**.
5. Copy the **Client ID** and **Client Secret** — you will need them in the next step.

---

## Configuration

### 1 — Create the `.env` file

```bash
cp .env.example .env
```

Open `.env` and fill in the values:

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | OAuth Client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | OAuth Client Secret |
| `BACKEND_URL` | Public URL of the backend (default `http://localhost:3000`) |
| `FRONTEND_URL` | Public URL of the frontend (default `http://localhost:80`) |
| `SESSION_SECRET` | A long random string used to sign session cookies |
| `FRONTEND_PORT` | Host port for the frontend container (default `80`) |
| `MAX_FILES` | Maximum number of Drive files to retrieve (default `200`) |
| `TRANSCODE_HEIGHT` | Target video height in pixels (default `720`) |
| `TRANSCODE_CRF` | FFmpeg CRF quality (default `28`; lower = higher quality) |
| `TRANSCODE_PRESET` | FFmpeg encoding preset (default `medium`) |

---

## Running with Docker Compose

```bash
# Build the images and start all services
docker compose up --build

# Run in the background
docker compose up --build -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

Once running, open [http://localhost:80](http://localhost:80) in your browser.

---

## Local Development (without Docker)

### Requirements

- Node.js ≥ 20
- FFmpeg installed and available in `PATH`

### Backend

```bash
cd backend
npm install
# The backend reads ../.env by default
node src/index.js
# or with auto-reload:
node --watch src/index.js
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server proxies `/auth` and `/api` requests to `http://localhost:3000` automatically.

Open [http://localhost:5173](http://localhost:5173) in your browser.

> **Note**: When running locally, set `BACKEND_URL=http://localhost:3000` and `FRONTEND_URL=http://localhost:5173` in your `.env`.
> If you run the frontend through Vite proxy, you can also set `OAUTH_REDIRECT_URI=http://localhost:5173/auth/google/callback` so the OAuth callback stays on the same origin as the browser.

---

## Usage

1. Open the application in your browser.
2. Click **Sign in with Google** and grant the requested Drive and Google Photos permissions.
3. Click **Analyse library** to fetch your largest Drive files.
4. (Optional) Click **Select Photos Videos** to open the Google Photos Picker and choose specific videos from your Google Photos library.
5. Toggle **Show thumbnails** to preview images and videos inline.
6. Check the boxes next to one or more **video** files from Drive or Google Photos.
7. Click **Optimise selected** to begin the transcoding pipeline:
   - The video is downloaded from Drive or Google Photos.
   - FFmpeg re-encodes it at the configured resolution and quality.
   - Embedded metadata is copied onto the optimised MP4.
   - Drive videos are uploaded back to the same folder in Drive and the original is deleted automatically.
   - Google Photos videos are uploaded back into Google Photos as new items.
8. The **Optimisation Jobs** panel shows real-time progress for each file.
9. Once all jobs complete the file list refreshes automatically and the **Optimised Uploads** table shows the original file size, new file size, capture timestamp, and filenames.
10. For Google Photos uploads, manually remove the original item in Google Photos to recover storage space.

---

## Project Structure

```
CloudDriveOptimiser/
├── backend/
│   ├── src/
│   │   ├── index.js       # Express app entry point
│   │   ├── auth.js        # Google OAuth routes
│   │   ├── drive.js       # Drive + Photos listing & thumbnail proxy
│   │   └── optimise.js    # Video transcoding pipelines & job tracking
│   ├── Dockerfile
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── main.js
│   │   ├── App.vue         # Root component (auth, dashboard)
│   │   └── components/
│   │       ├── FileList.vue   # File table with selection & thumbnails
│   │       └── JobStatus.vue  # Optimisation job progress table
│   ├── index.html
│   ├── vite.config.js
│   ├── nginx.conf
│   ├── Dockerfile
│   └── package.json
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## Security Notes

- Session cookies are `httpOnly` and `secure` in production (`NODE_ENV=production`).
- The Google OAuth access token is stored server-side in the session, never exposed to the browser.
- Drive thumbnails are proxied through the backend, avoiding token leakage in browser requests.
- The `.env` file is excluded from version control via `.gitignore`. **Never commit credentials.**
- In production, place the application behind a reverse proxy with TLS and update `BACKEND_URL` / `FRONTEND_URL` accordingly.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| "Authentication failed" after Google login | Redirect URI mismatch | Ensure `BACKEND_URL/auth/google/callback` is listed in Google Console |
| Files list is empty | Required Google APIs not enabled | Enable the Drive API and Google Photos Library API in Google Cloud Console |
| "Drive files error: Request had insufficient authentication scopes" | OAuth scopes not configured in Google Cloud Console | Ensure all required scopes are added to the OAuth consent screen (see Google Cloud Setup section). Re-authenticate with the application after updating scopes. |
| Optimisation fails: "not a video" | File MIME type is not `video/*` | Only video files can be optimised |
| FFmpeg not found | Missing in container | Rebuild with `docker compose build --no-cache` |
| Session lost on backend restart | No persistent session store | For production, configure a Redis session store |
