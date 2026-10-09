// Local process supervisor: launches 3 API instances (3001/3002/3003), 2 persist workers (w1/w2)
// and 1 reconciler as plain `node` child processes, prefixes every log line with [name], restarts a
// child that crashes (with backoff) and kills everything on Ctrl+C. Cross-platform (Windows, macOS,
// Linux): no shell, no signals that Windows lacks - just child_process.spawn(process.execPath).
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const API_PORTS = (process.env.API_PORTS || '3001,3002,3003').split(',').map((p) => p.trim()).filter(Boolean);

/** Everything we supervise. `env` is merged over the parent's env (which may come from .env). */
const PROCESSES = [
  ...API_PORTS.map((port) => ({ name: `api-${port}`, script: 'src/server.js', env: { PORT: port } })),
  { name: 'persist-w1', script: 'worker/persist.js', env: { WORKER_ID: 'w1' } },
  { name: 'persist-w2', script: 'worker/persist.js', env: { WORKER_ID: 'w2' } },
  { name: 'reconciler', script: 'worker/reconciler.js', env: {} },
];

const COLORS = ['\x1b[36m', '\x1b[32m', '\x1b[33m', '\x1b[35m', '\x1b[34m', '\x1b[91m', '\x1b[92m'];
const RESET = '\x1b[0m';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const PAD = Math.max(...PROCESSES.map((p) => p.name.length));

const children = new Map(); // name -> ChildProcess
let shuttingDown = false;

/** Write stream data to our stdout one line at a time, each prefixed with [name]. */
function pipeWithPrefix(stream, name, color, target) {
  let buffer = '';
  const prefix = useColor ? `${color}[${name.padEnd(PAD)}]${RESET} ` : `[${name.padEnd(PAD)}] `;
  const ownTag = `[${name}] `; // processes tag their own lines too; avoid "[api-3001] [api-3001] ..."
  const emit = (line) => target.write(prefix + (line.startsWith(ownTag) ? line.slice(ownTag.length) : line) + '\n');
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      emit(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  });
  stream.on('end', () => { if (buffer) emit(buffer); });
}

function start(proc, attempt = 0) {
  if (shuttingDown) return;
  const color = COLORS[PROCESSES.indexOf(proc) % COLORS.length];
  const startedAt = Date.now();

  const child = spawn(process.execPath, [path.join(ROOT, proc.script)], {
    cwd: ROOT,
    env: { ...process.env, ...proc.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.set(proc.name, child);
  pipeWithPrefix(child.stdout, proc.name, color, process.stdout);
  pipeWithPrefix(child.stderr, proc.name, color, process.stderr);
  console.log(`[start-all] ${proc.name} started (pid ${child.pid})`);

  child.on('exit', (code, signal) => {
    children.delete(proc.name);
    if (shuttingDown) return;
    // First restart after 1 s; if the child keeps dying quickly (< 30 s), back off 2 s, 4 s, ... 10 s.
    const stable = Date.now() - startedAt > 30000;
    const nextAttempt = stable ? 0 : attempt + 1;
    const delay = stable ? 1000 : Math.min(1000 * 2 ** attempt, 10000);
    console.error(`[start-all] ${proc.name} exited (code=${code}, signal=${signal}); restarting in ${delay} ms`);
    setTimeout(() => start(proc, nextAttempt), delay);
  });
  child.on('error', (err) => {
    console.error(`[start-all] ${proc.name} failed to spawn: ${err.message}`);
  });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[start-all] ${signal} received, stopping ${children.size} children...`);
  for (const child of children.values()) {
    try { child.kill('SIGTERM'); } catch (_) { /* already gone */ } // on Windows this terminates
  }
  const deadline = setTimeout(() => {
    for (const child of children.values()) {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }
    process.exit(0);
  }, 4000).unref();
  const check = setInterval(() => {
    if (children.size === 0) {
      clearInterval(check);
      clearTimeout(deadline);
      console.log('[start-all] all children stopped');
      process.exit(0);
    }
  }, 100);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
if (process.platform !== 'win32') process.on('SIGHUP', () => shutdown('SIGHUP'));

console.log(`[start-all] launching ${PROCESSES.length} processes from ${ROOT} (Ctrl+C stops all)`);
for (const proc of PROCESSES) start(proc);
