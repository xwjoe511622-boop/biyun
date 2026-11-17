import { KYC_COUNTRIES, type CountryRow } from './countries'

/**
 * Real-name form rules. Field semantics follow `user/v4/auth_realname` (`UserCenterAct.java:1658-1780`):
 * China (`+86`) submits `userName`; other countries submit `familyName` + `name`. `certificateType`
 * codes (operate-web `auth_realname_detail.html:53`): 1 ID card, 2 passport, 3 other, 4 driver license;
 * the legacy PC offered only ID card for China and passport / driver license / other elsewhere
 * (`IdAuth.js:54-67`).
 */
export type CertificateType = '1' | '2' | '3' | '4'
export type PhotoSlot = 'firstPhoto' | 'secondPhoto' | 'thirdPhoto'
export const PHOTO_SLOTS: readonly PhotoSlot[] = ['firstPhoto', 'secondPhoto', 'thirdPhoto']

export const CHINA_ISO = '156'
/** Legacy client limit (`IdAuth.vue:173`); the server has no explicit limit. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** `PublicAct.upload_img` accepts only these content types (`:2027-2135`). */
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/bmp'] as const

export interface KycDraft {
  countryIso: string
  fullName: string
  familyName: string
  givenName: string
  certificateType: CertificateType | ''
  certificateNumber: string
  /** Upload keys returned by `common/upload_img` (`filenameStr || filename`), never image data. */
  photos: Partial<Record<PhotoSlot, string>>
}

export type KycField = 'country' | 'fullName' | 'familyName' | 'givenName' | 'certificateType' | 'certificateNumber' | PhotoSlot
export type KycErrorKey =
  | 'required'
  | 'nameInvalid'
  | 'idCardInvalid'
  | 'documentInvalid'
  | 'photoRequired'
  | 'certificateUnsupported'

export function findCountry(iso: string): CountryRow | undefined {
  return KYC_COUNTRIES.find((row) => row[0] === iso)
}

/** Matches `countryCode` values like `86`, `+86` or the stored `156+86` form. */
export function countryFromDialCode(value: unknown): CountryRow | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const raw = String(value).trim()
  const stored = /^(\d+)\+(\d+)$/.exec(raw)
  if (stored !== null) return findCountry(stored[1] ?? '') ?? countryFromDialCode(stored[2])
  const dial = raw.replace(/^\+/, '')
  if (!/^\d{1,4}$/.test(dial)) return undefined
  return KYC_COUNTRIES.find((row) => row[1] === `+${dial}`)
}

export function isChina(iso: string): boolean {
  return iso === CHINA_ISO
}

export function certificateOptions(iso: string): CertificateType[] {
  return isChina(iso) ? ['1'] : ['2', '4', '3']
}

const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\s.'·・-]{0,63}$/u
const CN_ID_PATTERN = /^(\d{15}|\d{17}[\dXx])$/
const DOCUMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{3,31}$/

/** GB 11643 checksum for 18-digit mainland ID numbers. */
export function isValidChineseId(value: string): boolean {
  const id = value.trim().toUpperCase()
  if (!CN_ID_PATTERN.test(id)) return false
  if (id.length === 15) return true
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const checks = '10X98765432'
  let total = 0 // float-ok: not money (ID-card checksum digits)
  for (let index = 0; index < 17; index += 1) total += Number(id[index]) * (weights[index] ?? 0)
  return checks[total % 11] === id[17]
}

