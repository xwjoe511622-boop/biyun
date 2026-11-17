// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isApiError } from '@/core/errors'
import { request } from '@/modules/api/http'
import * as api from '@/modules/api/onboarding.api'

// Synthetic only: no request leaves this process.
vi.mock('@/modules/api/http', () => ({ request: vi.fn() }))

const mockedRequest = vi.mocked(request)

const ALIYUN_PROOF: api.CaptchaProof = {
  verificationType: '1',
  csessionid: 'cs-1',
  sig: 'sig-1',
  token: 'appkey:register:1:0.5',
  scene: 'login',
}

/** Captcha keys the register controllers require to be *present* even when unused. */
const EMPTY_CAPTCHA_FIELDS = {
  csessionid: '',
  sig: '',
  token: '',
  scene: '',
  geetest_challenge: '',
  geetest_validate: '',
  geetest_seccode: '',
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('onboarding API contract (legacy-recovered paths)', () => {
  it('sends the registration email info as a signed, session-free body with the exact field names', async () => {
    mockedRequest.mockResolvedValue({ token: 'reg-token' })
    const token = await api.registerEmailCheckInfo({
      email: 'new@example.com',
      password: 'Passw0rd1',
      confirmPassword: 'Passw0rd1',
      invitedCode: ' INV-1 ',
      captcha: ALIYUN_PROOF,
    })
    expect(token).toBe('reg-token')
    expect(mockedRequest).toHaveBeenCalledWith('user/reg_email_chk_info', {
      body: {
        verificationType: '1',
        csessionid: 'cs-1',
        sig: 'sig-1',
        token: 'appkey:register:1:0.5',
        scene: 'login',
        geetest_challenge: '',
        geetest_validate: '',
        geetest_seccode: '',
        email: 'new@example.com',
        loginPword: 'Passw0rd1',
        newPassword: 'Passw0rd1',
        invitedCode: 'INV-1',
      },
      signed: true,
      anonymous: true,
    })
  })

  it('always includes the geetest keys so `checkParamIsNull` passes, even with no slider configured', async () => {
    mockedRequest.mockResolvedValue({ token: 'reg-token' })
    await api.registerEmailCheckInfo({
      email: 'new@example.com',
      password: 'Passw0rd1',
      confirmPassword: 'Passw0rd1',
      captcha: { verificationType: '1' },
    })
    const [, options] = mockedRequest.mock.calls[0] as [string, { body: Record<string, string> }]
    expect(options.body).toMatchObject(EMPTY_CAPTCHA_FIELDS)
    expect(options.body.verificationType).toBe('1')
    expect(options.body.invitedCode).toBeUndefined()
  })

  it('normalizes the country code for phone registration', async () => {
    mockedRequest.mockResolvedValue({ token: 'reg-token' })
    await api.registerMobileCheckInfo({
      countryCode: '+86',
      mobileNumber: '13800000000',
      password: 'Passw0rd1',
      confirmPassword: 'Passw0rd1',
      captcha: ALIYUN_PROOF,
    })
    const [, options] = mockedRequest.mock.calls[0] as [string, { body: Record<string, string> }]
    expect(options.body.countryCode).toBe('86')
    expect(options.body.mobileNumber).toBe('13800000000')
    expect(mockedRequest).toHaveBeenCalledWith('user/reg_mobile_chk_info', expect.objectContaining({ signed: true, anonymous: true }))
  })

  it('never turns a tokenless registration response into a success', async () => {
    mockedRequest.mockResolvedValue({})
    await expect(
      api.registerEmailCheckInfo({
        email: 'new@example.com',
        password: 'Passw0rd1',
        confirmPassword: 'Passw0rd1',
        captcha: { verificationType: '1' },
      }),
    ).rejects.toMatchObject({ kind: 'parse', code: '', message: 'auth.error.malformed' })
  })

  it('refuses a registration body with a blank email before any request', async () => {
    await expect(
      api.registerEmailCheckInfo({
        email: '   ',
        password: 'Passw0rd1',
        confirmPassword: 'Passw0rd1',
        captcha: { verificationType: '1' },
      }),
    ).rejects.toMatchObject({ kind: 'api', message: 'auth.error.badRequest' })
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('confirms the email registration with a plain, session-free body', async () => {
    mockedRequest.mockResolvedValue({})
    const result = await api.registerEmailConfirm({ token: 'reg-token', emailCode: '123456' })
    expect(mockedRequest).toHaveBeenCalledWith('user/reg_email_confirm', {
      body: { token: 'reg-token', emailCode: '123456' },
      anonymous: true,
    })
    expect(result.autoLoginToken).toBeNull()
  })

  it('only reports an auto-login token when the server returns a non-empty string', async () => {
    mockedRequest.mockResolvedValue({ token: 'jwt-from-server', uid: 7 })
    const result = await api.registerEmailConfirm({ token: 'reg-token', emailCode: '123456' })
    expect(result.autoLoginToken).toBe('jwt-from-server')

    mockedRequest.mockResolvedValue({ token: true })
    const coerced = await api.registerEmailConfirm({ token: 'reg-token', emailCode: '123456' })
    expect(coerced.autoLoginToken).toBeNull()
  })

  it('reports a cookie-mode auto-login without any token (10-17)', async () => {
    mockedRequest.mockResolvedValue({ uid: 7, session: 'cookie' })
    const result = await api.registerEmailConfirm({ token: 'reg-token', emailCode: '123456' })
    expect(result).toEqual({ autoLoginToken: null, cookieSession: true })
    mockedRequest.mockResolvedValue({ uid: 7, session: 'header' })
    expect((await api.registerEmailConfirm({ token: 'reg-token', emailCode: '123456' })).cookieSession).toBe(false)
  })

  it('confirms the phone registration with smsCode', async () => {
    mockedRequest.mockResolvedValue({})
    await api.registerMobileConfirm({ token: 'reg-token', smsCode: '654321' })
    expect(mockedRequest).toHaveBeenCalledWith('user/reg_mobile_confirm', {
      body: { token: 'reg-token', smsCode: '654321' },
      anonymous: true,
    })
  })

  it('sends the registration codes with the legacy operation types and no signature', async () => {
    mockedRequest.mockResolvedValue({})
    await api.sendRegisterEmailCode('reg-token')
    expect(mockedRequest).toHaveBeenCalledWith('v4/common/emailValidCode', {
      body: { token: 'reg-token', operationType: 1 },
      anonymous: true,
    })

    await api.sendRegisterSmsCode('reg-token', '+86')
    expect(mockedRequest).toHaveBeenCalledWith('v4/common/smsValidCode', {
      body: { token: 'reg-token', countryCode: '86', operationType: 1 },
      anonymous: true,
    })
  })

  it('starts password recovery with a plain, session-free body per mode', async () => {
    mockedRequest.mockResolvedValue({ token: 'rec-token', isGoogleAuth: '1', isCertificateNumber: '0' })
    const challenge = await api.resetPasswordStepOne({ mode: 'email', email: 'u@example.com', captcha: ALIYUN_PROOF })
    expect(mockedRequest).toHaveBeenCalledWith('v4/user/reset_password_step_one', {
      body: {
        verificationType: '1',
        csessionid: 'cs-1',
        sig: 'sig-1',
        token: 'appkey:register:1:0.5',
        scene: 'login',
        geetest_challenge: '',
        geetest_validate: '',
        geetest_seccode: '',
        email: 'u@example.com',
      },
      anonymous: true,
    })
    expect(challenge).toEqual({ token: 'rec-token', googleRequired: true, certificateRequired: false })

    mockedRequest.mockResolvedValue({ token: 'rec-token', isGoogleAuth: '0', isCertificateNumber: '1' })
    const phoneChallenge = await api.resetPasswordStepOne({
      mode: 'phone',
      mobileNumber: '13800000000',
      captcha: { verificationType: '1' },
    })
    const [, options] = mockedRequest.mock.calls[1] as [string, { body: Record<string, string> }]
    expect(options.body.mobileNumber).toBe('13800000000')
    expect(options.body.email).toBeUndefined()
    expect(phoneChallenge).toEqual({ token: 'rec-token', googleRequired: false, certificateRequired: true })
  })

  it('reports an unknown factor flag instead of assuming it is off', async () => {
    mockedRequest.mockResolvedValue({ token: 'rec-token' })
    const challenge = await api.resetPasswordStepOne({ mode: 'email', email: 'u@example.com', captcha: { verificationType: '1' } })
    expect(challenge).toEqual({ token: 'rec-token', googleRequired: null, certificateRequired: null })
  })

  it('rejects a recovery step one without a token', async () => {
    mockedRequest.mockResolvedValue({ isGoogleAuth: '0' })
    await expect(
      api.resetPasswordStepOne({ mode: 'email', email: 'u@example.com', captcha: { verificationType: '1' } }),
    ).rejects.toMatchObject({ kind: 'parse', message: 'auth.error.malformed' })
  })

  it('sends the recovery codes with operation types 3 / 24', async () => {
    mockedRequest.mockResolvedValue({})
    await api.sendRecoveryEmailCode('rec-token')
    expect(mockedRequest).toHaveBeenCalledWith('v4/common/emailValidCode', {
      body: { token: 'rec-token', operationType: 3 },
      anonymous: true,
    })
    await api.sendRecoverySmsCode('rec-token')
    expect(mockedRequest).toHaveBeenCalledWith('v4/common/smsValidCode', {
      body: { token: 'rec-token', operationType: 24 },
      anonymous: true,
    })
  })

  it('submits recovery step two with the exact server field names, including the certifcateNumber typo', async () => {
    mockedRequest.mockResolvedValue({})
    await api.resetPasswordStepTwo({
      token: 'rec-token',
      mode: 'email',
      code: '123456',
      googleCode: '654321',
      certificateNumber: 'ID-9',
    })
    expect(mockedRequest).toHaveBeenCalledWith('v4/user/reset_password_step_two', {
      body: { token: 'rec-token', googleCode: '654321', certifcateNumber: 'ID-9', emailCode: '123456' },
      anonymous: true,
    })

    await api.resetPasswordStepTwo({ token: 'rec-token', mode: 'phone', code: '111111' })
    expect(mockedRequest).toHaveBeenCalledWith('v4/user/reset_password_step_two', {
      body: { token: 'rec-token', googleCode: '', certifcateNumber: '', smsCode: '111111' },
      anonymous: true,
    })
  })

  it('signs recovery step three and keeps it session-free', async () => {
    mockedRequest.mockResolvedValue({})
    await api.resetPasswordStepThree({ token: 'rec-token', password: 'NewPassw0rd' })
    expect(mockedRequest).toHaveBeenCalledWith('user/reset_password_step_three', {
      body: { token: 'rec-token', loginPword: 'NewPassw0rd' },
      signed: true,
      anonymous: true,
    })
  })

  it('refuses a blank new password before any request', async () => {
    await expect(api.resetPasswordStepThree({ token: 'rec-token', password: '  ' })).rejects.toMatchObject({
      kind: 'api',
      message: 'auth.error.badRequest',
    })
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('sends the login step-two codes with operation types 25 / 4 and the challenge token', async () => {
    mockedRequest.mockResolvedValue({})
    await api.sendLoginSmsCode('challenge-token')
    expect(mockedRequest).toHaveBeenCalledWith('v4/common/smsValidCode', {
      body: { token: 'challenge-token', operationType: 25 },
      anonymous: true,
    })
    await api.sendLoginEmailCode('challenge-token')
    expect(mockedRequest).toHaveBeenCalledWith('v4/common/emailValidCode', {
      body: { token: 'challenge-token', operationType: 4 },
      anonymous: true,
    })
    // cookie mode: no body token, the server reads the HttpOnly challenge cookie
    await api.sendLoginSmsCode('')
    expect(mockedRequest).toHaveBeenLastCalledWith('v4/common/smsValidCode', { body: { operationType: 25 }, anonymous: true })
    await api.sendLoginEmailCode('')
    expect(mockedRequest).toHaveBeenLastCalledWith('v4/common/emailValidCode', { body: { operationType: 4 }, anonymous: true })
  })

  it('has no code to send for the Google factor', async () => {
    expect(api.sendLoginCode('1', 'challenge-token')).toBeNull()
    expect(api.sendLoginCode('2', 'challenge-token')).not.toBeNull()
    expect(api.sendLoginCode('3', 'challenge-token')).not.toBeNull()
  })

  it('flattens a Geetest proof into the register body with the three geetest_* fields', async () => {
    mockedRequest.mockResolvedValue({ token: 'reg-token' })
    await api.registerEmailCheckInfo({
      email: 'new@example.com',
      password: 'Passw0rd1',
      confirmPassword: 'Passw0rd1',
      captcha: {
        verificationType: '2',
        geetest_challenge: 'gc',
        geetest_validate: 'gv',
        geetest_seccode: 'gs',
      },
    })
    const [, options] = mockedRequest.mock.calls[0] as [string, { body: Record<string, string> }]
    expect(options.body).toMatchObject({
      verificationType: '2',
      geetest_challenge: 'gc',
      geetest_validate: 'gv',
      geetest_seccode: 'gs',
      csessionid: '',
      sig: '',
      token: '',
      scene: '',
    })
  })

  it('reports errors without echoing request values', async () => {
    try {
      await api.registerEmailConfirm({ token: 'reg-token', emailCode: '   ' })
      throw new Error('expected rejection')
    } catch (error) {
      expect(isApiError(error)).toBe(true)
      if (isApiError(error)) {
        expect(error.message).toBe('auth.error.badRequest')
        expect(error.message).not.toContain('reg-token')
      }
    }
  })

  it('forwards an abort signal only when the caller supplies one', async () => {
    mockedRequest.mockResolvedValue({})
    const controller = new AbortController()
    await api.resetPasswordStepThree({ token: 'rec-token', password: 'NewPassw0rd', signal: controller.signal })
    expect(mockedRequest).toHaveBeenCalledWith('user/reset_password_step_three', {
      body: { token: 'rec-token', loginPword: 'NewPassw0rd' },
      signed: true,
      anonymous: true,
      signal: controller.signal,
    })

    await api.sendRegisterEmailCode('reg-token')
    expect(mockedRequest).toHaveBeenLastCalledWith('v4/common/emailValidCode', {
      body: { token: 'reg-token', operationType: 1 },
      anonymous: true,
    })
  })
})

describe('Geetest challenge (common/tartCaptcha)', () => {
  it('starts the challenge with an anonymous, body-less POST', async () => {
    mockedRequest.mockResolvedValue({
      captcha: { gt: 'gt-1', challenge: 'challenge-1', success: true, new_captcha: true },
    })
    const challenge = await api.startTartCaptcha()
    expect(mockedRequest).toHaveBeenCalledWith('common/tartCaptcha', { anonymous: true })
    expect(challenge).toEqual({ gt: 'gt-1', challenge: 'challenge-1', success: true, newCaptcha: true })
  })

  it('reads the numeric success/new_captcha flags the geetest library returns', async () => {
    mockedRequest.mockResolvedValue({
      captcha: { gt: 'gt-1', challenge: 'challenge-1', success: 1, new_captcha: 1 },
    })
    const challenge = await api.startTartCaptcha()
    expect(challenge.success).toBe(true)
    expect(challenge.newCaptcha).toBe(true)
  })

  it('reports an offline challenge (success: 0) instead of turning it into a proof', async () => {
    // The backend only validates online (`enhencedValidateRequest`), so the widget must be able to
    // see `success: false` and refuse to init rather than setting `offline: true`.
    mockedRequest.mockResolvedValue({
      captcha: { gt: 'gt-1', challenge: 'challenge-1', success: 0, new_captcha: false },
    })
    const challenge = await api.startTartCaptcha()
    expect(challenge.success).toBe(false)
    expect(challenge.newCaptcha).toBe(false)
  })

  it('trims the strings but never coerces a blank gt/challenge into a challenge', async () => {
    mockedRequest.mockResolvedValue({
      captcha: { gt: '  gt-1  ', challenge: '  challenge-1  ', success: true, new_captcha: true },
    })
    const challenge = await api.startTartCaptcha()
    expect(challenge.gt).toBe('gt-1')
    expect(challenge.challenge).toBe('challenge-1')

    mockedRequest.mockResolvedValue({ captcha: { gt: '   ', challenge: 'challenge-1', success: true } })
    await expect(api.startTartCaptcha()).rejects.toMatchObject({
      kind: 'parse',
      code: '',
      message: 'auth.error.malformed',
    })
  })

  it('rejects a malformed captcha payload instead of initting with junk', async () => {
    for (const payload of [
      {},
      { captcha: null },
      { captcha: 'gt' },
      { captcha: { gt: 'gt-1' } },
      { captcha: { gt: 'gt-1', challenge: 'challenge-1' } },
      { captcha: { gt: 'gt-1', challenge: 'challenge-1', success: 'maybe' } },
    ]) {
      mockedRequest.mockResolvedValue(payload)
      await expect(api.startTartCaptcha()).rejects.toMatchObject({
        kind: 'parse',
        code: '',
        message: 'auth.error.malformed',
      })
    }
  })

  it('forwards the abort signal and keeps the challenge request session-free', async () => {
    mockedRequest.mockResolvedValue({
      captcha: { gt: 'gt-1', challenge: 'challenge-1', success: true, new_captcha: true },
    })
    const controller = new AbortController()
    await api.startTartCaptcha({ signal: controller.signal })
    expect(mockedRequest).toHaveBeenCalledWith('common/tartCaptcha', {
      anonymous: true,
      signal: controller.signal,
    })
  })
})
