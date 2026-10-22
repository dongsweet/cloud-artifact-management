import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { openDatabase } from '../../../libs/cam-sqlite/src/database.js';
import { AuthStore } from '../../cam-core/src/core-auth-store.js';

if (!process.stdin.isTTY) throw new Error('请在交互终端执行初始化（Docker 使用 exec -it）');

const dataDir = process.env.DATA_DIR ?? (process.env.NODE_ENV === 'production' ? '/data/agent' : join(process.cwd(), 'data', 'agent'));
const db = await openDatabase(join(dataDir, 'agent.sqlite'));
const auth = new AuthStore(db, { roleSet: 'AGENT' });
const users = auth.listUsers();
if (!users.some((user) => user.status === 'ACTIVE' && user.roles.includes('AGENT_SYSTEM_ADMIN'))) {
  db.close();
  throw new Error('请先创建有效的 Agent 系统管理员');
}
if (users.some((user) => user.status === 'ACTIVE' && user.roles.includes('AGENT_SECURITY_ADMIN'))) {
  db.close();
  throw new Error('已经存在有效的 Agent 安全管理员，无需重复初始化');
}

const terminal = createInterface({ input: process.stdin, output: process.stdout });
const username = await terminal.question('Agent 安全管理员用户名：');
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
        if (char === '\u0003') { finish(); reject(new Error('已取消')); return; }
        if (char === '\r' || char === '\n') { finish(); resolve(value); return; }
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
  const user = await auth.createUser({ username, displayName, password, roles: ['AGENT_SECURITY_ADMIN'] });
  console.log(`已创建 Agent 安全管理员 ${user.username}；首次登录须修改密码。`);
} finally {
  db.close();
}
