/**
 * `JSON.parse` that never rounds an id (owner 10-22: 订单号太大…这种问题一定要规避).
 *
 * Order / trade / position ids are 63-bit snowflakes (~3.5e18), far above 2^53, and `JSON.parse` silently rounds them:
 * the page then queries or cancels an order that does not exist. Every integer literal outside a string whose magnitude
 * exceeds `Number.MAX_SAFE_INTEGER` is turned into its exact decimal string before parsing, whatever its key, so new
 * id fields are covered without a key list. Time-like keys (`time`, `ts`, `*Time`, `E`, `T`, …) keep a number: a
 * nanosecond stamp only loses sub-microsecond digits and callers do date arithmetic on it.
 *
 * Text with no run of 16+ digits takes the plain `JSON.parse` path (the common case costs one regex test).
 */

const LONG_DIGITS = /\d{16}/
const TIME_KEY = /^(?:E|T|ts|time|timestamp|[a-zA-Z]*(?:Time|Ts|At))$/

function isTimeKey(key: string | null): boolean {
  return key !== null && TIME_KEY.test(key)
}

function unsafeInteger(token: string): boolean {
  const digits = token.startsWith('-') ? token.slice(1) : token
  if (digits.length < 16 || !/^\d+$/.test(digits)) return false
  return BigInt(digits) > BigInt(Number.MAX_SAFE_INTEGER)
}

/** The JSON text with every unsafe integer literal (outside strings, not under a time key) quoted. */
export function quoteUnsafeIntegers(text: string): string {
  if (!LONG_DIGITS.test(text)) return text
  let out = ''
  let from = 0
  let i = 0
  // Key that owns the value being read: objects take the last key, arrays inherit the key of the array itself.
  const owners: (string | null)[] = []
  const inArray: boolean[] = []
  let lastKey: string | null = null
  const n = text.length
  while (i < n) {
    const ch = text.charCodeAt(i)
    if (ch === 34 /* " */) {
      const start = i
      i += 1
      while (i < n) {
        const c = text.charCodeAt(i)
        if (c === 92 /* \ */) i += 2
        else if (c === 34) break
        else i += 1
      }
      i += 1
      // A string followed by ':' is a key.
      let j = i
      while (j < n && (text[j] === ' ' || text[j] === '\n' || text[j] === '\r' || text[j] === '\t')) j += 1
      if (text[j] === ':' && inArray[inArray.length - 1] !== true) {
        try {
          lastKey = JSON.parse(text.slice(start, i)) as string
        } catch {
          lastKey = null
        }
      }
      continue
    }
    if (ch === 123 /* { */ || ch === 91 /* [ */) {
      const array = ch === 91
      owners.push(array ? (inArray[inArray.length - 1] === true ? owners[owners.length - 1] ?? null : lastKey) : null)
      inArray.push(array)
      if (!array) lastKey = null
      i += 1
      continue
    }
    if (ch === 125 /* } */ || ch === 93 /* ] */) {
      owners.pop()
      inArray.pop()
      i += 1
      continue
    }
    if (ch === 45 /* - */ || (ch >= 48 && ch <= 57)) {
      const start = i
      i += 1
      while (i < n) {
        const c = text.charCodeAt(i)
        if ((c >= 48 && c <= 57) || c === 46 || c === 101 || c === 69 || c === 43 || c === 45) i += 1
        else break
      }
      const token = text.slice(start, i)
      const key = inArray[inArray.length - 1] === true ? owners[owners.length - 1] ?? null : lastKey
      if (unsafeInteger(token) && !isTimeKey(key)) {
        out += `${text.slice(from, start)}"${token}"`
        from = i
      }
      continue
    }
    i += 1
  }
  return from === 0 ? text : out + text.slice(from)
}

/** `JSON.parse` with unsafe integers kept exact as strings (see the module comment). */
export function parseJsonLossless(text: string): unknown {
  return JSON.parse(quoteUnsafeIntegers(text))
}
