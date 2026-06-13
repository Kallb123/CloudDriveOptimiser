# CloudDriveOptimiser

A web application that lets you analyse your Google Drive to identify the largest files, view them with thumbnails, and optimise videos by re-encoding them at a lower resolution — all without leaving your browser.

---

## Features

- **Google OAuth 2.0** — sign in securely with your Google account
- **Drive analysis** — lists your largest files sorted by size, with file name, upload date, and size
- **Thumbnails** — optional thumbnail view for images and videos
- **Video optimisation** — select one or more video files and re-encode them at 720 p (configurable) using FFmpeg; the original is deleted once the new file is successfully uploaded
- **Job tracking** — real-time progress display for each transcoding job
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
- **Google People API** (for profile information)

### 3 — Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** (unless you are in a Google Workspace organisation).
3. Fill in the required fields:
   - **App name**: CloudDriveOptimiser
   - **User support email**: your email
   - **Developer contact email**: your email
4. On the **Scopes** step add:
   - `https://www.googleapis.com/auth/drive`
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

---

## Usage

1. Open the application in your browser.
2. Click **Sign in with Google** and grant the requested Drive permissions.
3. Click **Analyse Drive** to fetch your largest files.
4. Toggle **Show thumbnails** to preview images and videos inline.
5. Check the boxes next to one or more **video** files (only video files are eligible for optimisation).
6. Click **Optimise selected** to begin the transcoding pipeline:
   - The video is downloaded from Drive.
   - FFmpeg re-encodes it at the configured resolution and quality.
   - The optimised file is uploaded back to the same folder in Drive.
   - The original file is deleted.
7. The **Optimisation Jobs** panel shows real-time progress for each file.
8. Once all jobs complete the file list refreshes automatically.

---

## Project Structure

```
CloudDriveOptimiser/
├── backend/
│   ├── src/
│   │   ├── index.js       # Express app entry point
│   │   ├── auth.js        # Google OAuth routes
│   │   ├── drive.js       # Drive file listing & thumbnail proxy
│   │   └── optimise.js    # Video transcoding pipeline & job tracking
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
| Files list is empty | Drive API not enabled | Enable the Drive API in Google Cloud Console |
| Optimisation fails: "not a video" | File MIME type is not `video/*` | Only video files can be optimised |
| FFmpeg not found | Missing in container | Rebuild with `docker compose build --no-cache` |
| Session lost on backend restart | No persistent session store | For production, configure a Redis session store |
