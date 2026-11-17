import { i18n } from '@/i18n/composer'
import { z } from 'zod'
import { API_PREFIX } from '@/config/endpoints'
import { ApiError } from '@/core/errors'
import { session } from '@/core/session'
import { parseJsonLossless } from '@/core/lossless-json'
import { buildHeaders, confirmRejectedSession, request } from '@/modules/api/http'
import { envelopeSchema } from '@/modules/api/validation'
import { parseWith, text } from '@/modules/content/api-helpers'
import type { PhotoSlot, RealNamePayload } from './kyc-form'

/**
 * Identity verification (manual review flow used by the legacy PC `personal/idAuth`).
 *
 * - `PublicAct.java:2027-2135` `common/upload_img` — multipart, login required. The first image part
 *   (any field name; jpeg/png/bmp) is stored and `{filename, filenameStr, base_image_url}` returned.
 *   `filenameStr` is the signed private-OSS key (only when `sys_conf_oss_path_auth` is configured).
 *   The legacy uploader submits `filenameStr || filename` (`OldUploadFile.vue:80-129`).
 * - `UserCenterAct.java:1658` `user/v4/auth_realname` — JSON body built by `buildRealNamePayload`.
 *   Success has no data; it (re)sets the review to pending (`authStatus = 0`).
 * - Status: `common/user_info` `authLevel` (0 pending / 1 approved / 2 rejected / 3 not submitted) and
 *   `notPassReason` (`PublicAct.java:1537,1559-1567`), read through the session store.
 * - Mode: `public_info_v4.switch.nameVerifiedType` (`KYCUtils.getKYCSwitch`): `10` manual, `00` Face++,
 *   `01`/`02` Yushan, '' none. Vendor flows are not implemented by this client.
 *
 * Images travel straight from the file input to the upload endpoint. Nothing is written to browser
 * storage; previews use in-memory object URLs that the component revokes.
 */
export const KYC_ENDPOINTS = {
  upload: 'common/upload_img',
  submit: 'user/v4/auth_realname',
} as const

export const KYC_ERROR = {
  notLoggedIn: '10002',
  imageType: '10027',
  authFail: '10028',
  duplicateCertificate: '10051',
  uploadFail: '10061',
} as const

const UPLOAD_TIMEOUT_MS = 60_000
const uploadSchema = z.object({ filename: text, filenameStr: text, base_image_url: text }).passthrough()

export interface UploadedImage {
  /** Value submitted as `firstPhoto` / `secondPhoto` / `thirdPhoto`. */
  key: string
}

/**
 * Uploads one document image. `uploadBase` switches to `/fe-upload-api/` when the platform enables
 * `is_open_upload_img` (legacy behaviour); it defaults to the web-api prefix.
 */
export async function uploadKycImage(
  file: Blob,
  slot: PhotoSlot,
  options: { uploadBase?: string; signal?: AbortSignal } = {},
): Promise<UploadedImage> {
  const path = KYC_ENDPOINTS.upload
  const headers = buildHeaders()
  delete headers['Content-Type']
  const requestToken = session.getToken() ?? undefined
  const form = new FormData()
  form.append(slot, file, slot)
  form.append('name', slot)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  let response: Response
  let raw: string
  try {
    response = await fetch(`${options.uploadBase ?? API_PREFIX}${path}`, {
      method: 'POST',
      headers,
      body: form,
      credentials: 'same-origin',
      signal: controller.signal,
    })
    raw = await response.text()
  } catch (error) {
    const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    throw new ApiError({
      kind: aborted ? 'timeout' : 'network',
      code: '',
      path,
      message: aborted ? i18n.global.t('serviceMessage.uploadTimedOutMs', { timeout: UPLOAD_TIMEOUT_MS }) : i18n.global.t('serviceMessage.uploadFailed', { detail: error instanceof Error ? error.message : String(error) }),
    })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }

  let payload: unknown = null
  try {
    payload = raw === '' ? null : parseJsonLossless(raw)
  } catch {
    throw new ApiError({ kind: 'parse', code: '', path, status: response.status, message: i18n.global.t('serviceMessage.invalidJsonUploadResponse') })
  }
  const envelope = envelopeSchema.safeParse(payload)
  const code = envelope.success ? String(envelope.data.code) : ''
  const message = envelope.success && typeof envelope.data.msg === 'string' ? envelope.data.msg : ''
  if (code === '10002' || code === '110009' || response.status === 401) {
    if (requestToken !== undefined && session.getToken() === requestToken) await confirmRejectedSession(requestToken)
    throw new ApiError({ kind: 'unauthorized', code: code || '401', path, status: response.status, message: message || i18n.global.t('serviceMessage.signInRequiredOrSessionExpired') })
  }
  if (!response.ok) {
    throw new ApiError({ kind: 'http', code: code || String(response.status), path, status: response.status, message: message || `HTTP ${response.status}`, data: envelope.success ? envelope.data.data : undefined })
  }
  if (!envelope.success) {
    throw new ApiError({ kind: 'parse', code: '', path, status: response.status, message: i18n.global.t('serviceMessage.theResponseIsMissingTheCodeField') })
  }
  if (code !== '0') {
    throw new ApiError({ kind: 'api', code, path, status: response.status, message: message || i18n.global.t('serviceMessage.requestFailedCode', { code }), data: envelope.data.data })
  }
  const data = parseWith(uploadSchema, path, envelope.data.data)
  const key = data.filenameStr !== '' ? data.filenameStr : data.filename
  if (key === '') throw new ApiError({ kind: 'parse', code: '', path, message: `API contract mismatch: ${path} [filename]` })
  return { key }
}

export async function submitRealName(payload: RealNamePayload): Promise<void> {
  await request<unknown>(KYC_ENDPOINTS.submit, { body: payload })
}

export type KycMode = 'manual' | 'faceplusplus' | 'yushan' | 'none' | 'unknown'

export function readKycMode(nameVerifiedType: unknown): KycMode {
  if (nameVerifiedType === undefined || nameVerifiedType === null) return 'unknown'
  switch (String(nameVerifiedType).trim()) {
    case '10': return 'manual'
    case '00': return 'faceplusplus'
    case '01':
    case '02': return 'yushan'
    case '': return 'none'
    default: return 'unknown'
  }
}
