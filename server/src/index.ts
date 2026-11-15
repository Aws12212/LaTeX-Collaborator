import { existsSync } from 'node:fs'
import path from 'node:path'
import { startServer } from './app.ts'

const root = path.resolve(import.meta.dirname, '..', '..')
const webDist = path.join(root, 'web', 'dist')

const server = await startServer({
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '127.0.0.1',
  dataDir: process.env.DATA_DIR ?? path.join(root, 'data'),
  // Serve the built web app if there is one; in development Vite serves it.
  staticDir: existsSync(webDist) ? webDist : undefined,
})

console.log(`collab-tex server listening on http://localhost:${server.port}`)
if (!server.latexAvailable) {
  console.warn('pdflatex was not found: editing works, but the PDF preview is disabled.')
}

let closing = false
async function shutdown(): Promise<void> {
  if (closing) return
  closing = true
  await server.close() // flushes unsaved documents to disk
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
