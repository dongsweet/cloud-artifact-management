import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export class ProgressStore {
  constructor(db) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transfer_tasks (
        transfer_task_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        total_parts INTEGER NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transfer_parts (
        transfer_task_id TEXT NOT NULL,
        part_index INTEGER NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (transfer_task_id, part_index),
        FOREIGN KEY (transfer_task_id) REFERENCES transfer_tasks(transfer_task_id)
      );
    `);
  }

  createTask({ transferTaskId, artifactId, totalParts }) {
    if (!Number.isInteger(totalParts) || totalParts < 0) throw new RangeError('totalParts must be a non-negative integer');
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO transfer_tasks (transfer_task_id, artifact_id, total_parts, status, updated_at) VALUES (?, ?, ?, ?, ?)').run(transferTaskId, artifactId, totalParts, 'PENDING', now);
  }

  markPart({ transferTaskId, partIndex, size, sha256 }) {
    const now = new Date().toISOString();
    const task = this.db.prepare('SELECT total_parts FROM transfer_tasks WHERE transfer_task_id = ?').get(transferTaskId);
    if (!task) throw new Error(`transfer task not found: ${transferTaskId}`);
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= task.total_parts) throw new RangeError('part index out of range');
    if (!Number.isInteger(size) || size < 0) throw new RangeError('part size must be a non-negative integer');
    this.db.prepare(`INSERT INTO transfer_parts (transfer_task_id, part_index, size, sha256, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(transfer_task_id, part_index) DO UPDATE SET size=excluded.size, sha256=excluded.sha256, status=excluded.status, updated_at=excluded.updated_at`).run(transferTaskId, partIndex, size, sha256, 'COMPLETED', now);
    this.db.prepare('UPDATE transfer_tasks SET status = ?, updated_at = ? WHERE transfer_task_id = ?').run('RUNNING', now, transferTaskId);
  }

  completeTask(transferTaskId) {
    const task = this.db.prepare('SELECT total_parts FROM transfer_tasks WHERE transfer_task_id = ?').get(transferTaskId);
    if (!task) throw new Error(`transfer task not found: ${transferTaskId}`);
    const completed = this.db.prepare(
      "SELECT COUNT(*) AS count FROM transfer_parts WHERE transfer_task_id = ? AND status = 'COMPLETED'"
    ).get(transferTaskId).count;
    if (completed !== task.total_parts) throw new Error('cannot complete transfer with missing parts');
    this.db.prepare('UPDATE transfer_tasks SET status = ?, updated_at = ? WHERE transfer_task_id = ?').run('COMPLETED', new Date().toISOString(), transferTaskId);
  }

  getTask(transferTaskId) {
    const task = this.db.prepare('SELECT * FROM transfer_tasks WHERE transfer_task_id = ?').get(transferTaskId);
    if (!task) return null;
    const parts = this.db.prepare('SELECT * FROM transfer_parts WHERE transfer_task_id = ? ORDER BY part_index').all(transferTaskId);
    return { ...task, parts };
  }

  missingParts(transferTaskId) {
    const task = this.db.prepare('SELECT total_parts FROM transfer_tasks WHERE transfer_task_id = ?').get(transferTaskId);
    if (!task) return [];
    const completed = new Set(this.db.prepare(
      "SELECT part_index FROM transfer_parts WHERE transfer_task_id = ? AND status = 'COMPLETED'"
    ).all(transferTaskId).map((row) => row.part_index));
    return Array.from({ length: task.total_parts }, (_, index) => index).filter((index) => !completed.has(index));
  }
}

export async function ensureParent(path) {
  await mkdir(dirname(path), { recursive: true });
}
