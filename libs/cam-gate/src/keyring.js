import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { signGateRequest, verifyGateRequest } from './request-auth.js';

const VERSION = 1;
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

export class GateKeyring {
  constructor({ filePath, role, now = () => Date.now() }) {
    if (!filePath || !['core', 'edge'].includes(role)) throw new TypeError('filePath and core/edge role are required');
    this.filePath = filePath;
    this.role = role;
    this.now = now;
    this.state = null;
    this.saves = Promise.resolve();
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
        rotationIntervalDays: 90, gracePeriodHours: 24, identityEstablishedAt: new Date(this.now()).toISOString(), nextRotationAt: new Date(this.now() + 90 * 86400000).toISOString(),
        events: [], requestNonces: [],
        updatedAt: new Date(this.now()).toISOString()
      };
      await this.#save();
    }
    if (this.state.version !== VERSION || this.state.role !== this.role) throw new Error('CAM 网闸密钥环文件版本或安全区不匹配');
    this.state.events ??= [];
    this.state.requestNonces ??= [];
    this.state.rotationFailureAttempts ??= 0;
    this.state.identityEstablishedAt ??= this.state.updatedAt ?? new Date(this.now()).toISOString();
    this.state.rotationIntervalDays ??= 90;
    this.state.nextRotationAt ??= new Date(Date.parse(this.state.identityEstablishedAt) + this.state.rotationIntervalDays * 86400000).toISOString();
    // Older interrupted rotations did not assign a retirement deadline until
    // confirmation. Bound it from activation rather than extending it on restart.
    if (this.state.previous && !Number.isFinite(Date.parse(this.state.previous.expiresAt))) {
      const activatedAt = Date.parse(this.state.active?.activatedAt);
      this.state.previous.expiresAt = new Date((Number.isFinite(activatedAt) ? activatedAt : 0) + this.state.gracePeriodHours * 3600000).toISOString();
      await this.#save();
    }
    // Replace the old negotiated shared-secret model with request signatures
    // from each peer's pinned Ed25519 identity. Remove legacy secrets at startup.
    if (this.state.active || this.state.previous || this.state.pending) {
      this.state.active = this.state.previous = this.state.pending = null;
      this.#event('SHARED_SECRETS_RETIRED');
      await this.#save();
    }
  }

  async #save() {
    this.state.updatedAt = new Date(this.now()).toISOString();
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    const save = this.saves.then(() => this.#write(snapshot));
    this.saves = save.catch(() => {});
    return save;
  }

  async #write(snapshot) {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, snapshot, { mode: 0o600 });
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

  async requestHeaders(method, path, body = '', headers = {}, options = {}) {
    await this.#ready();
    const identity = await this.identity();
    return {
      ...headers,
      'x-cam-gate-key-id': identity.signingFingerprint,
      ...signGateRequest(this.state.signing.privateKey, method, path, body, options)
    };
  }

  async sealForPeer(value) {
    await this.#ready();
    const peer = this.state.trustedPeer;
    if (!peer) throw new Error('尚未建立对端身份信任');
    const ephemeral = pair('x25519');
    const shared = diffieHellman({ privateKey: createPrivateKey(ephemeral.privateKey), publicKey: createPublicKey(peer.exchangePublicKey) });
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from('CAM-GATE-AUTH-v1'), Buffer.from('cam-core-edge-auth'), 32));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))), cipher.final()]);
    return { schemaVersion: 1, ephemeralPublicKey: ephemeral.publicKey, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
  }

  async openFromPeer(envelope) {
    await this.#ready();
    const peer = this.state.trustedPeer;
    if (!peer || envelope?.schemaVersion !== 1) throw new Error('加密认证请求无效');
    const shared = diffieHellman({ privateKey: createPrivateKey(this.state.exchange.privateKey), publicKey: createPublicKey(envelope.ephemeralPublicKey) });
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from('CAM-GATE-AUTH-v1'), Buffer.from('cam-core-edge-auth'), 32));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
  }

  async signAssertion(payload) {
    await this.#ready();
    return { payload, signature: sign(null, Buffer.from(canonical(payload)), createPrivateKey(this.state.signing.privateKey)).toString('base64url') };
  }

  async verifyPeerAssertion(assertion) {
    await this.#ready();
    try { return Boolean(this.state.trustedPeer && verify(null, Buffer.from(canonical(assertion.payload)), createPublicKey(this.state.trustedPeer.signingPublicKey), Buffer.from(assertion.signature, 'base64url'))); }
    catch { return false; }
  }

  async verifyRequest({ method, path, headers, body = '', bodyDigest } = {}) {
    await this.#ready();
    const peer = this.state.trustedPeer;
    if (!peer) return false;
    const keyId = headers?.['x-cam-gate-key-id'];
    const timestamp = headers?.['x-cam-gate-timestamp'];
    const nonce = headers?.['x-cam-gate-nonce'];
    const digest = headers?.['x-cam-gate-content-sha256'];
    const allowedKeys = [{ fingerprint: peer.signingFingerprint, publicKey: peer.signingPublicKey, current: true }];
    if (peer.previousSigningFingerprint && (peer.rotationAwaitingConfirmation && !peer.newKeySeenAt || peer.previousKeyExpiresAt && Date.parse(peer.previousKeyExpiresAt) > this.now())) allowedKeys.push({ fingerprint: peer.previousSigningFingerprint, publicKey: peer.previousSigningPublicKey });
    const matchedKey = allowedKeys.find((item) => item.fingerprint === keyId);
    if (!matchedKey || !verifyGateRequest(matchedKey.publicKey, headers ?? {}, method, path, body, { now: this.now(), bodyDigest })) return false;
    const nonceKey = `${keyId}:${nonce}`;
    const cutoff = this.now() - 10 * 60_000;
    this.state.requestNonces = this.state.requestNonces.filter((entry) => entry.at > cutoff);
    if (this.state.requestNonces.some((entry) => entry.key === nonceKey)) return false;
    this.state.requestNonces.unshift({ key: nonceKey, at: Date.parse(timestamp), digest });
    this.state.requestNonces = this.state.requestNonces.slice(0, 20_000);
    if (matchedKey.current && peer.rotationAwaitingConfirmation && !peer.newKeySeenAt) {
      peer.newKeySeenAt = new Date(this.now()).toISOString();
      peer.previousKeyExpiresAt = new Date(this.now() + (peer.gracePeriodHours ?? this.state.gracePeriodHours) * 3600_000).toISOString();
      this.#event('PEER_NEW_IDENTITY_CONFIRMED', { fingerprint: peer.signingFingerprint });
    }
    await this.#save();
    return true;
  }

  async proposeIdentityRotation() {
    await this.#ready();
    if (!this.state.trustedPeer) throw Object.assign(new Error('尚未建立对端身份信任'), { code: 'gate_peer_not_trusted' });
    if (!this.state.pendingIdentity) {
      const signing = pair('ed25519');
      const exchange = pair('x25519');
      const identityBundle = { role: this.role, signingPublicKey: signing.publicKey, exchangePublicKey: exchange.publicKey, signingFingerprint: fingerprint(signing.publicKey) };
      const proposal = {
        schemaVersion: 1, rotationId: keyId(), nonce: randomBytes(24).toString('base64url'),
        previousFingerprint: fingerprint(this.state.signing.publicKey), identityBundle,
        createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + 15 * 60_000).toISOString(), gracePeriodHours: this.state.gracePeriodHours
      };
      proposal.signature = sign(null, Buffer.from(canonical(proposal)), createPrivateKey(this.state.signing.privateKey)).toString('base64url');
      this.state.pendingIdentity = { signing, exchange, proposal };
      this.#event('IDENTITY_ROTATION_PROPOSED', { rotationId: proposal.rotationId });
      await this.#save();
    } else if (Date.parse(this.state.pendingIdentity.proposal.expiresAt) <= this.now()) {
      const { signature: _oldSignature, ...proposal } = this.state.pendingIdentity.proposal;
      proposal.nonce = randomBytes(24).toString('base64url');
      proposal.createdAt = new Date(this.now()).toISOString();
      proposal.expiresAt = new Date(this.now() + 15 * 60_000).toISOString();
      proposal.signature = sign(null, Buffer.from(canonical(proposal)), createPrivateKey(this.state.signing.privateKey)).toString('base64url');
      this.state.pendingIdentity.proposal = proposal;
      this.#event('IDENTITY_ROTATION_PROPOSAL_RENEWED', { rotationId: proposal.rotationId });
      await this.#save();
    }
    return this.state.pendingIdentity.proposal;
  }

  async acceptIdentityRotation(proposal) {
    await this.#ready();
    const peer = this.state.trustedPeer;
    const { signature, ...signed } = proposal ?? {};
    const retry = Boolean(peer?.rotationId === signed.rotationId && peer.previousSigningFingerprint === signed.previousFingerprint);
    if (!peer || signed.identityBundle?.role !== peer.role || (!retry && signed.previousFingerprint !== peer.signingFingerprint) || !signed.rotationId || !signed.nonce || !Number.isInteger(signed.gracePeriodHours) || signed.gracePeriodHours < 1 || signed.gracePeriodHours > 168 || !Number.isFinite(Date.parse(signed.expiresAt)) || Date.parse(signed.expiresAt) <= this.now() || !Number.isFinite(Date.parse(signed.createdAt)) || Date.parse(signed.createdAt) > this.now() + 5 * 60_000) throw Object.assign(new Error('身份轮换提案无效或已过期'), { code: 'gate_identity_rotation_invalid' });
    let newFingerprint;
    try {
      newFingerprint = fingerprint(signed.identityBundle.signingPublicKey);
      if (newFingerprint !== signed.identityBundle.signingFingerprint || createPublicKey(signed.identityBundle.exchangePublicKey).asymmetricKeyType !== 'x25519') throw new Error('invalid bundle');
    } catch { throw Object.assign(new Error('身份轮换提案中的新公钥无效'), { code: 'gate_identity_rotation_invalid' }); }
    const signingKey = retry ? peer.previousSigningPublicKey : peer.signingPublicKey;
    if (!verify(null, Buffer.from(canonical(signed)), createPublicKey(signingKey), Buffer.from(signature ?? '', 'base64url'))) throw Object.assign(new Error('身份轮换提案未由当前对端身份签名'), { code: 'gate_identity_rotation_signature_invalid' });
    if (peer.rotationId !== signed.rotationId) {
      this.state.trustedPeer = { ...peer, previousSigningPublicKey: peer.signingPublicKey, previousSigningFingerprint: peer.signingFingerprint, previousKeyExpiresAt: new Date(this.now() + signed.gracePeriodHours * 3600_000).toISOString(), gracePeriodHours: signed.gracePeriodHours, rotationAwaitingConfirmation: true, newKeySeenAt: null, signingPublicKey: signed.identityBundle.signingPublicKey, signingFingerprint: newFingerprint, exchangePublicKey: signed.identityBundle.exchangePublicKey, rotationId: signed.rotationId };
      this.#event('PEER_IDENTITY_ROTATED', { rotationId: signed.rotationId, fingerprint: newFingerprint });
      await this.#save();
    }
    const proof = sign(null, Buffer.from(`${signed.rotationId}:${signed.nonce}:${newFingerprint}`), createPrivateKey(this.state.signing.privateKey)).toString('base64url');
    return { rotationId: signed.rotationId, nonce: signed.nonce, fingerprint: newFingerprint, proof };
  }

  async markPeerConfirmed() {
    await this.#ready();
    if (!this.state.trustedPeer) throw Object.assign(new Error('尚未保存对端身份'), { code: 'gate_peer_not_trusted' });
    if (!this.state.peerConfirmed) {
      this.state.peerConfirmed = true;
      this.#event('PEER_PAIRING_CONFIRMED', { fingerprint: this.state.trustedPeer.signingFingerprint });
      await this.#save();
    }
    return this.status();
  }

  async activateIdentityRotation(receipt) {
    await this.#ready();
    const pending = this.state.pendingIdentity;
    if (!pending || receipt?.rotationId !== pending.proposal.rotationId || receipt?.nonce !== pending.proposal.nonce || receipt?.fingerprint !== pending.proposal.identityBundle.signingFingerprint) throw Object.assign(new Error('对端身份轮换回执与当前提案不匹配'), { code: 'gate_identity_rotation_proof_invalid' });
    const peer = this.state.trustedPeer;
    const proofKeys = [peer.signingPublicKey];
    if (peer.previousSigningPublicKey && (peer.rotationAwaitingConfirmation && !peer.newKeySeenAt || Date.parse(peer.previousKeyExpiresAt) > this.now())) proofKeys.push(peer.previousSigningPublicKey);
    const proofValid = proofKeys.some((publicKey) => verify(null, Buffer.from(`${receipt.rotationId}:${receipt.nonce}:${receipt.fingerprint}`), createPublicKey(publicKey), Buffer.from(receipt.proof ?? '', 'base64url')));
    if (!proofValid) throw Object.assign(new Error('对端未确认接收新身份'), { code: 'gate_identity_rotation_proof_invalid' });
    this.state.previousIdentity = { signingPublicKey: this.state.signing.publicKey, expiresAt: new Date(this.now() + 24 * 3600_000).toISOString() };
    this.state.signing = pending.signing;
    this.state.exchange = pending.exchange;
    this.state.pendingIdentity = null;
    this.state.lastIdentityRotationAt = new Date(this.now()).toISOString();
    this.state.nextRotationAt = new Date(this.now() + this.state.rotationIntervalDays * 86400000).toISOString();
    this.state.rotationFailureAttempts = 0;
    this.state.retryAt = null;
    this.state.lastRotationError = null;
    this.#event('IDENTITY_ROTATION_ACTIVATED', { fingerprint: receipt.fingerprint });
    await this.#save();
    return this.status();
  }

  async trustPeer(bundle) {
    await this.#ready();
    if (!bundle || !['core', 'edge'].includes(bundle.role) || bundle.role === this.role) throw Object.assign(new Error('对端身份包无效或安全区角色不匹配'), { code: 'gate_peer_invalid' });
    try {
      if (createPublicKey(bundle.signingPublicKey).asymmetricKeyType !== 'ed25519' || createPublicKey(bundle.exchangePublicKey).asymmetricKeyType !== 'x25519') throw new Error('invalid key types');
    } catch { throw Object.assign(new Error('对端身份包中的公钥格式无效'), { code: 'gate_peer_invalid' }); }
    const actual = fingerprint(bundle.signingPublicKey);
    if (bundle.signingFingerprint && bundle.signingFingerprint !== actual) throw Object.assign(new Error('对端公钥指纹校验失败'), { code: 'gate_peer_invalid' });
    const previousPeer = this.state.trustedPeer;
    if (previousPeer?.signingFingerprint === actual && fingerprint(previousPeer.exchangePublicKey) === fingerprint(bundle.exchangePublicKey)) return this.status();
    if (previousPeer) {
      this.state.active = this.state.previous = this.state.pending = null;
      this.state.nextRotationAt = this.state.retryAt = this.state.lastRotationError = this.state.lastRotationAt = null;
      this.#event('PEER_REPLACED_KEYS_RETIRED', { fingerprint: actual });
    }
    this.state.trustedPeer = { role: bundle.role, signingPublicKey: bundle.signingPublicKey, exchangePublicKey: bundle.exchangePublicKey, signingFingerprint: actual, trustedAt: new Date(this.now()).toISOString() };
    this.state.peerConfirmed = false;
    this.#event('PEER_TRUSTED', { peerRole: bundle.role, fingerprint: actual });
    await this.#save();
    return this.status();
  }

  async status() {
    await this.#ready();
    const previousKeyExpiresAt = Date.parse(this.state.trustedPeer?.previousKeyExpiresAt) > this.now() ? this.state.trustedPeer.previousKeyExpiresAt : null;
    const businessReady = Boolean(this.state.trustedPeer && this.state.peerConfirmed);
    return {
      role: this.role,
      identity: await this.identity(),
      peerTrusted: Boolean(this.state.trustedPeer),
      peerFingerprint: this.state.trustedPeer?.signingFingerprint ?? null,
      keyConfigured: Boolean(this.state.trustedPeer),
      businessReady,
      pairingState: !this.state.trustedPeer ? 'UNPAIRED' : businessReady ? 'PAIRED' : 'KEY_PENDING',
      activeKeyId: this.state.signing ? fingerprint(this.state.signing.publicKey) : null,
      previousKeyExpiresAt,
      rotationIntervalDays: this.state.rotationIntervalDays,
      gracePeriodHours: this.state.gracePeriodHours,
      nextRotationAt: this.state.nextRotationAt,
      rotationState: this.state.pendingIdentity ? 'PROPOSAL_PENDING' : 'IDLE',
      lastRotationError: this.state.lastRotationError ?? null,
      retryAt: this.state.retryAt ?? null,
      lastRotationAt: this.state.lastIdentityRotationAt ?? this.state.identityEstablishedAt ?? null,
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
    const rotationAnchor = Date.parse(this.state.lastIdentityRotationAt ?? this.state.identityEstablishedAt);
    this.state.nextRotationAt = new Date((Number.isFinite(rotationAnchor) ? rotationAnchor : this.now()) + rotationIntervalDays * 86400000).toISOString();
    await this.#save();
    return this.status();
  }

  async recordRotationFailure(error) {
    await this.#ready();
    this.state.rotationFailureAttempts += 1;
    const delayMs = Math.min(300_000, 60_000 * (2 ** Math.min(this.state.rotationFailureAttempts - 1, 3)));
    this.state.retryAt = new Date(this.now() + delayMs).toISOString();
    this.state.lastRotationError = String(error?.message ?? error ?? '身份轮换失败').slice(0, 500);
    this.#event('ROTATION_RETRY_WAIT', { attempt: this.state.rotationFailureAttempts, retryAt: this.state.retryAt });
    await this.#save();
    return this.status();
  }

  async needsRotation() {
    await this.#ready();
    if (!this.state.trustedPeer) return false;
    if (Date.parse(this.state.retryAt) > this.now()) return false;
    if (this.state.pendingIdentity) return true;
    return !this.state.nextRotationAt || Date.parse(this.state.nextRotationAt) <= this.now();
  }
}
