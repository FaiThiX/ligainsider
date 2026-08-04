# Player News Discord Bot

A private, self-hosted Discord bot that tracks player news from LigaInsider, posts new
articles as Discord embeds, and exposes a private RSS feed for each user.

The application is intentionally limited to one Discord server per deployment. It stores
all state in SQLite and runs the Discord gateway, scraper, scheduler, RSS server, and
cleanup worker in one container.

## Features

- `/player add`, `/player remove`, `/player list`, `/player clear`, and `/player rss`
- Player lookup by name or LigaInsider profile URL
- A private text channel per user, created with the first tracked player
- A stable, random RSS URL per user
- A 72-hour grace period before an empty channel and feed are deleted
- Persistent delivery retries and source-URL deduplication
- Multi-architecture container releases for AMD64 and ARM64

## Bot commands

- `/player add query:<name-or-url>` resolves a player and starts tracking. Ambiguous
  names open a private selection menu.
- `/player remove player:<autocomplete>` removes one tracked player.
- `/player list` shows the alphabetically sorted, 1-based paginated list.
- `/player clear` removes every player after confirmation.
- `/player rss action:<show|rotate>` reveals or replaces the private feed URL.

Every command response is ephemeral. The first successful add creates a private channel
under `Player Updates`; additional categories are created when one reaches Discord's
50-channel limit. Removing the final player starts the configured grace period. Adding a
player during that period keeps the existing channel, RSS URL, and feed history.

## Important source notice

This project is not affiliated with, endorsed by, or operated by LigaInsider. It only
links to publicly visible articles and does not copy article bodies. LigaInsider's current
[terms](https://www.ligainsider.de/agb/) state that website use is limited to private
purposes. Run this software only for a private, self-hosted Discord server and verify
that your use complies with the source's terms and applicable law.

## Discord setup

1. Create an application and bot in the Discord Developer Portal.
2. Enable the **Server Members Intent** so the bot can start cleanup when a member leaves.
3. Invite the bot to one server with the `bot` and `applications.commands` scopes.
4. Grant the bot these server permissions:
   - View Channels
   - Manage Channels
   - Manage Roles
   - Send Messages
   - Embed Links
   - Read Message History
5. Copy `.env.example` to `.env` and provide the Discord token, application ID, guild ID,
   and the public HTTPS origin used for RSS links.

The bot does not need the Administrator permission. Discord members with Administrator
can always bypass [channel permission overwrites](https://docs.discord.com/developers/topics/permissions),
so Discord cannot guarantee that a channel is hidden from server administrators.

## Run with Docker Compose

```bash
cp .env.example .env
docker compose up --build -d
docker compose logs -f player-news-bot
```

The HTTP service listens on `127.0.0.1:3000` by default. Put an HTTPS reverse proxy in
front of it and set `PUBLIC_BASE_URL` to the external origin. A minimal Nginx location is:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# RSS tokens are bearer secrets and must not appear in access logs.
location /feeds/ {
    access_log off;
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

For a published image, set `IMAGE_NAME=ghcr.io/OWNER/REPOSITORY:latest` and run
`docker compose pull && docker compose up -d`.

The service exposes `GET /healthz` for liveness, `GET /readyz` for database and Discord
readiness, and private feeds at `GET /feeds/{token}.xml`. Feed responses include ETag and
Last-Modified validators and are generated directly from SQLite rather than stored as
XML files.

## Configuration

| Variable                     | Required | Default                    | Purpose                                    |
| ---------------------------- | -------- | -------------------------- | ------------------------------------------ |
| `DISCORD_TOKEN`              | Yes      | —                          | Discord bot token                          |
| `DISCORD_APPLICATION_ID`     | Yes      | —                          | Discord application ID                     |
| `DISCORD_GUILD_ID`           | Yes      | —                          | The only server this instance serves       |
| `PUBLIC_BASE_URL`            | Yes      | —                          | Public HTTPS origin for generated RSS URLs |
| `PORT`                       | No       | `3000`                     | HTTP listen port                           |
| `DATABASE_PATH`              | No       | `/data/player-news.sqlite` | SQLite database path                       |
| `POLL_INTERVAL_MINUTES`      | No       | `30`                       | Source polling interval                    |
| `CHANNEL_CATEGORY_NAME`      | No       | `Player Updates`           | Base name for channel categories           |
| `CHANNEL_DELETE_GRACE_HOURS` | No       | `72`                       | Empty-channel retention period             |
| `SOURCE_REQUEST_DELAY_MS`    | No       | `1000`                     | Minimum delay between source requests      |
| `SOURCE_REQUEST_TIMEOUT_MS`  | No       | `15000`                    | Per-request timeout                        |
| `SOURCE_MAX_RETRIES`         | No       | `2`                        | Retry count for temporary source failures  |
| `SOURCE_MAX_CATCHUP_PAGES`   | No       | `10`                       | Maximum pages fetched while catching up    |
| `LOG_LEVEL`                  | No       | `info`                     | Structured log level                       |

RSS URLs are bearer secrets. Do not publish them or place them in logs. Use
`/player rss action:rotate` if a URL is exposed; the previous URL stops working
immediately.

## Data, backups, and upgrades

SQLite, RSS tokens, deletion deadlines, delivery state, and feed history live under
`/data`. Only run one application replica against this volume. The Compose file gives
the volume the stable name `player-news-data`; override it with `DATA_VOLUME_NAME` if
needed.

For a consistent backup, stop the service before archiving the volume:

```bash
mkdir -p backups
docker compose stop player-news-bot
docker run --rm --read-only \
  --volume player-news-data:/data:ro \
  --volume "$PWD/backups":/backup \
  node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d \
  tar -czf "/backup/player-news-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" -C /data .
docker compose start player-news-bot
```

Before upgrading, create a backup, pin `IMAGE_NAME` to the desired release tag or
digest, then run `docker compose pull && docker compose up -d`. Database migrations are
forward-only and run automatically. Rolling back application code may require restoring
the matching pre-upgrade database backup.

## Development

Node.js 24 and npm are required when developing without Docker.

```bash
npm ci
npm run format
npm run lint
npm run typecheck
npm run test:coverage
npm run build
```

Tests use local HTML fixtures, temporary SQLite databases, fake clocks, and Discord test
doubles. They never require Discord credentials or live LigaInsider requests.

The legacy `base/` directory is deliberately ignored by Git and Docker and must never be
committed.

## License

MIT
