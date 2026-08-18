import { config, assertConfig } from './config.ts'
import { buildApp } from './app.ts'
import { startSweeper } from './sweeper.ts'
import { checkConnection } from './r2.ts'
import { closeDatabase } from './db.ts'

try {
  assertConfig()
} catch (err) {
  console.error((err as Error).message)
  console.error('\nCopy .env.example to .env and fill it in.')
  process.exit(1)
}

const app = await buildApp()

try {
  await checkConnection()
  app.log.info({ bucket: config.r2.bucket }, 'connected to R2')
} catch (err) {
  app.log.error({ err }, 'could not reach the R2 bucket — check R2_* credentials')
  process.exit(1)
}

const sweeper = startSweeper(app.log)

await app.listen({ port: config.port, host: config.host })
app.log.info({ app: config.appOrigin, content: config.contentOrigin }, 'drop is up')

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, 'shutting down')

    void (async () => {
      sweeper.stop()
      await app.close()
      closeDatabase()
      process.exit(0)
    })()
  })
}
