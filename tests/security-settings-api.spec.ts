// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isApiError } from '@/core/errors'
import * as api from '@/modules/api/security-settings.api'
import { request } from '@/modules/api/http'
import {
  classifyTotpFailure,
  firstNonEmptyText,
  formatSecretGroups,
  sanitizeOtpInput,
  isBase32Secret,
  isProvisioningUri,
  isSubmittableGoogleKey,
  isValidPassword,
  isValidVerificationCode,
  maskSecret,
  readActivityResult,
  readFactorState,
  readKycStatus,
  readText,
  redactSensitive,
  safeQrImage,
  securityOperationKey,
  totalPages,
} from '@/modules/security/security-state'

const BASE32_SECRET = 'JBSWY3DPEHPK3PXP'

// Synthetic only: no request leaves this process.
vi.mock('@/modules/api/http', () => ({ request: vi.fn() }))

const mockedRequest = vi.mocked(request)

beforeEach(() => {
  vi.resetAllMocks()
})

describe('security-settings API contract (legacy-recovered paths)', () => {
  it('starts TOTP enrollment with the exact legacy path and no signature', async () => {
    mockedRequest.mockResolvedValue({
      googleImg: 'data:image/png;base64,AAAA',
      googleKey: 'JBSWY3DPEHPK3PXP',
    })
    const enrollment = await api.startTotpEnrollment()
    expect(mockedRequest).toHaveBeenCalledWith('user/toopen_google_authenticator', { body: {} })
    expect(enrollment).toEqual({
      qrImage: 'data:image/png;base64,AAAA',
      secret: 'JBSWY3DPEHPK3PXP',
    })
  })

  it('reports an honest parse error when the server returns no QR and no secret', async () => {
    mockedRequest.mockResolvedValue({})
    await expect(api.startTotpEnrollment()).rejects.toMatchObject({
      kind: 'parse',
      code: '',
      message: 'security.error.enrollmentUnsupported',
    })
  })

  it('rejects a non-object enrollment payload without echoing response values', async () => {
    mockedRequest.mockResolvedValue('not-an-object')
    try {
      await api.startTotpEnrollment()
      throw new Error('expected rejection')
    } catch (error) {
      expect(isApiError(error)).toBe(true)
      if (isApiError(error)) {
        expect(error.kind).toBe('parse')
        expect(error.message).not.toContain('not-an-object')
      }
    }
  })

  it('verifies TOTP with the exact legacy field names and payload signing', async () => {
    mockedRequest.mockResolvedValue(null)
    await api.verifyTotpEnrollment({ secret: BASE32_SECRET, code: '123456', loginPassword: 'Passw0rdXY' })
    expect(mockedRequest).toHaveBeenCalledWith('user/google_verify', {
      body: { googleKey: BASE32_SECRET, googleCode: '123456', loginPwd: 'Passw0rdXY' },
      signed: true,
    })
  })

  it('never submits a blank or provisioning-URI secret as googleKey', async () => {
    mockedRequest.mockResolvedValue(null)
    await expect(
      api.verifyTotpEnrollment({
        secret: 'otpauth://totp/Exchange:user?secret=JBSWY3DP',
        code: '123456',
        loginPassword: 'Passw0rdXY',
      }),
    ).rejects.toMatchObject({ kind: 'parse' })
    await expect(
      api.verifyTotpEnrollment({ secret: '   ', code: '123456', loginPassword: 'Passw0rdXY' }),
    ).rejects.toMatchObject({ kind: 'parse' })
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('changes the password with legacy keys, signing, and only the required factors', async () => {
    mockedRequest.mockResolvedValue(null)
    await api.updatePassword({
      loginPword: 'OldPass123',
      newLoginPword: 'NewPass456',
      googleCode: '654321',
    })
    expect(mockedRequest).toHaveBeenCalledWith('user/password_update', {
      body: { loginPword: 'OldPass123', newLoginPword: 'NewPass456', googleCode: '654321' },
      signed: true,
    })
  })

  it('sends the password-change SMS discriminator used by the legacy screen', async () => {
    mockedRequest.mockResolvedValue(null)
    await api.requestSecuritySmsCode(5)
    expect(mockedRequest).toHaveBeenCalledWith('v4/common/smsValidCode', { body: { operationType: 5 } })
  })

  it('pages login history and preserves every returned string', async () => {
    mockedRequest.mockResolvedValue({
      count: '37',
      historyLoginList: [
        { formatLgInTime: '2026-09-01 10:00:00', lgIp: '203.0.113.9', lgPlatform: 'Chrome', lgStatus: 1 },
        { formatLgInTime: '2026-09-02 11:00:00', lgIp: '203.0.113.10', lgPlatform: 'Safari', lgStatus: 0 },
      ],
    })
    const page = await api.fetchLoginHistory({ page: 2, pageSize: 10 })
    expect(mockedRequest).toHaveBeenCalledWith('security/login_history', { body: { page: 2, pageSize: 10 } })
    expect(page.count).toBe(37)
    expect(page.items[0]).toEqual({
      time: '2026-09-01 10:00:00',
      ip: '203.0.113.9',
      platform: 'Chrome',
      status: '1',
    })
  })

  it('pages security-settings history and maps its legacy fields', async () => {
    mockedRequest.mockResolvedValue({
      count: 1,
      historySettingList: [{ formatCtime: '2026-09-03 09:30:00', optTypeName: '密码修改', optIp: '198.51.100.4' }],
    })
    const page = await api.fetchSettingHistory({ page: 1, pageSize: 10 })
    expect(mockedRequest).toHaveBeenCalledWith('security/setting_history', { body: { page: 1, pageSize: 10 } })
    expect(page.items).toEqual([
      { time: '2026-09-03 09:30:00', operation: '密码修改', ip: '198.51.100.4' },
    ])
  })

  it('QA143 leaves future and prototype-named operation codes unknown', () => {
    expect(securityOperationKey('11')).toBe('enableTotp')
    for (const code of ['99', 'constructor', 'toString', '__proto__', '', undefined]) expect(securityOperationKey(code)).toBeNull()
  })

  it('QA143 preserves optType when translated optTypeName is empty', async () => {
    mockedRequest.mockResolvedValue({ count: 2, historySettingList: [{ optTypeName: '', optType: 11 }, { optTypeName: ' ', optType: '99' }] })
    const page = await api.fetchSettingHistory({ page: 1, pageSize: 10 })
    expect(page.items.map(item => [item.operation, item.operationType])).toEqual([['', '11'], [' ', '99']])
  })

  it('fails closed when a history response does not match the contract', async () => {
    mockedRequest.mockResolvedValue({ count: 'not-a-number', historyLoginList: 'nope' })
    await expect(api.fetchLoginHistory({ page: 1, pageSize: 10 })).rejects.toMatchObject({
      kind: 'parse',
    })
  })

  it('rejects a {} history envelope instead of reporting a successful empty page', async () => {
    mockedRequest.mockResolvedValue({})
    await expect(api.fetchLoginHistory({ page: 1, pageSize: 10 })).rejects.toMatchObject({ kind: 'parse' })
    await expect(api.fetchSettingHistory({ page: 1, pageSize: 10 })).rejects.toMatchObject({ kind: 'parse' })
  })

  it('accepts a genuine empty page (count 0 with an empty array) as distinct from {}', async () => {
    mockedRequest.mockResolvedValue({ count: 0, historyLoginList: [] })
    await expect(api.fetchLoginHistory({ page: 1, pageSize: 10 })).resolves.toEqual({ count: 0, items: [] })
    mockedRequest.mockResolvedValue({ count: '0', historySettingList: [] })
    await expect(api.fetchSettingHistory({ page: 1, pageSize: 10 })).resolves.toEqual({ count: 0, items: [] })
  })

  it('rejects a history response that omits the count or the list array', async () => {
    mockedRequest.mockResolvedValue({ historyLoginList: [] })
    await expect(api.fetchLoginHistory({ page: 1, pageSize: 10 })).rejects.toMatchObject({ kind: 'parse' })
    mockedRequest.mockResolvedValue({ count: 1 })
    await expect(api.fetchSettingHistory({ page: 1, pageSize: 10 })).rejects.toMatchObject({ kind: 'parse' })
  })

  it('never echoes response values in a parse error message', async () => {
    mockedRequest.mockResolvedValue({ count: 'sensitive-value', historyLoginList: 'nope' })
    try {
      await api.fetchLoginHistory({ page: 1, pageSize: 10 })
      throw new Error('expected rejection')
    } catch (error) {
      expect(isApiError(error)).toBe(true)
      if (isApiError(error)) {
        expect(error.message).not.toContain('sensitive-value')
        expect(error.message).not.toContain('nope')
      }
    }
  })
})

describe('account-security state helpers', () => {
  it('never reports a factor as off when the API did not return it', () => {
    expect(readFactorState(undefined)).toBe('unknown')
    expect(readFactorState(null)).toBe('unknown')
    expect(readFactorState('')).toBe('unknown')
    expect(readFactorState('1')).toBe('enabled')
    expect(readFactorState(1)).toBe('enabled')
    expect(readFactorState('0')).toBe('disabled')
  })

  it('maps authLevel using the legacy 0/1/2/3 meaning', () => {
    expect(readKycStatus('1')).toEqual({ raw: '1', key: 'verified' })
    expect(readKycStatus(0)).toEqual({ raw: '0', key: 'pending' })
    expect(readKycStatus('2')).toEqual({ raw: '2', key: 'rejected' })
    expect(readKycStatus('3')).toEqual({ raw: '3', key: 'unverified' })
    expect(readKycStatus(undefined)).toEqual({ raw: '', key: 'unknown' })
    expect(readKycStatus('9')).toEqual({ raw: '9', key: 'unknown' })
  })

  it('distinguishes an omitted field from an empty one', () => {
    expect(readText(undefined)).toEqual({ known: false, value: '' })
    expect(readText('1000')).toEqual({ known: true, value: '1000' })
    expect(readText(42)).toEqual({ known: true, value: '42' })
    expect(firstNonEmptyText('', undefined, 't***@example.com')).toEqual({
      known: true,
      value: 't***@example.com',
    })
    expect(firstNonEmptyText(undefined, '')).toEqual({ known: false, value: '' })
  })

  it('enforces the legacy password and 6-digit code rules', () => {
    expect(isValidPassword('Passw0rdXY')).toBe(true)
    expect(isValidPassword('short1')).toBe(false)
    expect(isValidPassword('passwordonly')).toBe(false)
    expect(isValidPassword('Password 1')).toBe(false)
    expect(isValidVerificationCode('123456')).toBe(true)
    expect(isValidVerificationCode('12345')).toBe(false)
    expect(isValidVerificationCode('12345a')).toBe(false)
  })

  it('renders only server-produced same-origin QR images', () => {
    const origin = 'https://exchange.example'
    expect(safeQrImage('data:image/png;base64,AAAA', origin)).toBe('data:image/png;base64,AAAA')
    expect(safeQrImage('/static/qr.png', origin)).toBe('/static/qr.png')
    expect(safeQrImage('https://exchange.example/qr.png', origin)).toBe('https://exchange.example/qr.png')
    expect(safeQrImage('https://third-party.example/qr.png', origin)).toBe('')
    expect(safeQrImage('data:image/svg+xml;base64,AAAA', origin)).toBe('')
    expect(safeQrImage('//third-party.example/qr.png', origin)).toBe('')
  })

  it('never derives the mask from the real secret', () => {
    expect(maskSecret()).not.toContain('JBSWY3DPEHPK3PXP')
    expect(isProvisioningUri('otpauth://totp/x?secret=ABC')).toBe(true)
    expect(isProvisioningUri('JBSWY3DPEHPK3PXP')).toBe(false)
  })

  it('accepts only a base32 secret as a submittable googleKey', () => {
    expect(isBase32Secret(BASE32_SECRET)).toBe(true)
    expect(isBase32Secret('jbswy3dpehpk3pxp')).toBe(true)
    expect(isBase32Secret('JBSW Y3DP EHPK 3PXP')).toBe(true)
    expect(isBase32Secret('otpauth://totp/x?secret=JBSWY3DP')).toBe(false)
    expect(isBase32Secret('123456789')).toBe(false)
    expect(isBase32Secret('')).toBe(false)

    expect(isSubmittableGoogleKey(BASE32_SECRET)).toBe(true)
    expect(isSubmittableGoogleKey('')).toBe(false)
    expect(isSubmittableGoogleKey('   ')).toBe(false)
    expect(isSubmittableGoogleKey('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP')).toBe(false)
  })

  it('redacts submitted secrets, codes and passwords from a diagnostic message', () => {
    const message = redactSensitive(`rejected ${BASE32_SECRET} code 123456 pwd OldPass123`, [
      BASE32_SECRET,
      '123456',
      'OldPass123',
    ])
    expect(message).not.toContain(BASE32_SECRET)
    expect(message).not.toContain('123456')
    expect(message).not.toContain('OldPass123')
    expect(message).toContain('rejected')
  })

  it('treats lgStatus 1 as success and keeps unknown values honest', () => {
    expect(readActivityResult('1')).toBe('success')
    expect(readActivityResult('0')).toBe('failure')
    expect(readActivityResult('')).toBe('unknown')
    expect(totalPages(0, 10)).toBe(1)
    expect(totalPages(21, 10)).toBe(3)
  })
})

describe('TOTP input helpers (2026-09-27)', () => {
  it('keeps digits only and caps at six', () => {
    expect(sanitizeOtpInput('123 456')).toBe('123456')
    expect(sanitizeOtpInput('Code: 12-34-56-78')).toBe('123456')
    expect(sanitizeOtpInput('abc')).toBe('')
  })
  it('groups a base32 secret by four', () => {
    expect(formatSecretGroups('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP')
    expect(formatSecretGroups('ABCDEF')).toBe('ABCD EF')
    expect(formatSecretGroups('')).toBe('')
  })
  it('maps google_verify failure codes', () => {
    expect(classifyTotpFailure('10010')).toBe('code')
    expect(classifyTotpFailure('10050')).toBe('password')
    expect(classifyTotpFailure('10011')).toBe('password')
    expect(classifyTotpFailure('10001')).toBe('other')
  })
})
