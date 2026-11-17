declare module 'qrcode' {
  export interface QRCodeToDataURLOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
    margin?: number
    width?: number
    scale?: number
    type?: string
    quality?: number
    color?: {
      dark?: string
      light?: string
    }
    rendererOpts?: {
      quality?: number
    }
  }

  const QRCode: {
    toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>
  }

  export default QRCode
}
