import { translateForLocale } from '@/i18n/composer'
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { session } from '@/core/session'
import { KYC_COUNTRIES } from '@/modules/kyc/countries'
import {
  buildRealNamePayload,
  certificateOptions,
  countryFromDialCode,
  isValidChineseId,
  kycStage,
  maskName,
  MAX_IMAGE_BYTES,
  validateImageFile,
  validateKycDraft,
  type KycDraft,
} from '@/modules/kyc/kyc-form'
import { readKycMode, uploadKycImage } from '@/modules/kyc/kyc.api'

// Valid GB 11643 test number (checksum computed, not a real person).
const VALID_ID = '11010519491231002X'

function draft(overrides: Partial<KycDraft> = {}): KycDraft {
  return {
    countryIso: '156',
    fullName: '张三',
    familyName: '',
    givenName: '',
    certificateType: '1',
    certificateNumber: VALID_ID,
    photos: { firstPhoto: 'common/image/a.png', secondPhoto: 'common/image/b.png', thirdPhoto: 'common/image/c.png' },
    ...overrides,
  }
}

describe('country data', () => {
  it('is a verbatim legacy extraction with unique numeric codes', () => {
    expect(KYC_COUNTRIES.length).toBeGreaterThan(150)
    expect(new Set(KYC_COUNTRIES.map((row) => row[0])).size).toBe(KYC_COUNTRIES.length)
    const china = KYC_COUNTRIES.find((row) => row[0] === '156')!
    expect(china[1]).toBe('+86')
    expect(translateForLocale('en-US', china[2])).toBe('China')
    expect(translateForLocale('zh-CN', china[2])).toBe('中国')
  })

  it('resolves dial codes in every stored form', () => {
    expect(countryFromDialCode('86')?.[0]).toBe('156')
    expect(countryFromDialCode('+86')?.[0]).toBe('156')
    expect(countryFromDialCode('156+86')?.[0]).toBe('156')
    expect(countryFromDialCode('abc')).toBeUndefined()
    expect(countryFromDialCode(null)).toBeUndefined()
  })
})

describe('KYC form validation', () => {
  it('accepts a complete mainland draft', () => {
    expect(validateKycDraft(draft())).toEqual({})
  })

  it('checks the mainland ID checksum', () => {
    expect(isValidChineseId(VALID_ID)).toBe(true)
    expect(isValidChineseId('110105194912310021')).toBe(false)
    expect(isValidChineseId('11010519491231002x')).toBe(true)
    expect(validateKycDraft(draft({ certificateNumber: '123' })).certificateNumber).toBe('idCardInvalid')
  })

  it('requires surname + given name outside China and restricts document types', () => {
    const errors = validateKycDraft(draft({ countryIso: '840', fullName: '', certificateType: '1', certificateNumber: 'X1234567' }))
    expect(errors.familyName).toBe('required')
    expect(errors.givenName).toBe('required')
    expect(errors.certificateType).toBe('certificateUnsupported')
    expect(certificateOptions('840')).toEqual(['2', '4', '3'])
    expect(certificateOptions('156')).toEqual(['1'])
  })

  it('rejects names with digits or markup and missing photos', () => {
    const errors = validateKycDraft(draft({ fullName: '<b>1</b>', photos: { firstPhoto: 'k' } }))
    expect(errors.fullName).toBe('nameInvalid')
    expect(errors.secondPhoto).toBe('photoRequired')
    expect(errors.thirdPhoto).toBe('photoRequired')
    expect(errors.firstPhoto).toBeUndefined()
  })

  it('validates passport numbers', () => {
    const base = { countryIso: '840', familyName: 'Smith', givenName: "Mary-Jane O'Neil", certificateType: '2' as const }
    expect(validateKycDraft(draft({ ...base, certificateNumber: 'P1234567' }))).toEqual({})
    expect(validateKycDraft(draft({ ...base, certificateNumber: 'P#1' })).certificateNumber).toBe('documentInvalid')
  })

  it('builds the exact user/v4/auth_realname payload', () => {
    expect(buildRealNamePayload(draft({ certificateNumber: '11010519491231002x', fullName: '  张  三 ' }))).toEqual({
      countryCode: '+86', numberCode: '156', certificateType: '1', certificateNumber: VALID_ID,
      firstPhoto: 'common/image/a.png', secondPhoto: 'common/image/b.png', thirdPhoto: 'common/image/c.png', userName: '张 三',
    })
    const foreign = buildRealNamePayload(draft({ countryIso: '840', familyName: 'Smith', givenName: 'Mary', certificateType: '2', certificateNumber: 'P1234567' }))
    expect(foreign).toMatchObject({ countryCode: '+1', numberCode: '840', familyName: 'Smith', name: 'Mary', certificateType: '2' })
    expect(foreign.userName).toBeUndefined()
  })

  it('refuses to build a payload from an invalid draft', () => {
    expect(() => buildRealNamePayload(draft({ photos: {} }))).toThrow()
  })

  it('validates image files against the server whitelist and the legacy size cap', () => {
    expect(validateImageFile({ type: 'image/png', size: 1000 })).toBeNull()
    expect(validateImageFile({ type: 'image/gif', size: 1000 })).toBe('imageType')
    expect(validateImageFile({ type: 'image/svg+xml', size: 1000 })).toBe('imageType')
    expect(validateImageFile({ type: 'image/jpeg', size: MAX_IMAGE_BYTES + 1 })).toBe('imageSize')
    expect(validateImageFile({ type: 'image/jpeg', size: 0 })).toBe('imageEmpty')
  })

  it('maps authLevel to stages and KYC switches to modes', () => {
    expect(['0', '1', '2', '3', 9, undefined].map(kycStage)).toEqual(['pending', 'approved', 'rejected', 'unverified', 'unknown', 'unknown'])
    expect(kycStage(1)).toBe('approved')
    expect(['10', '00', '01', '02', '', undefined].map(readKycMode)).toEqual(['manual', 'faceplusplus', 'yushan', 'yushan', 'none', 'unknown'])
  })

  it('masks names', () => {
    expect(maskName('张三')).toBe('*三')
    expect(maskName('John Smith')).toBe('J*** Smith')
    expect(maskName('  ')).toBe('')
  })
})

