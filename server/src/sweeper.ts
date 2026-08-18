import { config } from './config.ts'
import { drops } from './db.ts'
import { destroyDrop } from './uploads.ts'

/** The slice of a Fastify logger the sweeper needs, so tests can pass a stub. */
export interface SweeperLog {
  info(details: object, message: string): void
  error(details: object, message: string): void
}

export interface Sweeper {
  sweep(): Promise<void>
  stop(): void
}

/**
 * Deletes expired drops from R2 and tombstones their rows.
 *
 * Expiry is *enforced* at read time — every route checks `expires_at` before
 * touching storage — so this job is only responsible for reclaiming space. A
 * slow or failed sweep can never leave a link readable past its deadline.
 */
export function startSweeper(log: SweeperLog): Sweeper {
  let inFlight: Promise<void> | null = null

  /** Callers during a sweep join the running pass instead of starting a second. */
  function sweep(): Promise<void> {
    if (!inFlight) {
      inFlight = run().finally(() => {
        inFlight = null
      })
    }
    return inFlight
  }

  async function run(): Promise<void> {
    try {
      const expired = drops.listExpired()
      if (expired.length === 0) return

      let removed = 0
      for (const drop of expired) {
        try {
          await destroyDrop(drop)
          removed += 1
        } catch (err) {
          // Left in place; the next pass retries it.
          log.error({ err, id: drop.id }, 'failed to delete expired drop')
        }
      }

      const purged = drops.purgeTombstones()
      log.info({ removed, purged }, 'swept expired drops')
    } catch (err) {
      log.error({ err }, 'sweep failed')
    }
  }

  void sweep()
  const timer = setInterval(() => void sweep(), config.sweepIntervalMs)
  timer.unref()

  return {
    sweep,
    stop() {
      clearInterval(timer)
    },
  }
}
