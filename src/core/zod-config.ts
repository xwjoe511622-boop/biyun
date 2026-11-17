import { config } from 'zod'

/**
 * CSP `script-src 'self'` (no `'unsafe-eval'`, docs/04-design/security/web-csp-and-session-cookie.md): zod v4 otherwise
 * probes `Function('')` and JIT-compiles object parsers with `new Function`. Under the enforced policy the probe would
 * be blocked (and logged as a violation on every page load); `jitless` makes zod use its interpreter from the start.
 * Imported first by `main.ts`, before any schema parses.
 */
config({ jitless: true })
