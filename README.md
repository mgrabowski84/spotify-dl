# spotify-dl

Downloads Spotify playlists via Soulseek, saving files as FLAC. Runs as a Docker container with a minimal web UI.

## How it works

1. You paste a Spotify playlist URL into the web UI
2. The server fetches the track list from the Spotify API (client credentials — no user login required)
3. A tracklist file is written and passed to [sldl](https://github.com/fiso64/slsk-batchdl) with `--input-type list`
4. sldl searches Soulseek and downloads the files
5. FLACs land in the configured output directory

## Requirements

- Docker
- A Soulseek account
- A Spotify app (client ID + secret) — create one at https://developer.spotify.com/dashboard
- The `sldl` binary placed at `app/bin/sldl`

## Setup

```bash
# 1. Copy the sldl binary
cp /path/to/sldl app/bin/sldl
chmod +x app/bin/sldl

# 2. Create .env
cp app/.env.example app/.env
# Edit app/.env and fill in credentials

# 3. Install node_modules on the host (bind-mounted into the container)
cd app && npm install --production && cd ..

# 4. Build and run
docker build -t spotify-dl .
docker run -d \
  --name spotify-dl \
  -p 8070:3000 \
  -v $(pwd)/app:/app \
  -v /path/to/music:/music \
  spotify-dl
```

Open http://localhost:8070 to use the UI.

## Environment variables

| Variable           | Description                        |
|--------------------|------------------------------------|
| `SOULSEEK_USER`    | Soulseek username                  |
| `SOULSEEK_PASSWORD`| Soulseek password                  |
| `SPOTIFY_ID`       | Spotify app client ID              |
| `SPOTIFY_SECRET`   | Spotify app client secret          |
| `AUDIO_DIR`        | Output directory (default: `/music`) |
| `SLDL_LISTEN_PORT` | sldl listen port (default: `49997`) |
| `PORT`             | HTTP port inside container (default: `3000`) |

All vars can be set in `app/.env`.

## Notes

- Only public playlists are supported (Spotify client credentials flow does not require user auth)
- Spotify editorial/algorithmic playlists (e.g. "Today's Top Hits") return 404 from the API under client credentials — use user-created playlists
- Downloads prefer FLAC ≥ 320 kbps; sldl will fall back to lower quality if unavailable
