import { closeSync, fstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const SECRET_KEY = /(password|passwd|secret|token|authorization|cookie|private.?key|shared.?key|access.?key)/iu;

function redact(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

function sanitizeLine(line) {
  try {
    const parsed = JSON.parse(line);
    return `${JSON.stringify(redact(parsed))}\n`;
  } catch {
    return line;
  }
}

/**
 * Fastify/Pino-compatible synchronous stream with bounded JSONL files.
 * Keeping this dependency-free makes the log collector usable in the offline
 * image and gives Core/Edge/Agent a common, redacted source of runtime logs.
 */
export function createRollingLogStream({ service, dir = process.env.CAM_LOG_DIR, maxBytes = Number(process.env.CAM_LOG_MAX_BYTES ?? 50 * 1024 * 1024), maxFiles = Number(process.env.CAM_LOG_MAX_FILES ?? 5), stdout = true } = {}) {
  if (!dir) return { write: (chunk) => { if (stdout) process.stdout.write(chunk); }, close() {} };
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  const base = join(dir, `${service}.jsonl`);
  let fd = openSync(base, 'a', 0o640);
  let size = fstatSync(fd).size;
  const rotate = () => {
    closeSync(fd);
    for (let index = Math.max(1, maxFiles - 1); index >= 1; index -= 1) {
      const source = `${base}.${index}`;
      const target = `${base}.${index + 1}`;
      if (index + 1 >= maxFiles) { try { unlinkSync(source); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      else { try { renameSync(source, target); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
    try { renameSync(base, `${base}.1`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fd = openSync(base, 'a', 0o640);
    size = fstatSync(fd).size;
  };
  return {
    write(chunk) {
      const line = sanitizeLine(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      if (stdout) process.stdout.write(line);
      const bytes = Buffer.byteLength(line);
      if (size + bytes > maxBytes && size > 0) rotate();
      writeSync(fd, line);
      size += bytes;
    },
    close() { try { closeSync(fd); } catch {} }
  };
}

export function listLogFiles(dir, service) {
  if (!dir) return [];
  const prefix = `${service}.jsonl`;
  try {
    return readFileSync(join(dir, prefix), 'utf8') ? [join(dir, prefix)] : [];
  } catch { return []; }
}
