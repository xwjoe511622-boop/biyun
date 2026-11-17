import { translateForLocale } from '@/i18n/composer'
/**
 * Wallet-gateway refusals (contract v2 §6.5) in the wallet's own words: used by the wallet panels (`wallet.err.c<code>`
 * via `wallet/i18n.ts`) and, for the wallet-only codes 110101–110103, by the spot code table (`api/error-codes/spot.ts`).
 */
export const WALLET_ERROR_TEXTS: Readonly<Record<string, string>> = {
  '10054': 'walletGateway.invalidAddressCheckTheFormatAndTheEip55',
  '10053': 'walletGateway.platformAddressesAreNotAllowedPlatformWalletsAnyUser',
  '110102': 'walletGateway.thisNetworkDoesNotSupportTheCoinOrThe',
  '110101': 'walletGateway.theAddressBookEntryDoesNotExistOrWas',
  '10063': 'walletGateway.belowTheMinimumPerWithdrawal',
  '110103': 'walletGateway.aboveTheMaximumPerWithdrawal',
  '10090': 'walletGateway.exceedsTodaySWithdrawalLimit',
  '10083': 'walletGateway.withdrawalsAreTemporarilyClosed',
  '10080': 'walletGateway.bindGoogleAuthenticatorFirst',
  '10010': 'walletGateway.incorrectGoogleCode',
  '110008': 'walletGateway.theEmailCodeIsWrongOrExpiredRequestA',
  '10009': 'walletGateway.incorrectSmsCode',
  '110007': 'walletGateway.withdrawingToANewAddressNeedsABoundEmail',
  '10020': 'walletGateway.invalidRequestParametersRefreshThePageAndTryAgain',
}

/** `{ c<code>: text }` for one language (the vue-i18n `wallet.err` block). */
export function walletErrMessages(language: 'zh' | 'en'): Record<string, string> {
  return Object.fromEntries(Object.entries(WALLET_ERROR_TEXTS).map(([code, text]) => [`c${code}`, translateForLocale(language, text)]))
}
