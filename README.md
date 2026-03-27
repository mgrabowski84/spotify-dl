# spotify-dl

Downloads Spotify playlists as lossless FLAC from Tidal. Runs as a Docker container with a minimal web UI.

## How it works

1. You paste a Spotify playlist URL into the web UI
2. The server fetches the track list from the Spotify API (client credentials -- no user login required)
3. Each track is searched on Tidal via [hifi-api](https://github.com/monochrome-music/monochrome) instances
4. The best match is selected using fuzzy artist/title scoring
5. FLAC files are streamed from Tidal and saved to the output directory
6. Tracks are downloaded concurrently (configurable, default 3)

API instances are auto-discovered from the [monochrome uptime tracker](https://tidal-uptime.jiffy-puffs-1j.workers.dev/) with automatic failover between instances.

## Requirements

- Docker
- A Spotify app (client ID + secret) -- create one at https://developer.spotify.com/dashboard

## Setup

```bash
# 1. Create .env
cp app/.env.example app/.env
# Edit app/.env and fill in Spotify credentials

# 2. Build and run
docker build -t spotify-dl .
docker run -d \
  --name spotify-dl \
  -p 8070:3000 \
  -v /path/to/music:/music \
  spotify-dl
```

Open http://localhost:8070 to use the UI.

## Environment variables

| Variable           | Description                                       |
|--------------------|---------------------------------------------------|
| `SPOTIFY_ID`       | Spotify app client ID                             |
| `SPOTIFY_SECRET`   | Spotify app client secret                         |
| `TIDAL_API_URL`    | Override hifi-api instance (auto-discovered if empty) |
| `TIDAL_CONCURRENT` | Concurrent Tidal downloads (default: `3`)         |
| `AUDIO_DIR`        | Output directory (default: `/music`)              |
| `PORT`             | HTTP port inside container (default: `3000`)      |

All vars can be set in `app/.env`.

## Notes

- Only public playlists are supported (Spotify client credentials flow does not require user auth)
- Spotify editorial/algorithmic playlists (e.g. "Today's Top Hits") return 404 from the API under client credentials -- use user-created playlists
- Downloads are lossless FLAC (16-bit/44.1kHz) from Tidal
- Tracks not found on Tidal or with low match scores are skipped
- Existing files in the output directory are not re-downloaded
