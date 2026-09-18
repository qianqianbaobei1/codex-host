import { rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { HarnessThinkingOptionId, HarnessPermissionModeId } from "@codexhost/shared-contracts";
import type { AntigravityCliTransportLike } from "./antigravity-adapter.js";
import type { AntigravityInitEvent, AntigravityTransportOptions } from "./transport.js";

export const DEFAULT_DRAFT_RESERVATION_TTL_MS = 3 * 60 * 1000; // 3 minutes

export interface DraftReservationKeyParams {
  cwd: string;
  model: string;
  accountId?: string | undefined;
  thinkingOptionId?: HarnessThinkingOptionId | undefined;
  permissionModeId?: HarnessPermissionModeId | undefined;
}

export interface PreparedDraftReservation {
  readonly key: string;
  readonly params: DraftReservationKeyParams;
  readonly transport: AntigravityCliTransportLike;
  readonly startPromise: Promise<AntigravityInitEvent>;
  readonly createdAt: number;
  conversationId?: string | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

export function buildDraftReservationKey(params: DraftReservationKeyParams): string {
  return [
    params.cwd,
    params.model,
    params.accountId ?? "default",
    params.thinkingOptionId ?? "default-effort",
    params.permissionModeId ?? "default-perms",
  ].join("\0");
}

/**
 * Remove the native sqlite databases, brain directory, and presence lock created
 * by an abandoned/evacuated Antigravity CLI process.
 */
export function purgeAntigravitySessionFiles(
  storeRoots: readonly string[],
  conversationId: string,
): void {
  if (
    !conversationId ||
    typeof conversationId !== "string" ||
    !/^[A-Za-z0-9._~-]+$/u.test(conversationId)
  ) {
    return;
  }
  for (const storeRoot of storeRoots) {
    // 1. conversations/<uuid>.db, -wal, -shm
    const convDir = path.join(storeRoot, "conversations");
    for (const ext of [".db", ".db-wal", ".db-shm"]) {
      try {
        unlinkSync(path.join(convDir, `${conversationId}${ext}`));
      } catch {
        // ignore absent
      }
    }
    // 2. brain/<uuid>/
    try {
      rmSync(path.join(storeRoot, "brain", conversationId), { recursive: true, force: true });
    } catch {
      // ignore absent
    }
    // 3. presence/<uuid>.lock
    try {
      unlinkSync(path.join(storeRoot, "presence", `${conversationId}.lock`));
    } catch {
      // ignore absent
    }
    // 4. annotations/<uuid>
    try {
      rmSync(path.join(storeRoot, "annotations", conversationId), { recursive: true, force: true });
    } catch {
      // ignore absent
    }
  }
}

export interface AntigravityDraftReservationPoolOptions {
  ttlMs?: number;
  storeRoots?: readonly string[];
  createTransport: (options: AntigravityTransportOptions) => AntigravityCliTransportLike;
  transportOptionsFactory: (params: DraftReservationKeyParams) => AntigravityTransportOptions;
}

export class AntigravityDraftReservationPool {
  readonly #ttlMs: number;
  readonly #storeRoots: readonly string[];
  readonly #createTransport: (options: AntigravityTransportOptions) => AntigravityCliTransportLike;
  readonly #transportOptionsFactory: (
    params: DraftReservationKeyParams,
  ) => AntigravityTransportOptions;
  readonly #reservations = new Map<string, PreparedDraftReservation>();
  #disposed = false;

  constructor(options: AntigravityDraftReservationPoolOptions) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_DRAFT_RESERVATION_TTL_MS;
    this.#storeRoots = options.storeRoots ?? [];
    this.#createTransport = options.createTransport;
    this.#transportOptionsFactory = options.transportOptionsFactory;
  }

  get size(): number {
    return this.#reservations.size;
  }

  has(params: DraftReservationKeyParams): boolean {
    return this.#reservations.has(buildDraftReservationKey(params));
  }

  /**
   * Start a transport in background for an upcoming draft session.
   * If a reservation for the same key is already in-flight or ready, it is reused.
   */
  reserve(params: DraftReservationKeyParams): PreparedDraftReservation | null {
    if (this.#disposed) return null;
    const key = buildDraftReservationKey(params);
    const existing = this.#reservations.get(key);
    if (existing) {
      return existing;
    }

    // Evacuate any other reservation with the same cwd but different model/account
    // to avoid process / resource pileup
    for (const [otherKey, otherRes] of this.#reservations) {
      if (otherRes.params.cwd === params.cwd) {
        this.#evacuate(otherKey, otherRes);
      }
    }

    try {
      const transportOpts = this.#transportOptionsFactory(params);
      const transport = this.#createTransport(transportOpts);
      const startPromise = transport.start();

      const reservation: PreparedDraftReservation = {
        key,
        params,
        transport,
        startPromise,
        createdAt: Date.now(),
      };

      startPromise
        .then((init) => {
          reservation.conversationId = init.conversationId;
        })
        .catch(() => {
          // If start fails, remove from pool
          if (this.#reservations.get(key) === reservation) {
            this.#reservations.delete(key);
          }
        });

      // Setup lease timeout
      reservation.timer = setTimeout(() => {
        if (this.#reservations.get(key) === reservation) {
          this.#evacuate(key, reservation);
        }
      }, this.#ttlMs);

      this.#reservations.set(key, reservation);
      return reservation;
    } catch {
      return null;
    }
  }

  /**
   * Claim an active reservation matching the launch parameters.
   * If claimed, it is removed from the reservation pool and its timer is cancelled,
   * handing full ownership over to the caller.
   */
  claim(params: DraftReservationKeyParams): PreparedDraftReservation | null {
    if (this.#disposed) return null;
    const key = buildDraftReservationKey(params);
    const reservation = this.#reservations.get(key);
    if (!reservation) return null;

    this.#reservations.delete(key);
    if (reservation.timer) {
      clearTimeout(reservation.timer);
      reservation.timer = undefined;
    }
    return reservation;
  }

  /**
   * Release and cleanly evacuate a reservation when the user navigates away or switches.
   */
  release(params: DraftReservationKeyParams): void {
    const key = buildDraftReservationKey(params);
    const reservation = this.#reservations.get(key);
    if (reservation) {
      this.#evacuate(key, reservation);
    }
  }

  async close(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const all = Array.from(this.#reservations.entries());
    this.#reservations.clear();
    await Promise.allSettled(all.map(([k, r]) => this.#evacuate(k, r)));
  }

  #evacuate(key: string, reservation: PreparedDraftReservation): void {
    this.#reservations.delete(key);
    if (reservation.timer) {
      clearTimeout(reservation.timer);
      reservation.timer = undefined;
    }
    void (async () => {
      try {
        await reservation.transport.close();
      } catch {
        // ignore close error
      }
      // Purge leaked disk files once closed
      const convId = reservation.conversationId ?? reservation.transport.conversationId;
      if (convId) {
        purgeAntigravitySessionFiles(this.#storeRoots, convId);
      }
    })();
  }
}
