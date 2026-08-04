import type BetterSqlite3 from 'better-sqlite3';

interface Migration {
  version: number;
  sql: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE user_feeds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel_id TEXT,
        rss_token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active', 'grace')),
        delete_after TEXT,
        cleanup_started_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (guild_id, user_id),
        CHECK (
          (status = 'active' AND delete_after IS NULL)
          OR (status = 'grace' AND delete_after IS NOT NULL)
        )
      );

      CREATE TABLE players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_url TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        club_image_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE subscriptions (
        user_feed_id INTEGER NOT NULL REFERENCES user_feeds(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_feed_id, player_id)
      );

      CREATE TABLE articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        published_at TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE player_articles (
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        discovered_at TEXT NOT NULL,
        PRIMARY KEY (player_id, article_id)
      );

      CREATE TABLE feed_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_feed_id INTEGER NOT NULL REFERENCES user_feeds(id) ON DELETE CASCADE,
        article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        added_at TEXT NOT NULL,
        UNIQUE (user_feed_id, article_id)
      );

      CREATE TABLE feed_item_players (
        feed_item_id INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        PRIMARY KEY (feed_item_id, player_id)
      );

      CREATE TABLE discord_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_feed_id INTEGER NOT NULL REFERENCES user_feeds(id) ON DELETE CASCADE,
        event_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        discord_message_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX subscriptions_player_idx ON subscriptions(player_id);
      CREATE INDEX user_feeds_cleanup_idx ON user_feeds(status, delete_after);
      CREATE INDEX player_articles_article_idx ON player_articles(article_id);
      CREATE INDEX feed_items_feed_order_idx
        ON feed_items(user_feed_id, added_at DESC, id DESC);
      CREATE INDEX feed_item_players_player_idx ON feed_item_players(player_id);
      CREATE INDEX discord_outbox_due_idx
        ON discord_outbox(status, next_attempt_at, id);
    `,
  },
];

export const latestSchemaVersion = migrations.at(-1)?.version ?? 0;

export function runMigrations(database: BetterSqlite3.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => (row as { version: number }).version),
  );
  const unsupportedVersion = [...applied].find((version) => version > latestSchemaVersion);
  if (unsupportedVersion !== undefined) {
    throw new Error(
      `Database schema version ${unsupportedVersion} is newer than supported version ${latestSchemaVersion}.`,
    );
  }

  const apply = database.transaction((migration: Migration) => {
    database.exec(migration.sql);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(migration.version, new Date().toISOString());
  });

  for (const migration of migrations) {
    if (!applied.has(migration.version)) {
      apply(migration);
    }
  }
}
