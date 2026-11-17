// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isApiError } from '@/core/errors'
import * as api from '@/modules/api/account-settings.api'
import { request } from '@/modules/api/http'
import {
  isValidDialCode,
  isValidIpv4,
  isValidMobile,
  isLegacyEmail,
  maskApiSecret,
  maskEmail,
  maskMobile,
  normalizeIpAllowlist,
} from '@/modules/account/account-state'

// Synthetic only: no request leaves this process.
vi.mock('@/modules/api/http', () => ({ request: vi.fn() }))

const mockedRequest = vi.mocked(request)

function calledBody(): Record<string, unknown> {
  const calls = mockedRequest.mock.calls
  const last = calls[calls.length - 1]
  return (last?.[1] as { body?: Record<string, unknown> } | undefined)?.body ?? {}
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('account-settings API contract (legacy-recovered paths)', () => {
  it('never exposes a stored-secret endpoint (no open_api_one)', () => {
    expect('openApiOne' in api).toBe(false)
    expect('fetchApiKey' in api).toBe(false)
    expect(Object.values(api.ACCOUNT_ENDPOINTS)).not.toContain('openapi/open_api_one')
  })

  it('binds an email with the exact v4 body (unsigned, trimmed)', async () => {
    mockedRequest.mockResolvedValue(null)
    await api.bindEmail({ email: '  new@example.com ', emailValidCode: ' 123456 ' })
    expect(mockedRequest).toHaveBeenCalledWith('user/email_bind_save_v4', {
      body: { email: 'new@example.com', emailValidCode: '123456' },
    })
  })

  it('changes an email with Google only when only Google is enabled', async () => {
    mockedRequest.mockResolvedValue(null)
    await api.updateEmail({
      emailOldValidCode: '111111',
      email: 'new@example.com',
      emailNewValidCode: '222222',
      googleCode: '333333',
    })
    expect(mockedRequest).toHaveBeenCalledWith('user/email_update', {
      body: {
        emailOldValidCode: '111111',
        email: 'new@example.com',
        emailNewValidCode: '222222',
        googleCode: '333333',
      },
    })
    // The disabled factor must not be invented into the body.
    expect(calledBody()).not.toHaveProperty('smsValidCode')
  })

  it('changes an email with SMS only when only SMS is enabled', async () => {
    mockedRequest.mockResolvedValue(null)
    await api.updateEmail({
      emailOldValidCode: '111111',
      email: 'new@example.com',
      emailNewValidCode: '222222',
      smsValidCode: '444444',
    })
    expect(calledBody()).toEqual({
      emailOldValidCode: '111111',
      email: 'new@example.com',
      emailNewValidCode: '222222',
      smsValidCode: '444444',
    })
    expect(calledBody()).not.toHaveProperty('googleCode')
  })

  it('sends the new-address code to the new email and the old-address code with no email', async () => {
    mockedRequest.mockResolvedValue(null)
    await api.sendEmailCode({ email: 'new@example.com', operationType: api.EMAIL_OPERATION.bindEmail })
    expect(mockedRequest).toHaveBeenCalledWith('v4/common/emailValidCode', {
      body: { operationType: 2, email: 'new@example.com' },
    })
    await api.sendEmailCode({ operationType: api.EMAIL_OPERATION.updateEmailOld })
    expect(mockedRequest).toHaveBeenLastCalledWith('v4/common/emailValidCode', {
      body: { operationType: 15 },
    })
    expect(calledBody()).not.toHaveProperty('email')
  })

  it('binds a phone number with the exact body and only includes Google when required', async () => {
    mockedRequest.mockResolvedValue(null)
    await api.bindMobile({
      countryCode: '+86',
      mobileNumber: '13800000000',
      smsAuthCode: '123456',
      googleCode: '654321',
    })
    expect(mockedRequest).toHaveBeenCalledWith('user/mobile_bind_save', {
      body: {
        countryCode: '+86',
        mobileNumber: '13800000000',
        smsAuthCode: '123456',
        googleCode: '654321',
      },
    })
    await api.bindMobile({ countryCode: '+1', mobileNumber: '2025550123', smsAuthCode: '111111' })
    expect(calledBody()).not.toHaveProperty('googleCode')
  })

  it('changes a phone number with both the old and new codes plus Google when required', async () => {
    mockedRequest.mockResolvedValue(null)
    await api.updateMobile({
      countryCode: '+86',
      mobileNumber: '13900000000',
      smsAuthCode: '222222',
      authenticationCode: '333333',
      googleCode: '444444',
    })
    expect(mockedRequest).toHaveBeenCalledWith('user/mobile_update', {
      body: {
        countryCode: '+86',
        mobileNumber: '13900000000',
        smsAuthCode: '222222',
        authenticationCode: '333333',
        googleCode: '444444',
      },
    })
  })

  it('sends each SMS operation type separately (no union-of-fields)', async () => {
    mockedRequest.mockResolvedValue(null)
    await api.sendSmsCode({ operationType: api.SMS_OPERATION.openApi })
    expect(mockedRequest).toHaveBeenLastCalledWith('v4/common/smsValidCode', { body: { operationType: 16 } })

    await api.sendSmsCode({ operationType: api.SMS_OPERATION.updateMobileOld })
    expect(mockedRequest).toHaveBeenLastCalledWith('v4/common/smsValidCode', { body: { operationType: 3 } })

    await api.sendSmsCode({ operationType: api.SMS_OPERATION.updateEmailOld })
    expect(mockedRequest).toHaveBeenLastCalledWith('v4/common/smsValidCode', { body: { operationType: 15 } })

    await api.sendSmsCode({
      countryCode: '+86',
      mobile: '13800000000',
      operationType: api.SMS_OPERATION.bindMobile,
    })
    expect(mockedRequest).toHaveBeenLastCalledWith('v4/common/smsValidCode', {
      body: { operationType: 2, mobile: '13800000000', countryCode: '+86' },
    })
    expect(calledBody()).not.toHaveProperty('signed')
  })

  it('lists API keys and preserves every returned field', async () => {
    mockedRequest.mockResolvedValue({
      count: '3',
      apiList: [
        { id: 1, token: 'tk-1', believeIps: '203.0.113.9', label: 'bots' },
        { id: 2, token: 42, believeIps: null, label: null },
      ],
    })
    const page = await api.fetchApiKeys({ page: 1, pageSize: 10 })
    expect(mockedRequest).toHaveBeenCalledWith('openapi/my_api_list', {
      body: { page: 1, pageSize: 10 },
    })
    expect(page).toEqual({
      count: 3,
      items: [
        { token: 'tk-1', label: 'bots', ips: '203.0.113.9', permissions: { earn: false, loan: false } },
        { token: '42', label: '', ips: '', permissions: { earn: false, loan: false } },
      ],
    })
  })

  it('fails closed on a malformed key list without echoing response values', async () => {
    mockedRequest.mockResolvedValue({ count: 1 })
    await expect(api.fetchApiKeys({ page: 1, pageSize: 10 })).rejects.toMatchObject({ kind: 'parse' })

    mockedRequest.mockResolvedValue({ apiList: [], count: 'secret-value' })
    try {
      await api.fetchApiKeys({ page: 1, pageSize: 10 })
      throw new Error('expected rejection')
    } catch (error) {
      expect(isApiError(error)).toBe(true)
      if (isApiError(error)) {
        expect(error.kind).toBe('parse')
        expect(error.message).not.toContain('secret-value')
      }
    }
  })

  it('accepts a genuine empty key page as distinct from a {} envelope', async () => {
    mockedRequest.mockResolvedValue({ count: 0, apiList: [] })
    await expect(api.fetchApiKeys({ page: 1, pageSize: 10 })).resolves.toEqual({ count: 0, items: [] })
    mockedRequest.mockResolvedValue({})
    await expect(api.fetchApiKeys({ page: 1, pageSize: 10 })).rejects.toMatchObject({ kind: 'parse' })
  })

  it('reads the live keyless reply (apiList null, count 0) as empty, but not null with a count', async () => {
    mockedRequest.mockResolvedValue({ count: 0, pageSize: 10, apiList: null })
    await expect(api.fetchApiKeys({ page: 1, pageSize: 10 })).resolves.toEqual({ count: 0, items: [] })
    mockedRequest.mockResolvedValue({ count: 2, apiList: null })
    await expect(api.fetchApiKeys({ page: 1, pageSize: 10 })).rejects.toMatchObject({ kind: 'parse' })
  })

  it('creates an API key with the exact body and surfaces the one-time secret', async () => {
    mockedRequest.mockResolvedValue({
      secretKey: 'one-time-secret',
      token: 'tk-new',
      qrCode: 'data:image/png;base64,AAAA',
    })
    const created = await api.createApiKey({
      believeIps: '203.0.113.9',
      label: 'main',
      permissions: { earn: true, loan: false },
      googleCode: '123456',
    })
    expect(mockedRequest).toHaveBeenCalledWith('openapi/create_open_api', {
      body: { believeIps: '203.0.113.9', label: 'main', authority: 'earn', googleCode: '123456' },
    })
    expect(created).toEqual({
      secretKey: 'one-time-secret',
      token: 'tk-new',
      qrCode: 'data:image/png;base64,AAAA',
    })
  })

  it('creates an API key with SMS only and no Google field when Google is off', async () => {
    mockedRequest.mockResolvedValue({ secretKey: 's', token: 't', qrCode: '' })
    await api.createApiKey({ believeIps: '', label: 'lt', permissions: { earn: false, loan: false }, smsValidCode: '999999' })
    expect(calledBody()).toEqual({ believeIps: '', label: 'lt', authority: '', smsValidCode: '999999' })
    expect(calledBody()).not.toHaveProperty('googleCode')
  })

  it('rejects a create response without a secret, never echoing values', async () => {
    mockedRequest.mockResolvedValue({ token: 'tk-leak' })
    try {
      await api.createApiKey({ believeIps: '', label: 'x', permissions: { earn: false, loan: false }, googleCode: '123456' })
      throw new Error('expected rejection')
    } catch (error) {
      expect(isApiError(error)).toBe(true)
      if (isApiError(error)) {
        expect(error.kind).toBe('parse')
        expect(error.message).not.toContain('tk-leak')
      }
    }
  })

  it('edits an API key with token + allowlist + label and the required factor codes', async () => {
    mockedRequest.mockResolvedValue(null)
    await api.updateApiKey({
      token: 'tk-1',
      believeIps: '203.0.113.9,203.0.113.10',
      label: 'renamed',
      permissions: { earn: true, loan: true },
      smsValidCode: '555555',
      googleCode: '666666',
    })
    expect(mockedRequest).toHaveBeenCalledWith('openapi/update_open_api', {
      body: {
        token: 'tk-1',
        believeIps: '203.0.113.9,203.0.113.10',
        label: 'renamed',
        authority: 'earn,loan',
        smsValidCode: '555555',
        googleCode: '666666',
      },
    })
  })

  it('deletes an API key with the token and the bound second-factor codes', async () => {
    mockedRequest.mockResolvedValue(null)
    await api.deleteApiKey({ token: 'tk-9', googleCode: '123456' })
    expect(mockedRequest).toHaveBeenCalledWith('openapi/delete_open_api', { body: { token: 'tk-9', googleCode: '123456' } })
    await api.deleteApiKey({ token: 'tk-8', smsValidCode: ' 555555 ', googleCode: '' })
    expect(calledBody()).toEqual({ token: 'tk-8', smsValidCode: '555555' })
  })

  it('maps authority text to permissions and back', () => {
    expect(api.parseAuthority(undefined)).toEqual({ earn: false, loan: false })
    expect(api.parseAuthority(' Loan ,earn,x')).toEqual({ earn: true, loan: true })
    expect(api.formatAuthority({ earn: false, loan: true })).toBe('loan')
    expect(api.formatAuthority({ earn: false, loan: false })).toBe('')
  })
})

describe('account-state helpers', () => {
  it('normalises the IP allowlist like the legacy dealIp helper', () => {
    expect(normalizeIpAllowlist('')).toEqual({ ok: true, value: '' })
    expect(normalizeIpAllowlist('  ')).toEqual({ ok: true, value: '' })
    expect(normalizeIpAllowlist('203.0.113.9')).toEqual({ ok: true, value: '203.0.113.9' })
    expect(normalizeIpAllowlist('203.0.113.9,')).toEqual({ ok: true, value: '203.0.113.9' })
    expect(normalizeIpAllowlist('203.0.113.9, 203.0.113.10')).toEqual({
      ok: true,
      value: '203.0.113.9,203.0.113.10',
    })
    expect(normalizeIpAllowlist('1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4,5.5.5.5')).toEqual({
      ok: true,
      value: '1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4,5.5.5.5',
    })
    expect(normalizeIpAllowlist('1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4,5.5.5.5,6.6.6.6')).toEqual({
      ok: false,
      reason: 'tooMany',
    })
    expect(normalizeIpAllowlist('999.1.1.1')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeIpAllowlist('1.1.1.1,,2.2.2.2')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeIpAllowlist('1.1.1.1.')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('applies the exact legacy IPv4, email, phone and dial-code rules', () => {
    expect(isValidIpv4('203.0.113.9')).toBe(true)
    expect(isValidIpv4('256.0.0.1')).toBe(false)
    expect(isValidIpv4('1.2.3')).toBe(false)
    expect(isLegacyEmail('user@example.com')).toBe(true)
    expect(isLegacyEmail('user.example.com')).toBe(false)
    expect(isValidMobile('13800000000')).toBe(true)
    expect(isValidMobile('123456')).toBe(false)
    expect(isValidDialCode('+86')).toBe(true)
    expect(isValidDialCode('86')).toBe(false)
  })

  it('masks bound identifiers without deriving them from the real value', () => {
    expect(maskEmail('user@example.com')).not.toContain('user@example.com')
    expect(maskEmail('user@example.com')).toContain('@example.com')
    expect(maskEmail('t***@example.com')).toBe('t***@example.com')
    expect(maskEmail('')).toBe('')

    expect(maskMobile('13800000000')).not.toContain('13800000000')
    expect(maskMobile('13800000000').endsWith('0000')).toBe(true)
    expect(maskMobile('138****8888')).toBe('138****8888')
    expect(maskMobile('')).toBe('')

    expect(maskApiSecret()).not.toContain('one-time-secret')
    expect(maskApiSecret()).toContain('•')
  })
})
