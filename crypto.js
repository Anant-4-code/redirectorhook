const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

/** AES-256-GCM — server encrypts only; never decrypts. */
function encryptNumber(plaintext, secretHex) {
  const key = Buffer.from(secretHex, 'hex');
  if (key.length !== 32) {
    throw new Error('Invalid agent secret length');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, tag, encrypted]);
  return PREFIX + packed.toString('base64url');
}

function isEncryptedPayload(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Fix Express/query parsers turning '+' into spaces in the ciphertext. */
function normalizeEncryptedPayload(value) {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (!s.startsWith(PREFIX)) return s;
  return s.replace(/ /g, '+');
}

module.exports = {
  generateSecret,
  encryptNumber,
  isEncryptedPayload,
  normalizeEncryptedPayload,
  PREFIX,
};
