import type { RouteRecordRaw } from 'vue-router'
import { PRODUCT_AGREEMENT_PATHS } from '@/modules/business/agreements/metadata'
/** Public reading routes share the same published source as subscription/borrowing confirmation. */
export const PRODUCT_TERMS_ROUTES: RouteRecordRaw[] = [
  { path: PRODUCT_AGREEMENT_PATHS.earn, name: 'earn-terms', component: () => import('@/views/content/ProductTermsView.vue'), props: { kind: 'earn' }, meta: { titleKey: 'productRoutes.simpleEarnAgreement' } },
  { path: PRODUCT_AGREEMENT_PATHS.loan, name: 'loan-terms', component: () => import('@/views/content/ProductTermsView.vue'), props: { kind: 'loan' }, meta: { titleKey: 'productRoutes.cryptoLoanAgreement' } },
]
