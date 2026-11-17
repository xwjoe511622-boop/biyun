export type PublishedAgreementKind = 'earn' | 'loan'
export const PRODUCT_RULES_VERSION = '0.1'
export const PRODUCT_RULES_DATE = '2026-10-30'
export const PRODUCT_AGREEMENT_PATHS: Readonly<Record<PublishedAgreementKind, string>> = { earn: '/terms/earn', loan: '/terms/loan' }
