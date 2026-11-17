import { i18n } from '@/i18n/composer'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

/**
 * Client-side withdrawal-address checks. They only give fast feedback while typing: the server
 * (contract §1.5) re-validates the format, the EIP-55 checksum, the zero address and every
 * platform-owned address (vault, any user's deposit address, token contracts) and its answer wins.
 */

export const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = /^0x0{40}$/i

/** EIP-55 mixed-case checksum encoding of a 20-byte hex address. */
export function toChecksumAddress(address: string): string {
  if (!EVM_ADDRESS_PATTERN.test(address)) {
    throw new Error(i18n.global.t('serviceMessage.expectedA40DigitHexadecimalAddressBeginningWith0X'))
  }
  const lower = address.slice(2).toLowerCase()
  const hash = bytesToHex(keccak_256(utf8ToBytes(lower)))
  let out = '0x'
  for (let index = 0; index < lower.length; index += 1) {
    const char = lower[index]
    out += Number.parseInt(hash[index], 16) >= 8 ? char.toUpperCase() : char
  }
  return out
}

/**
 * EIP-55: an all-lowercase or all-uppercase address carries no checksum and is accepted as is;
 * a mixed-case address must match its checksum encoding exactly.
 */
export function hasValidChecksum(address: string): boolean {
  if (!EVM_ADDRESS_PATTERN.test(address)) {
    return false
  }
  const body = address.slice(2)
  if (body === body.toLowerCase() || body === body.toUpperCase()) {
    return true
  }
  return toChecksumAddress(address) === address
}

export function isZeroEvmAddress(address: string): boolean {
  return ZERO_ADDRESS.test(address)
}

export type AddressProblem = 'empty' | 'format' | 'checksum' | 'zero' | 'pattern'

export interface AddressCheck {
  ok: boolean
  problem: AddressProblem | null
  /** True when the address was validated with the EVM rules. */
  evm: boolean
  /** True when a mixed-case EIP-55 checksum was present and verified. */
  checksummed: boolean
}

export interface AddressRule {
  /** `addressRegex` from `addr/networks`; `''` when the server did not provide one. */
  addressRegex: string
}

function compile(source: string): RegExp | null {
  if (source.trim() === '') {
    return null
  }
  try {
    return new RegExp(source)
  } catch {
    return null
  }
}

const EVM_NETWORK = /^(BNBCHAIN|BSC|BEP20|OPBNB|ETH|ETHEREUM|ERC20|POLYGON|MATIC|ARBITRUM|ARB|OPTIMISM|OP|BASE|AVAX|AVAXC|AVALANCHE|LINEA|SCROLL|ZKSYNC)([-_ ].*)?$/
const TRON_NETWORK = /^(TRON|TRX|TRC20)([-_ ].*)?$/
/** `0x` + 40 hex (EVM), as a regex source that {@link isEvmRule} recognises. */
export const EVM_ADDRESS_REGEX = '^0x[0-9a-fA-F]{40}$'
/** TRON base58check shape (`T` + 33). */
export const TRON_ADDRESS_REGEX = '^T[1-9A-HJ-NP-Za-km-z]{33}$'

/**
 * QA-022 (10-25): the wallet catalog sends an empty `addressRegex` for every network, so `not-an-address` on BNB Chain
 * was shown as "new address". The server rule wins; otherwise a known network family (or an EVM `chainId`) supplies the
 * format. Unknown families stay `''` and are left to the server.
 */
export function networkAddressRegex(network: string, serverRegex: string, chainId?: number): string {
  if (serverRegex.trim() !== '') return serverRegex
  const code = network.trim().toUpperCase()
  if (chainId !== undefined || EVM_NETWORK.test(code)) return EVM_ADDRESS_REGEX
  if (TRON_NETWORK.test(code)) return TRON_ADDRESS_REGEX
  return ''
}

/** A network is treated as EVM when its server regex describes `0x` + 40 hex characters. */
export function isEvmRule(rule: AddressRule): boolean {
  const source = rule.addressRegex.replace(/\s/g, '')
  return source.includes('0x') && source.includes('{40}')
}

/**
 * Validates a withdrawal address against the network rule. Without a server rule the EVM checks
 * are still applied to anything that looks like `0x…`; other formats are left to the server.
 */
export function checkWithdrawAddress(input: string, rule: AddressRule): AddressCheck {
  const value = input.trim()
  const evm = isEvmRule(rule) || /^0x/i.test(value)
  if (value === '') {
    return { ok: false, problem: 'empty', evm, checksummed: false }
  }
  const pattern = compile(rule.addressRegex)
  if (evm) {
    if (!EVM_ADDRESS_PATTERN.test(value)) {
      return { ok: false, problem: 'format', evm, checksummed: false }
    }
    if (!hasValidChecksum(value)) {
      return { ok: false, problem: 'checksum', evm, checksummed: false }
    }
    if (isZeroEvmAddress(value)) {
      return { ok: false, problem: 'zero', evm, checksummed: false }
    }
    const body = value.slice(2)
    const checksummed = body !== body.toLowerCase() && body !== body.toUpperCase()
    return { ok: true, problem: null, evm, checksummed }
  }
  if (pattern !== null && !pattern.test(value)) {
    return { ok: false, problem: 'pattern', evm, checksummed: false }
  }
  return { ok: true, problem: null, evm, checksummed: false }
}

/** Case-insensitive for EVM addresses (checksum casing is presentation only), exact otherwise. */
export function sameAddress(left: string, right: string): boolean {
  const a = left.trim()
  const b = right.trim()
  if (EVM_ADDRESS_PATTERN.test(a) && EVM_ADDRESS_PATTERN.test(b)) {
    return a.toLowerCase() === b.toLowerCase()
  }
  return a === b
}

/** `0x1234…abcd` style shortening for tables and chips. */
export function shortAddress(address: string, head = 6, tail = 4): string {
  const value = address.trim()
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`
}
