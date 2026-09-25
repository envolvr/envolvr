// Wallet sign-in and API keys.
//
// A client proves control of a wallet by signing a one-time message (EIP-191
// personal_sign) and gets an API key bound to that wallet. The key is shown
// once; only its SHA-256 is stored, which is also what the gateway sends in the
// pre-request consult.

import { createHash, randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

export function newApiKey(): string {
  return `envk_${randomBytes(32).toString('base64url')}`;
}

/** A management session token (the app's): manages the account, cannot run inference. */
export function newSessionToken(): string {
  return `envs_${randomBytes(32).toString('base64url')}`;
}

/** What a wallet signs to manage its account in the app. Distinct from sign-in and closing. */
export function manageMessage(wallet: string, nonce: string, issuedAt: string): string {
  return [
    'envolvr: sign in to manage this account.',
    '',
    `Wallet: ${wallet.toLowerCase()}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

export function signInMessage(wallet: string, nonce: string, issuedAt: string): string {
  return [
    'envolvr: sign in to get an API key.',
    '',
    `Wallet: ${wallet.toLowerCase()}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

/**
 * What a wallet signs to close its account: its API keys are revoked and the
 * balance is refunded to `refundTo`. A sign-in signature cannot stand in for it.
 */
export function closeAccountMessage(wallet: string, refundTo: string, nonce: string, issuedAt: string): string {
  return [
    'envolvr: close this account and refund its balance.',
    '',
    `Wallet: ${wallet.toLowerCase()}`,
    `Refund to: ${refundTo.toLowerCase()}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

export function addressOf(publicKey: Uint8Array): string {
  const uncompressed = secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false);
  return `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(-20))}`;
}

function personalMessageHash(message: string): Uint8Array {
  const bytes = utf8ToBytes(message);
  return keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`), bytes));
}

/** Recover the signer of an EIP-191 personal_sign signature (65 bytes, hex). */
export function recoverSigner(message: string, signatureHex: string): string {
  const sig = hexToBytes(signatureHex.replace(/^0x/, ''));
  if (sig.length !== 65) throw new Error('signature must be 65 bytes');
  let v = sig[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error('invalid recovery id');
  const s = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(v);
  return addressOf(s.recoverPublicKey(personalMessageHash(message)).toRawBytes(true));
}

/** Test helper and client reference: sign like a wallet's personal_sign. */
export function personalSign(message: string, privateKey: Uint8Array): string {
  const s = secp256k1.sign(personalMessageHash(message), privateKey);
  return `0x${bytesToHex(s.toCompactRawBytes())}${(27 + s.recovery).toString(16)}`;
}
