import type { PlayerCandidate } from './contracts.js';
import { createSessionId } from './runtime.js';

interface InteractionSessionBase {
  id: string;
  guildId: string;
  userId: string;
  expiresAt: number;
}

export interface AddPlayerSession extends InteractionSessionBase {
  kind: 'add-player';
  players: readonly PlayerCandidate[];
}

export interface ClearPlayersSession extends InteractionSessionBase {
  kind: 'clear-players';
}

export interface RotateRssSession extends InteractionSessionBase {
  kind: 'rotate-rss';
}

export type InteractionSession = AddPlayerSession | ClearPlayersSession | RotateRssSession;
export type NewInteractionSession = InteractionSession extends infer Session
  ? Session extends InteractionSession
    ? Omit<Session, 'id' | 'expiresAt'>
    : never
  : never;

type NewAddPlayerSession = Omit<AddPlayerSession, 'id' | 'expiresAt'>;
type NewClearPlayersSession = Omit<ClearPlayersSession, 'id' | 'expiresAt'>;
type NewRotateRssSession = Omit<RotateRssSession, 'id' | 'expiresAt'>;

export class InteractionSessionStore {
  readonly #sessions = new Map<string, InteractionSession>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1_000,
    private readonly now = (): number => Date.now(),
  ) {}

  create(session: NewAddPlayerSession): AddPlayerSession;
  create(session: NewClearPlayersSession): ClearPlayersSession;
  create(session: NewRotateRssSession): RotateRssSession;
  create(session: NewInteractionSession): InteractionSession {
    this.prune();
    const stored = {
      ...session,
      id: createSessionId(),
      expiresAt: this.now() + this.ttlMs,
    } as InteractionSession;
    this.#sessions.set(stored.id, stored);
    return stored;
  }

  get(id: string): InteractionSession | null {
    const session = this.#sessions.get(id);
    if (!session) {
      return null;
    }

    if (session.expiresAt <= this.now()) {
      this.#sessions.delete(id);
      return null;
    }

    return session;
  }

  consume(id: string): InteractionSession | null {
    const session = this.get(id);
    if (session) {
      this.#sessions.delete(id);
    }
    return session;
  }

  prune(): void {
    const now = this.now();
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(id);
      }
    }
  }
}
