import { i18n } from '@/i18n/composer'
import { ecb } from '@noble/ciphers/aes.js'
import { md5 } from '@noble/hashes/legacy.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { JSEncrypt } from 'jsencrypt'

// Compatibility with the existing login API, not a new cryptographic protocol.
// TLS remains mandatory. Only this adapter may use legacy MD5/AES-ECB/RSA-v1.5.
export function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

export function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

export function rsaEncryptPublic(plain: string, publicKey?: string): string {
  const key = (publicKey ?? import.meta.env.VITE_API_RSA_PUBLIC_KEY)?.trim()
  if (!key) throw new Error(i18n.global.t('clientFailure.rsaPublicKeyEncryptionFailed'))
  const encryptor = new JSEncrypt()
  encryptor.setPublicKey(key)
  const encrypted = encryptor.encrypt(plain)
  if (!encrypted) throw new Error(i18n.global.t('clientFailure.rsaPublicKeyEncryptionFailed'))
  return encrypted
}

export function md5Hex(text: string): string {
  return bytesToHex(md5(utf8ToBytes(text)))
}

export interface SignedEnvelope {
  envelope: { data: string; key: string }
  sign: string
  timestamp: string
}

export function buildSignedEnvelope(body: unknown, apiPath: string, timestamp = Date.now()): SignedEnvelope {
  if (!globalThis.crypto?.getRandomValues) throw new Error(i18n.global.t('clientFailure.secureRandomGeneratorUnavailable'))
  const plainJson = JSON.stringify(body)
  const aesKey = crypto.getRandomValues(new Uint8Array(16))
  try {
    const data = bytesToBase64(ecb(aesKey).encrypt(utf8ToBytes(plainJson)))
    const key = rsaEncryptPublic(bytesToBase64(aesKey))
    const sign = rsaEncryptPublic(md5Hex(plainJson + timestamp + apiPath))
    return { envelope: { data, key }, sign, timestamp: String(timestamp) }
  } finally {
    aesKey.fill(0)
  }
}