export function validateKycDraft(draft: KycDraft): Partial<Record<KycField, KycErrorKey>> {
  const errors: Partial<Record<KycField, KycErrorKey>> = {}
  const country = findCountry(draft.countryIso)
  if (country === undefined) errors.country = 'required'
  const china = isChina(draft.countryIso)
  if (china) {
    const name = draft.fullName.trim()
    if (name === '') errors.fullName = 'required'
    else if (!NAME_PATTERN.test(name)) errors.fullName = 'nameInvalid'
  } else {
    const family = draft.familyName.trim()
    const given = draft.givenName.trim()
    if (family === '') errors.familyName = 'required'
    else if (!NAME_PATTERN.test(family)) errors.familyName = 'nameInvalid'
    if (given === '') errors.givenName = 'required'
    else if (!NAME_PATTERN.test(given)) errors.givenName = 'nameInvalid'
  }
  if (draft.certificateType === '') errors.certificateType = 'required'
  else if (!certificateOptions(draft.countryIso).includes(draft.certificateType)) errors.certificateType = 'certificateUnsupported'
  const number = draft.certificateNumber.trim()
  if (number === '') errors.certificateNumber = 'required'
  else if (draft.certificateType === '1' ? !isValidChineseId(number) : !DOCUMENT_PATTERN.test(number)) {
    errors.certificateNumber = draft.certificateType === '1' ? 'idCardInvalid' : 'documentInvalid'
  }
  for (const slot of PHOTO_SLOTS) {
    if ((draft.photos[slot] ?? '').trim() === '') errors[slot] = 'photoRequired'
  }
  return errors
}

export type ImageErrorKey = 'imageType' | 'imageSize' | 'imageEmpty'

export function validateImageFile(file: { type: string; size: number }): ImageErrorKey | null {
  if (file.size <= 0) return 'imageEmpty'
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type.toLowerCase())) return 'imageType'
  if (file.size > MAX_IMAGE_BYTES) return 'imageSize'
  return null
}

export interface RealNamePayload {
  countryCode: string
  numberCode: string
  certificateType: CertificateType
  certificateNumber: string
  firstPhoto: string
  secondPhoto: string
  thirdPhoto: string
  userName?: string
  familyName?: string
  name?: string
}

/** Builds the exact `user/v4/auth_realname` body. Throws if the draft is not valid. */
export function buildRealNamePayload(draft: KycDraft): RealNamePayload {
  const errors = validateKycDraft(draft)
  const country = findCountry(draft.countryIso)
  if (Object.keys(errors).length > 0 || country === undefined || draft.certificateType === '') {
    throw new Error('KYC draft is not valid')
  }
  const payload: RealNamePayload = {
    countryCode: country[1],
    numberCode: country[0],
    certificateType: draft.certificateType,
    certificateNumber: draft.certificateType === '1' ? draft.certificateNumber.trim().toUpperCase() : draft.certificateNumber.trim(),
    firstPhoto: draft.photos.firstPhoto ?? '',
    secondPhoto: draft.photos.secondPhoto ?? '',
    thirdPhoto: draft.photos.thirdPhoto ?? '',
  }
  if (isChina(draft.countryIso)) payload.userName = draft.fullName.trim().replace(/\s+/g, ' ')
  else {
    payload.familyName = draft.familyName.trim().replace(/\s+/g, ' ')
    payload.name = draft.givenName.trim().replace(/\s+/g, ' ')
  }
  return payload
}

export type KycStage = 'unverified' | 'pending' | 'approved' | 'rejected' | 'unknown'

/** `common/user_info.authLevel` (`AuthRealnameServiceImpl.getAuthLevelStatus:724-738`). */
export function kycStage(authLevel: unknown): KycStage {
  if (authLevel === undefined || authLevel === null) return 'unknown'
  switch (String(authLevel).trim()) {
    case '0': return 'pending'
    case '1': return 'approved'
    case '2': return 'rejected'
    case '3': return 'unverified'
    default: return 'unknown'
  }
}

/** Masks a real name for display (`张三` -> `*三`, `John Smith` -> `J*** Smith`). */
export function maskName(value: string): string {
  const name = value.trim()
  if (name === '') return ''
  if (/[一-鿿]/.test(name)) return `${'*'.repeat(Math.max(1, name.length - 1))}${name.slice(-1)}`
  const [first = '', ...rest] = name.split(/\s+/)
  return [`${first.slice(0, 1)}***`, ...rest].join(' ')
}
