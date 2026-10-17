import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const VERSION = 1;
const INFO = Buffer.from('cam-gate-key-rotation-v1');
const canonical = (value) => JSON.stringify(value);
const fingerprint = (key) => createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex');
const keyId = () => `GK-${Date.now()}-${randomBytes(8).toString('hex')}`;

function pair(type) {
  const result = generateKeyPairSync(type);
  return {
    privateKey: result.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: result.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  };
}

function encryptedKey(secret, recipientPublicKey) {
  const ephemeral = generateKeyPairSync('x25519');
  const salt = randomBytes(32);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: createPublicKey(recipientPublicKey) });
  const key = Buffer.from(hkdfSync('sha256', shared, salt, INFO, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return {
    ephemeralPublicKey: ephemeral.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    salt: salt.toString('base64url'), iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url')
  };
}

export class GateKeyring {
  constructor({ filePath, role, now = () => Date.now() }) {
    if (!filePath || !['core', 'edge'].includes(role)) throw new TypeError('filePath and core/edge role are required');
    this.filePath = filePath;
    this.role = role;
    this.now = now;
    this.state = null;
    this.ready = this.#load();
  }

  async #load() {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try { this.state = JSON.parse(await readFile(this.filePath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const signing = pair('ed25519');
      const exchange = pair('x25519');
      this.state = {
        version: VERSION, role: this.role, signing, exchange, trustedPeer: null,
        active: null, previous: null, pending: null,
        rotationIntervalDays: 90, gracePeriodHours: 24, nextRotationAt: null,
        events: [],
        updatedAt: new Date(this.now()).toISOString()
      };
      await this.#save();
    }
    if (this.state.version !== VERSION || this.state.role !== this.role) throw new Error('CAM 网闸密钥环文件版本或安全区不匹配');
    this.state.events ??= [];
    // Retire legacy environment-provisioned keys. Initial keys are established
    // only after both peers trust each other's identity bundles.
    if (this.state.active?.id === 'BOOTSTRAP' || this.state.previous?.id === 'BOOTSTRAP_PREVIOUS') {
      if (this.state.active?.id === 'BOOTSTRAP') this.state.active = null;
      if (this.state.previous?.id === 'BOOTSTRAP_PREVIOUS') this.state.previous = null;
      this.state.nextRotationAt = null;
      this.#event('BOOTSTRAP_SECRET_RETIRED');
      await this.#save();
    }
  }

  async #save() {
    this.state.updatedAt = new Date(this.now()).toISOString();
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
  }

  #event(type, details = {}) {
    this.state.events.unshift({ eventId: keyId(), type, at: new Date(this.now()).toISOString(), ...details });
    this.state.events = this.state.events.slice(0, 200);
  }

  async #ready() { await this.ready; }

  async identity() {
    await this.#ready();
    return {
      role: this.role,
      signingPublicKey: this.state.signing.publicKey,
      exchangePublicKey: this.state.exchange.publicKey,
      signingFingerprint: fingerprint(this.state.signing.publicKey)
    };
  }

  async trustPeer(bundle) {
    await this.#ready();
    if (!bundle || !['core', 'edge'].includes(bundle.role) || bundle.role === this.role) throw Object.assign(new Error('对端身份包无效或安全区角色不匹配'), { code: 'gate_peer_invalid' });
    try {
      createPublicKey(bundle.signingPublicKey);
      createPublicKey(bundle.exchangePublicKey);
    } catch { throw Object.assign(new Error('对端身份包中的公钥格式无效'), { code: 'gate_peer_invalid' }); }
    const actual = fingerprint(bundle.signingPublicKey);
    if (bundle.signingFingerprint && bundle.signingFingerprint !== actual) throw Object.assign(new Error('对端公钥指纹校验失败'), { code: 'gate_peer_invalid' });
    this.state.trustedPeer = { role: bundle.role, signingPublicKey: bundle.signingPublicKey, exchangePublicKey: bundle.exchangePublicKey, signingFingerprint: actual, trustedAt: new Date(this.now()).toISOString() };
    this.#event('PEER_TRUSTED', { peerRole: bundle.role, fingerprint: actual });
    await this.#save();
    return this.status();
  }

  async status() {
    await this.#ready();
    return {
      role: this.role,
      identity: await this.identity(),
      peerTrusted: Boolean(this.state.trustedPeer),
      peerFingerprint: this.state.trustedPeer?.signingFingerprint ?? null,
      keyConfigured: Boolean(this.state.active),
      activeKeyId: this.state.active?.id ?? null,
      previousKeyExpiresAt: this.state.previous?.expiresAt ?? null,
      rotationIntervalDays: this.state.rotationIntervalDays,
      gracePeriodHours: this.state.gracePeriodHours,
      nextRotationAt: this.state.nextRotationAt,
      rotationState: this.state.pending?.status ?? 'IDLE',
      recentEvents: this.state.events.slice(0, 20)
    };
  }

  async configure({ rotationIntervalDays, gracePeriodHours }) {
    await this.#ready();
    if (!Number.isInteger(rotationIntervalDays) || rotationIntervalDays < 1 || rotationIntervalDays > 365) throw Object.assign(new Error('轮换周期必须为 1 到 365 天'), { code: 'gate_rotation_config_invalid' });
    if (!Number.isInteger(gracePeriodHours) || gracePeriodHours < 1 || gracePeriodHours > 168) throw Object.assign(new Error('新旧密钥并行有效期必须为 1 到 168 小时'), { code: 'gate_rotation_config_invalid' });
    this.state.rotationIntervalDays = rotationIntervalDays;
    this.state.gracePeriodHours = gracePeriodHours;
    this.#event('SCHEDULE_UPDATED', { rotationIntervalDays, gracePeriodHours });
    if (this.state.active) this.state.nextRotationAt = new Date(this.now() + rotationIntervalDays * 86400000).toISOString();
    await this.#save();
    return this.status();
  }

  async acceptedSecrets({ includePending = false } = {}) {
    await this.#ready();
    const now = this.now();
    if (this.state.previous?.expiresAt && Date.parse(this.state.previous.expiresAt) <= now) {
      this.state.previous = null;
      await this.#save();
    }
    const pending = this.state.pending?.status === 'CONFIRM_PENDING' || includePending ? this.state.pending : null;
    return [this.state.active, this.state.previous, pending].filter(Boolean).map((item) => ({ id: item.id, secret: Buffer.from(item.secret, 'base64url') }));
  }

  async currentSecret() {
    await this.#ready();
    return this.state.active ? Buffer.from(this.state.active.secret, 'base64url') : null;
  }

  async verifySecret(received, { includePending = false } = {}) {
    if (!Buffer.isBuffer(received) && typeof received !== 'string') return false;
    const actuals = Buffer.isBuffer(received) ? [received] : [Buffer.from(received), Buffer.from(received, 'base64url')];
    for (const item of await this.acceptedSecrets({ includePending })) for (const actual of actuals) {
      const expected = Buffer.from(item.secret);
      if (actual.length === expected.length && timingSafeCompare(actual, expected)) return item.id;
    }
    return false;
  }

  async acceptProposal(envelope) {
    await this.#ready();
    const peer = this.state.trustedPeer;
    if (!peer || this.role !== 'edge') throw Object.assign(new Error('未建立 Core 对端信任，不能接收密钥轮换'), { code: 'gate_peer_not_trusted' });
    const { signature, ...signed } = envelope ?? {};
    if (!signed.keyId || !signed.createdAt || !signed.expiresAt || Date.parse(signed.expiresAt) <= this.now() || Date.parse(signed.createdAt) > this.now() + 5 * 60_000) throw Object.assign(new Error('密钥轮换提案无效或已过期'), { code: 'gate_rotation_expired' });
    if (!verify(null, Buffer.from(canonical(signed)), createPublicKey(peer.signingPublicKey), Buffer.from(signature ?? '', 'base64url'))) throw Object.assign(new Error('密钥轮换提案签名验证失败'), { code: 'gate_rotation_signature_invalid' });
    if (this.state.active?.id === signed.keyId || this.state.pending?.id === signed.keyId) return this.#rotationProof(signed.keyId, this.state.pending?.secret ?? this.state.active.secret, envelope.nonce);
    if (this.state.active && this.state.pending) throw Object.assign(new Error('已有密钥轮换正在等待确认'), { code: 'gate_rotation_in_progress' });
    const shared = diffieHellman({ privateKey: createPrivateKey(this.state.exchange.privateKey), publicKey: createPublicKey(signed.ephemeralPublicKey) });
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(signed.salt, 'base64url'), INFO, 32));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(signed.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(signed.tag, 'base64url'));
    const secret = Buffer.concat([decipher.update(Buffer.from(signed.ciphertext, 'base64url')), decipher.final()]);
    if (secret.length !== 32) throw Object.assign(new Error('密钥轮换提案中的密钥长度无效'), { code: 'gate_rotation_invalid' });
    const pending = { id: signed.keyId, secret: secret.toString('base64url'), expiresAt: signed.expiresAt, status: 'PREPARED', nonce: signed.nonce, previous: this.state.active ? { ...this.state.active } : null };
    this.state.pending = pending;
    this.#event('ROTATION_PROPOSAL_ACCEPTED', { keyId: pending.id });
    await this.#save();
    return this.#rotationProof(pending.id, pending.secret, pending.nonce);
  }

  #rotationProof(id, encodedSecret, nonce) {
    if (!nonce) throw Object.assign(new Error('轮换提案缺少随机挑战值'), { code: 'gate_rotation_invalid' });
    const proof = createHmac('sha256', Buffer.from(encodedSecret, 'base64url')).update(`${id}:${nonce}`).digest('base64url');
    return { keyId: id, nonce, proof };
  }

  async createProposal() {
    await this.#ready();
    const peer = this.state.trustedPeer;
    if (this.role !== 'core' || !peer) throw Object.assign(new Error('尚未建立 Edge 对端信任'), { code: 'gate_peer_not_trusted' });
    if (!this.state.pending || (this.state.pending.status === 'PROPOSAL_PENDING' && Date.parse(this.state.pending.expiresAt) <= this.now())) {
      const secret = this.state.pending ? Buffer.from(this.state.pending.secret, 'base64url') : randomBytes(32);
      const now = this.now();
      const id = this.state.pending?.id ?? keyId();
      const nonce = randomBytes(24).toString('base64url');
      const expiresAt = new Date(now + 15 * 60_000).toISOString();
      const proposal = {
        schemaVersion: 1, keyId: id, createdAt: new Date(now).toISOString(), expiresAt, nonce,
        ...encryptedKey(secret, peer.exchangePublicKey)
      };
      const signature = sign(null, Buffer.from(canonical(proposal)), createPrivateKey(this.state.signing.privateKey)).toString('base64url');
      this.state.pending = { id, secret: secret.toString('base64url'), expiresAt, status: 'PROPOSAL_PENDING', nonce, proposal: { ...proposal, signature } };
      this.#event('ROTATION_PROPOSAL_CREATED', { keyId: id });
      await this.#save();
    }
    return this.state.pending;
  }

  async verifyProof(response) {
    await this.#ready();
    const pending = this.state.pending;
    if (!pending || response?.keyId !== pending.id || response?.nonce !== pending.nonce) throw Object.assign(new Error('Edge 密钥轮换回执与当前提案不匹配'), { code: 'gate_rotation_proof_invalid' });
    const expected = this.#rotationProof(pending.id, pending.secret, pending.nonce).proof;
    if (!timingSafeCompare(Buffer.from(expected), Buffer.from(response.proof ?? ''))) throw Object.assign(new Error('Edge 未证明持有新密钥'), { code: 'gate_rotation_proof_invalid' });
    this.state.active = { id: pending.id, secret: pending.secret, activatedAt: new Date(this.now()).toISOString() };
    this.state.previous = pending.oldActive ?? null;
    this.state.pending = { ...pending, status: 'CONFIRM_PENDING', proposal: undefined, confirmedAt: new Date(this.now()).toISOString() };
    this.#event('ROTATION_ACTIVATED_CORE', { keyId: pending.id, previousKeyId: this.state.previous?.id ?? null });
    this.state.nextRotationAt = new Date(this.now() + this.state.rotationIntervalDays * 86400000).toISOString();
    await this.#save();
    return this.state.pending;
  }

  async prepareProposal() {
    await this.#ready();
    const old = this.state.active ? { ...this.state.active } : null;
    const pending = await this.createProposal();
    if (pending.status === 'PROPOSAL_PENDING' && old && !pending.oldActive) { pending.oldActive = old; this.state.pending.oldActive = old; await this.#save(); }
    return pending;
  }

  async markEdgeConfirmed(id) {
    await this.#ready();
    if (!this.state.pending || this.state.pending.id !== id || this.state.pending.status !== 'CONFIRM_PENDING') throw Object.assign(new Error('密钥轮换确认状态不匹配'), { code: 'gate_rotation_state_invalid' });
    if (this.state.previous) this.state.previous.expiresAt = new Date(this.now() + this.state.gracePeriodHours * 3600000).toISOString();
    this.state.pending = null;
    this.#event('ROTATION_CONFIRMED_CORE', { keyId: id, previousKeyId: this.state.previous?.id ?? null });
    await this.#save();
    return this.status();
  }

  async confirmAtEdge(id) {
    await this.#ready();
    if (this.role !== 'edge') throw Object.assign(new Error('只有 Edge 可以确认轮换密钥'), { code: 'gate_rotation_state_invalid' });
    if (!this.state.pending && this.state.active?.id === id) return this.status();
    if (!this.state.pending || this.state.pending.id !== id) throw Object.assign(new Error('待确认密钥不存在'), { code: 'gate_rotation_state_invalid' });
    if (this.state.active) this.state.previous = { ...this.state.active, expiresAt: new Date(this.now() + this.state.gracePeriodHours * 3600000).toISOString() };
    this.state.active = { id: this.state.pending.id, secret: this.state.pending.secret, activatedAt: new Date(this.now()).toISOString() };
    this.state.pending = null;
    this.#event('ROTATION_CONFIRMED_EDGE', { keyId: id, previousKeyId: this.state.previous?.id ?? null });
    await this.#save();
    return this.status();
  }

  async needsRotation() {
    await this.#ready();
    if (this.role !== 'core' || !this.state.trustedPeer) return false;
    if (this.state.pending) return true;
    return !this.state.active || !this.state.nextRotationAt || Date.parse(this.state.nextRotationAt) <= this.now();
  }
}

function timingSafeCompare(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}
