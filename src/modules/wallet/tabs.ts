/** One wallet tab descriptor; the icon is a Lucide component reference. */
export interface WalletTab {
  id: string
  label: string
  icon?: unknown
  /** Phones: shorter label so every account tab fits one row (现货账户 → 现货). */
  shortLabel?: string
  /** Phones: not in the tab row — the page offers it as a quick-action button instead. */
  action?: boolean
}
