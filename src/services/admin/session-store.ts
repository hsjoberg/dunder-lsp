import { EventEmitter } from "events";
import { FastifyRequest } from "fastify";

type StoredSession = FastifyRequest["session"];
type Callback = (err?: any) => void;
type GetCallback = (err: any, result?: StoredSession | null) => void;

interface IEntry {
  session: StoredSession;
  createdAt: number;
  expiresAt: number;
}

export interface IBoundedSessionStoreOptions {
  /** A session is dropped after this much inactivity. */
  idleTimeoutMs: number;
  /** A session is dropped this long after it was created, even if it is in use. */
  absoluteTimeoutMs: number;
  /** Upper bound on stored sessions. The oldest unauthenticated ones are evicted first. */
  maxSessions: number;
  now?: () => number;
}

function isAuthenticated(session: StoredSession) {
  try {
    return typeof session?.get === "function" && session.get<any>("authenticated") === true;
  } catch {
    return false;
  }
}

// Same as @fastify/session's internal getSessionGeneration: a session records
// the ID it was generated under, so a regenerated session can be told apart.
function sessionGeneration(session: StoredSession, sessionId: string): string {
  return (session as any)?.__fastifySessionMetadata?.generation ?? sessionId;
}

/**
 * In-memory session store with idle and absolute expiry and a size cap.
 *
 * @fastify/session's default MemoryStore never removes a session unless it is
 * explicitly destroyed, so every unauthenticated visitor would otherwise grow
 * memory without bound.
 */
export class BoundedSessionStore extends EventEmitter {
  private readonly sessions = new Map<string, IEntry>();
  private readonly now: () => number;

  constructor(private readonly options: IBoundedSessionStoreOptions) {
    super();
    this.now = options.now ?? Date.now;
  }

  get size() {
    return this.sessions.size;
  }

  set(sessionId: string, session: StoredSession, callback: Callback) {
    this.store(sessionId, session);
    callback();
  }

  /**
   * Saves a session that was loaded from the store, only if the stored copy is
   * still the one it was loaded from. A session destroyed or regenerated in the
   * meantime (logout, login) is not brought back.
   */
  compareAndSet(
    sessionId: string,
    expectedGeneration: string,
    session: StoredSession,
    callback: Callback,
  ) {
    const entry = this.sessions.get(sessionId);
    if (
      !entry ||
      entry.expiresAt <= this.now() ||
      sessionGeneration(entry.session, sessionId) !== expectedGeneration
    ) {
      const error: NodeJS.ErrnoException = new Error("The session does not exist or has changed");
      error.code = "ENOENT";
      callback(error);
      return;
    }
    this.store(sessionId, session);
    callback();
  }

  private store(sessionId: string, session: StoredSession) {
    const now = this.now();
    const existing = this.sessions.get(sessionId);
    const createdAt = existing?.createdAt ?? now;
    // Re-insert so Map iteration order reflects the least recently saved session.
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, {
      session,
      createdAt,
      expiresAt: Math.min(now + this.options.idleTimeoutMs, createdAt + this.options.absoluteTimeoutMs),
    });
    this.sweep(now);
  }

  get(sessionId: string, callback: GetCallback) {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      callback(null, null);
      return;
    }
    if (entry.expiresAt <= this.now()) {
      this.sessions.delete(sessionId);
      callback(null, null);
      return;
    }
    callback(null, entry.session);
  }

  destroy(sessionId: string, callback: Callback) {
    this.sessions.delete(sessionId);
    callback();
  }

  private sweep(now: number) {
    for (const [sessionId, entry] of this.sessions) {
      if (entry.expiresAt <= now) {
        this.sessions.delete(sessionId);
      }
    }

    if (this.sessions.size <= this.options.maxSessions) {
      return;
    }
    for (const [sessionId, entry] of this.sessions) {
      if (this.sessions.size <= this.options.maxSessions) {
        return;
      }
      if (!isAuthenticated(entry.session)) {
        this.sessions.delete(sessionId);
      }
    }
    for (const sessionId of this.sessions.keys()) {
      if (this.sessions.size <= this.options.maxSessions) {
        return;
      }
      this.sessions.delete(sessionId);
    }
  }
}
