import QRCode from 'qrcode'

/**
 * Render a plain deposit address locally as a raster data URL. The server QR is preferred when it
 * passes `safeQrImage`; this helper exists only for the missing or unsafe-QR case, and it never
 * sends the address to a third party.
 */
export async function generateDepositQrDataUrl(address: string): Promise<string> {
  const value = address.trim()
  if (value === '') {
    return ''
  }
  return QRCode.toDataURL(value, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
    type: 'image/png',
  })
}
