// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import QRCode from 'qrcode'
import DepositQr from '@/components/wallet/DepositQr.vue'
import { generateDepositQrDataUrl } from '@/modules/wallet/depositQr'

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn() },
}))

let host: HTMLDivElement
let apps: App[] = []

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(QRCode.toDataURL).mockResolvedValue('data:image/png;base64,LOCAL')
  host = document.createElement('div')
  document.body.appendChild(host)
  apps = []
})

afterEach(() => {
  apps.forEach(app => app.unmount())
  document.body.innerHTML = ''
})

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

async function mount(render: () => ReturnType<typeof h>): Promise<void> {
  const Root = defineComponent({
    setup() {
      return render
    },
  })
  const app = createApp(Root)
  app.mount(host)
  apps.push(app)
  await flush()
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('deposit QR generation', () => {
  it('renders a plain address locally when the server QR is absent', async () => {
    await mount(() => h(DepositQr, { address: 'bc1qexample', remoteQr: '', alt: 'Deposit QR' }))

    expect(QRCode.toDataURL).toHaveBeenCalledWith('bc1qexample', expect.objectContaining({
      errorCorrectionLevel: 'M',
      type: 'image/png',
    }))
    expect(host.querySelector('.deposit-qr')?.getAttribute('src')).toBe('data:image/png;base64,LOCAL')
  })

  it('trims the plain address before local generation', async () => {
    await generateDepositQrDataUrl('  rAddress123  ')

    expect(QRCode.toDataURL).toHaveBeenCalledWith('rAddress123', expect.anything())
  })

  it('uses a safe server QR and does not generate a local substitute', async () => {
    await mount(() => h(DepositQr, {
      address: 'bc1qexample',
      remoteQr: 'data:image/png;base64,AAAA',
      alt: 'Deposit QR',
    }))

    expect(QRCode.toDataURL).not.toHaveBeenCalled()
    expect(host.querySelector('.deposit-qr')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })

  it('rejects a third-party QR URL and generates locally instead', async () => {
    await mount(() => h(DepositQr, {
      address: 'bc1qexample',
      remoteQr: 'https://third-party.invalid/qr.png',
      alt: 'Deposit QR',
    }))

    expect(QRCode.toDataURL).toHaveBeenCalledWith('bc1qexample', expect.anything())
    expect(host.querySelector('.deposit-qr')?.getAttribute('src')).toBe('data:image/png;base64,LOCAL')
  })

  it('never lets a stale async render overwrite a newer address QR', async () => {
    const stale = deferred<string>()
    const fresh = deferred<string>()
    vi.mocked(QRCode.toDataURL)
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise)
    const address = ref('old-address')

    await mount(() => h(DepositQr, { address: address.value, remoteQr: '', alt: 'Deposit QR' }))
    address.value = 'new-address'
    await flush()

    stale.resolve('data:image/png;base64,OLD')
    await flush()
    expect(host.querySelector('.deposit-qr')).toBeNull()

    fresh.resolve('data:image/png;base64,NEW')
    await flush()
    expect(host.querySelector('.deposit-qr')?.getAttribute('src')).toBe('data:image/png;base64,NEW')
  })

  it('does not restore a pending QR after the address is cleared', async () => {
    const pending = deferred<string>()
    vi.mocked(QRCode.toDataURL).mockReturnValueOnce(pending.promise)
    const address = ref('old-address')

    await mount(() => h(DepositQr, { address: address.value, remoteQr: '', alt: 'Deposit QR' }))
    address.value = ''
    await flush()

    pending.resolve('data:image/png;base64,OLD')
    await flush()
    expect(host.querySelector('.deposit-qr')).toBeNull()
    expect(host.querySelector('img')).toBeNull()
  })
})