describe('uploadKycImage (common/upload_img)', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    session.clear()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    session.clear()
  })

  const ok = (data: unknown) => new Response(JSON.stringify({ code: '0', msg: 'ok', data }), { status: 200 })

  it('posts multipart with the session cookie, no JSON content type, and returns filenameStr first', async () => {
    session.setToken('tok')
    fetchMock.mockResolvedValue(ok({ filename: 'common/image/p.png', filenameStr: 'common/authImage/p.png?sig', base_image_url: 'https://oss/' }))
    const result = await uploadKycImage(new Blob(['x'], { type: 'image/png' }), 'firstPhoto')
    expect(result).toEqual({ key: 'common/authImage/p.png?sig' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/fe-ex-api/common/upload_img')
    const headers = init.headers as Record<string, string>
    expect(headers['exchange-token']).toBeUndefined()
    expect(headers['Content-Type']).toBeUndefined()
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get('firstPhoto')).toBeInstanceOf(Blob)
    expect(init.credentials).toBe('same-origin')
  })

  it('falls back to the public filename', async () => {
    fetchMock.mockResolvedValue(ok({ filename: 'common/image/p.png', filenameStr: '', base_image_url: 'https://oss/' }))
    await expect(uploadKycImage(new Blob(['x']), 'secondPhoto')).resolves.toEqual({ key: 'common/image/p.png' })
  })

  it('surfaces server errors and clears the session on a confirmed 10002', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: '10027', msg: 'bad type' }), { status: 200 }))
    await expect(uploadKycImage(new Blob(['x']), 'firstPhoto')).rejects.toMatchObject({ kind: 'api', code: '10027', message: 'bad type' })
    session.setToken('synthetic-token')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: '10002', msg: 'Not logged in' }), { status: 200 }))
    // The rejection is confirmed with one `common/user_info` probe on the same token.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: '10002', msg: 'Not logged in' }), { status: 200 }))
    await expect(uploadKycImage(new Blob(['x']), 'firstPhoto')).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('common/user_info')
    expect(session.getToken()).toBeNull()
  })

  it('rejects a success envelope without a key', async () => {
    fetchMock.mockResolvedValue(ok({ filename: '', filenameStr: '' }))
    await expect(uploadKycImage(new Blob(['x']), 'firstPhoto')).rejects.toMatchObject({ kind: 'parse' })
  })

  it('reports network failures honestly', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(uploadKycImage(new Blob(['x']), 'firstPhoto')).rejects.toMatchObject({ kind: 'network' })
  })
})
