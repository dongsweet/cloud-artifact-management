import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { openDatabase } from '../../../libs/cam-sqlite/src/database.js';
import { AuthStore } from './auth.js';

if (!process.stdin.isTTY) throw new Error('请在交互终端执行修复（Docker 使用 exec -it）');

const dataDir = process.env.DATA_DIR ?? (process.env.NODE_ENV === 'production' ? '/data/core' : join(process.cwd(), 'data', 'core'));
const db = await openDatabase(join(dataDir, 'core.sqlite'));
const auth = new AuthStore(db);
const mappings = new Map([
  ['CORE_ADMIN', 'CORE_SYSTEM_ADMIN'],
  ['CORE_CONFIG_ADMIN', 'CORE_SECURITY_ADMIN'],
  ['CORE_USER_ADMIN', 'CORE_SECURITY_ADMIN']
]);
const rows = db.prepare('SELECT user_id, username, display_name, roles_json FROM core_users ORDER BY username').all();
const repairs = [];
for (const row of rows) {
  let roles;
  try { roles = JSON.parse(row.roles_json); } catch { continue; }
  if (!Array.isArray(roles)) continue;
  const next = [...new Set(roles.map((role) => mappings.get(role) ?? role))];
  if (JSON.stringify(next) !== JSON.stringify(roles)) repairs.push({ ...row, before: roles, after: next });
}

if (!repairs.length) {
  console.log('没有发现需要修复的旧 Core 角色。');
  db.close();
} else {
  console.log('将修复以下账号的旧角色：');
  for (const item of repairs) console.log(`- ${item.username}（${item.display_name}）：${item.before.join('、')} → ${item.after.join('、')}`);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const confirmation = await terminal.question('确认修复？请输入 YES：');
  terminal.close();
  if (confirmation !== 'YES') {
    db.close();
    throw new Error('已取消修复');
  }
  try {
    auth.transaction(() => {
      for (const item of repairs) {
        db.prepare('UPDATE core_users SET roles_json = ?, updated_at = ? WHERE user_id = ?').run(JSON.stringify(item.after), new Date().toISOString(), item.user_id);
        auth.event('LEGACY_ROLES_REPAIRED', null, { userId: item.user_id, username: item.username, before: item.before, after: item.after });
      }
    });
    console.log(`已修复 ${repairs.length} 个账号；请重新登录使新角色生效。`);
  } finally {
    db.close();
  }
}
