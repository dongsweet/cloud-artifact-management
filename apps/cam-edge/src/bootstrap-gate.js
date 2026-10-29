import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openDatabase } from '../../../libs/cam-sqlite/src/database.js';
import { GateConfigStore } from '../../../libs/cam-gate/src/config.js';
import { GateKeyring } from '../../../libs/cam-gate/src/keyring.js';

const dataDir = process.env.DATA_DIR ?? (process.env.NODE_ENV === 'production' ? '/data/edge' : join(process.cwd(), 'data', 'edge'));
const usage = `用法：
  node apps/cam-edge/src/bootstrap-gate.js
  node apps/cam-edge/src/bootstrap-gate.js --print-identity

说明：
  该命令用于 Edge 首次登录前初始化 Core 地址和 Core 身份信任。
  私钥只保存在 Edge 数据目录，任何情况下都不会显示或导出。
`;

async function parseBundle(text) {
  const value = text.trim();
  if (!value) return null;
  if (value.startsWith('@')) return JSON.parse(await readFile(resolve(value.slice(1)), 'utf8'));
  return JSON.parse(value);
}

async function askLine(rl, label, fallback = '') {
  const suffix = fallback ? `（回车保持 ${fallback}）` : '';
  const value = (await rl.question(`${label}${suffix}：`)).trim();
  return value || fallback;
}

async function askBundle(rl) {
  let text = (await rl.question('Core 身份公钥包（JSON、@/绝对路径；暂时跳过请输入 -）：')).trim();
  if (!text || text === '-') return text;
  // The Core page displays a pretty-printed JSON bundle. readline.question()
  // returns its first line, so keep reading until the pasted JSON becomes
  // complete. A bounded loop prevents malformed input from waiting forever.
  if (!text.startsWith('{') && !text.startsWith('[') && !text.startsWith('@')) return text;
  if (text.startsWith('@')) return text;
  for (let lineCount = 1; lineCount < 256 && text.length <= 64 * 1024; lineCount += 1) {
    try { JSON.parse(text); return text; } catch {
      text += `\n${await rl.question('')}`;
    }
  }
  throw new Error('Core 身份公钥包不是有效的 JSON，或内容过长');
}

const db = await openDatabase(join(dataDir, 'edge.sqlite'));
const gateConfig = new GateConfigStore(db, {
  table: 'edge_gate_config',
  eventsTable: 'edge_gate_config_events',
  requiredUrlFields: ['coreControlUrl', 'coreTransferUrl']
});
const keyring = new GateKeyring({ filePath: join(dataDir, 'gate-keyring.json'), role: 'edge' });
await keyring.ready;

try {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(usage);
  } else {
    const identityBundle = await keyring.identity();
    process.stdout.write('Edge 身份公钥包（请复制到 Core 的网闸身份登记处；不含私钥）：\n');
    process.stdout.write(`${JSON.stringify(identityBundle, null, 2)}\n\n`);
    if (!process.argv.includes('--print-identity')) {
      const current = gateConfig.get();
      const rl = createInterface({ input, output });
      try {
        const coreControlUrl = await askLine(rl, 'Core 控制地址（外侧）', current.coreControlUrl);
        const coreTransferUrl = await askLine(rl, 'Core 制品传输地址（外侧）', current.coreTransferUrl || coreControlUrl);
        if (!coreControlUrl || !coreTransferUrl) throw new Error('Core 控制地址和制品传输地址都不能为空');
        const saved = gateConfig.save({ ...current, coreControlUrl, coreTransferUrl }, 'bootstrap-gate');
        process.stdout.write(`已保存 Core 地址：控制 ${saved.coreControlUrl}；传输 ${saved.coreTransferUrl}\n`);

        const bundleText = await askBundle(rl);
        if (bundleText && bundleText !== '-') {
          const bundle = await parseBundle(bundleText);
          await keyring.trustPeer(bundle);
          process.stdout.write('已保存 Core 对端身份。请确认 Edge 公钥已经登记到 Core，再按回车执行配对测试。\n');
          await rl.question('继续测试（回车继续）：');
          const path = '/api/v1/gate/pairing-probe';
          const response = await fetch(`${saved.coreControlUrl.replace(/\/$/u, '')}${path}`, { headers: await keyring.requestHeaders('GET', path, '', { accept: 'application/json' }), signal: AbortSignal.timeout(saved.connectTimeoutMs) });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || result.role !== 'core' || result.businessReady !== true || result.peerFingerprint !== identityBundle.signingFingerprint) throw new Error(result.error?.message ?? `Core 配对测试失败（HTTP ${response.status}）`);
          await keyring.markPeerConfirmed();
          process.stdout.write('Core/Edge 身份配对成功，现在可以登录 Edge。\n');
        } else {
          process.stdout.write('已保存地址。请先把上面的 Edge 身份公钥登记到 Core，再重新运行本命令导入 Core 身份公钥包。\n');
        }
      } finally { rl.close(); }
    }
  }
} catch (error) {
  process.stderr.write(`初始化失败：${error.message}\n`);
  process.exitCode = 1;
} finally {
  await db.close();
}
