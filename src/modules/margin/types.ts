/**
 * Margin (杠杆 / lever) contract types.
 *
 * Every field below was read from exchange-web-api / exchange-service source, not guessed:
 * - `LeverAccountServiceImpl.getLeverAccountBySymbol` (exchange-service/.../lever/service/impl/LeverAccountServiceImpl.java:199-281)
 *   builds the `lever/finance/symbol/balance` map.
 * - `LeverAccountServiceImpl.getAllLeverAccount` (same file :71-176) builds `lever/finance/balance`.
 * - `LeverBorrowAct.borrowNew/borrowHistory/returnInfo` (exchange-web-api/.../lever/LeverBorrowAct.java:59-266)
 * - `LeverFinanceAct.leverTransferList` (exchange-web-api/.../lever/LeverFinanceAct.java:236-297)
 *
 * All money values are normalised to plain decimal strings (`''` when the server omitted them).
 */

/** One pair's isolated margin account (`lever/finance/symbol/balance`). */
export interface MarginSymbolAccount {
  /** Lower-case server symbol, e.g. `btcusdt`. */
  symbol: string
  /** `BTC/USDT` */
  name: string
  baseCoin: string
  quoteCoin: string
  baseNormalBalance: string
  baseLockBalance: string
  baseTotalBalance: string
  baseBorrowBalance: string
  baseCanBorrow: string
  baseTotalBorrow: string
  /** Only present on the single-pair endpoint (`calculateQuoteCanTransfer`). */
  baseCanTransfer: string
  baseMinBorrow: string
  baseMinPayment: string
  quoteNormalBalance: string
  quoteLockBalance: string
  quoteTotalBalance: string
  quoteBorrowBalance: string
  quoteCanBorrow: string
  quoteTotalBorrow: string
  quoteCanTransfer: string
  quoteMinBorrow: string
  quoteMinPayment: string
  /** Spot (exchange) available balances of both coins, as returned alongside the margin account. */
  baseExNormalBalance: string
  quoteExNormalBalance: string
  /**
   * Risk rate **in percent** (server: `riskRate * 100`, scale 0, ROUND_DOWN). `0` means no debt
   * (LeverUtils.calculateRiskRate returns 0 when nothing is borrowed).
   */
  riskRate: string
  /** Liquidation price in the quote coin; `0` when no debt. */
  burstPrice: string
  /** Daily interest rate as a fraction (`BorrowRule.rate`, e.g. `0.0005`). */
  rate: string
  /** Max leverage (`BorrowRule.multiple`). */
  multiple: string
  /** Pair value in BTC (`symbolBalance`). */
  symbolBalance: string
  baseReturnPrecision: number
  quoteReturnPrecision: number
}

export interface MarginAccountsOverview {
  /** BTC valuation of every margin account. */
  totalBalance: string
  totalBalanceSymbol: string
  /** Keyed by `BASE/QUOTE`. */
  accounts: MarginSymbolAccount[]
}

/** `lever/borrow/new` + `lever/borrow/history` rows. */
export interface BorrowRecord {
  id: string
  /** Epoch milliseconds (serialized `Date`). */
  ctime: number | null
  /** Upper-case server symbol (`BTCUSDT`). */
  symbol: string
  showName: string
  coin: string
  borrowMoney: string
  /** 1 borrowed, 2 partly repaid, 3 repaid, 4 liquidating, 5 wear, 6 liquidated, 7 wear closed. */
  status: number
  /** Daily interest rate fraction. */
  interestRate: string
  /** Open records only: outstanding interest. */
  oweInterest: string
  /** Open records only: outstanding principal. */
  oweAmount: string
  /** History records only: total interest accrued. */
  interest: string
}

export interface BorrowRecordPage {
  count: number
  list: BorrowRecord[]
}

/** `lever/return/info` rows. */
export interface RepaymentRecord {
  repaymentTime: number | null
  coin: string
  returnMoney: string
  /** 1 principal only, 2 interest only, 3 principal + interest. */
  type: number
}

/** `lever/finance/transfer/list` rows. */
export interface MarginTransferRecord {
  createTime: number | null
  amount: string
  symbol: string
  showName: string
  coinSymbol: string
  /** 1 spot → margin, 2 margin → spot. */
  transferType: number
}

export interface MarginTransferPage {
  count: number
  list: MarginTransferRecord[]
}

/** `/borrow_rule` (PublicAct.java:2674) → BorrowRuleServiceImpl.getRuleByCoins. */
export interface BorrowRule {
  symbol: string
  base: string
  quote: string
  baseMinBorrow: string
  baseMinPayment: string
  quoteMinBorrow: string
  quoteMinPayment: string
  /** Already multiplied by 100 on the server: a percent value. */
  ratePercent: string
  multiple: string
}
