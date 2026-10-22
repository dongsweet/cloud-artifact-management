import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { openDatabase } from '../../../libs/cam-sqlite/src/database.js';
import { AuthStore } from './auth.js';

if (!process.stdin.isTTY) throw new Error('请在交互终端执行初始化（Docker 使用 exec -it）');

const dataDir = process.env.DATA_DIR ?? (process.env.NODE_ENV === 'production' ? '/data/core' : join(process.cwd(), 'data', 'core'));
const db = await openDatabase(join(dataDir, 'core.sqlite'));
const auth = new AuthStore(db);
const users = auth.listUsers();
if (users.some((user) => user.status === 'ACTIVE' && user.roles.includes('CORE_SECURITY_ADMIN'))) {
  db.close();
  throw new Error('已经存在有效的 Core 安全管理员，无需重复初始化');
}

const terminal = createInterface({ input: process.stdin, output: process.stdout });
const username = await terminal.question('Core 安全管理员用户名：');
const displayName = await terminal.question('显示姓名：');
terminal.close();

async function secret(prompt) {
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      process.stdin.off('data', input);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const input = (data) => {
      for (const char of data.toString()) {
        if (char === '\u0003') {
          finish();
          reject(new Error('已取消'));
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', input);
  });
}

try {
  const password = await secret('初始密码（隐藏输入，至少 12 个字符）：');
  const confirm = await secret('再次输入：');
  if (password !== confirm) throw new Error('两次密码不一致');
  const user = await auth.createUser({ username, displayName, password, roles: ['CORE_SECURITY_ADMIN'] });
  console.log(`已创建 Core 安全管理员 ${user.username}；首次登录须修改密码。`);
} finally {
  db.close();
}
