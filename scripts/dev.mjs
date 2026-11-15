// Starts the sync/compile server and the Vite dev server together.
// Spawns `node` directly (not npm) so it behaves the same on Windows and Unix.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The API server gets its own port. Some launchers set PORT for the web
// server, so it is deliberately not inherited here.
const serverPort = process.env.SERVER_PORT ?? '4000'

const procs = [
  spawn(process.execPath, ['--watch', 'src/index.ts'], {
    cwd: path.join(root, 'server'),
    stdio: 'inherit',
    env: { ...process.env, PORT: serverPort },
  }),
  spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')], {
    cwd: path.join(root, 'web'),
    stdio: 'inherit',
    env: { ...process.env, SERVER_URL: `http://127.0.0.1:${serverPort}` },
  }),
]

let stopping = false
function stop(code) {
  if (stopping) return
  stopping = true
  for (const p of procs) p.kill()
  process.exit(code)
}

for (const p of procs) p.on('exit', (code) => stop(code ?? 0))
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
