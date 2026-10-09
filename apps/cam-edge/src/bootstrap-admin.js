import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { openDatabase } from '../../../libs/cam-sqlite/src/database.js';
import { AuthStore } from './auth-store.js';

// Only available from the host/container terminal. Never expose initialization over HTTP.
if (!process.stdin.isTTY) throw new Error('请在交互终端执行初始化（Docker 使用 exec -it）');
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const username = await terminal.question('初始管理员用户名：');
const displayName = await terminal.question('显示姓名：');
terminal.close();
async function secret(prompt) {
  process.stdout.write(prompt);
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    function input(data) {
      for (const char of data.toString()) {
        if (char === '\u0003') { finish(); reject(new Error('已取消')); return; }
        if (char === '\r' || char === '\n') { finish(); resolve(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    }
    function finish() { process.stdin.off('data', input); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); }
    process.stdin.on('data', input);
  });
}
const password = await secret('初始密码（隐藏输入，至少 12 个字符）：');
if (password !== await secret('再次输入：')) throw new Error('两次密码不一致');
const db = await openDatabase(join(process.env.DATA_DIR ?? join(process.cwd(), 'data', 'edge'), 'edge.sqlite'));
try {
  const user = await new AuthStore(db).createUser({ username, displayName, password, roles: ['EDGE_ADMIN', 'CANDIDATE_RECEIVER', 'VALIDATOR', 'RELEASE_APPLICANT'] }, null, { bootstrap: true });
  console.log(`已创建 ${user.username}；首次登录须修改密码。初始账号显式授予管理、接收、验证和发布申请角色，请后续拆分职责。`);
} finally { db.close(); }
