import { useI18n } from 'vue-i18n'

/** Transfer dialog strings, merged into a local vue-i18n scope (global bundles stay untouched). */
export const TRANSFER_MESSAGES = {
  'zh-CN': {
    transfer: {
      title: '资金划转',
      action: '划转',
      from: '从',
      to: '到',
      swap: '交换方向',
      account: {
        spot: '现货账户',
        margin: '杠杆账户',
        futures: '合约账户',
      },
      pair: '杠杆交易对',
      coin: '币种',
      amount: '划转数量',
      max: '全部',
      available: '可划转',
      availableUnknown: '合约账户余额请在合约页查看；服务端会校验余额',
      futuresBalanceFailed: '合约账户余额暂时无法获取',
      sessionExpired: '登录已过期，请重新登录后再划转',
      relogin: '重新登录',
      submit: '确认划转',
      submitting: '划转中…',
      done: '划转成功',
      success: '划转成功',
      marginOutHint: '杠杆账户转出受风险率限制（转出后风险率需 ≥ 200%），可划转数量由服务端计算',
      futuresOutHint: '未实现盈利不可划转，平仓后可划转',
      futuresCloudHint: '当前合约为云接入模式，仅支持从现货转入合约',
      noMarginPairs: '暂无开放杠杆的交易对，无法划转至杠杆账户',
      futuresGate: {
        preparing: '正在准备合约账户…',
        initFailed: '合约账户初始化失败，请稍后重试',
        checkFailed: '无法确认合约账户状态，暂不能划转',
        retry: '重试',
      },
      error: {
        sameAccount: '转出与转入账户不能相同',
        viaSpot: '杠杆与合约账户之间不能直接划转，请先划转至现货账户',
        futuresOutUnsupported: '当前合约接入模式不支持从合约转出至现货',
        symbolRequired: '请选择杠杆交易对',
        coinRequired: '请选择币种',
        coinUnsupported: '该账户不支持此币种',
        required: '请输入划转数量',
        invalid: '请输入合法的数量',
        positive: '数量必须大于 0',
        precision: '最多 {dp} 位小数',
        insufficient: '超过可划转数量 {available}',
      },
    },
  },
  'en-US': {
    transfer: {
      title: 'Transfer',
      action: 'Transfer',
      from: 'From',
      to: 'To',
      swap: 'Swap direction',
      account: {
        spot: 'Spot account',
        margin: 'Margin account',
        futures: 'Futures account',
      },
      pair: 'Margin pair',
      coin: 'Coin',
      amount: 'Amount',
      max: 'Max',
      available: 'Transferable',
      availableUnknown: 'Check the futures balance on the futures page; the server validates the amount',
      futuresBalanceFailed: 'Futures balance unavailable right now',
      sessionExpired: 'Your session has expired. Log in again to transfer.',
      relogin: 'Log in again',
      submit: 'Confirm transfer',
      submitting: 'Transferring…',
      done: 'Transfer completed',
      success: 'Transfer completed',
      marginOutHint: 'Transfers out of margin are limited by the risk rate (must stay ≥ 200 %); the transferable amount is computed by the server',
      futuresOutHint: 'Unrealized profit cannot be transferred out; it becomes transferable after the position is closed.',
      futuresCloudHint: 'Futures run in cloud mode: only spot → futures transfers are supported',
      noMarginPairs: 'No pair has margin trading enabled, so nothing can be moved to margin',
      futuresGate: {
        preparing: 'Preparing your futures account…',
        initFailed: 'Futures account setup failed. Please try again later.',
        checkFailed: 'Could not confirm the futures account status; transfers are paused',
        retry: 'Retry',
      },
      error: {
        sameAccount: 'Source and destination must differ',
        viaSpot: 'Margin and futures cannot transfer directly; move funds through the spot account',
        futuresOutUnsupported: 'This futures mode does not allow transfers from futures to spot',
        symbolRequired: 'Select a margin pair',
        coinRequired: 'Select a coin',
        coinUnsupported: 'This account does not support the coin',
        required: 'Enter an amount',
        invalid: 'Enter a valid amount',
        positive: 'Amount must be greater than 0',
        precision: 'At most {dp} decimal places',
        insufficient: 'Exceeds the transferable amount {available}',
      },
    },
  },
} as const

export function useTransferI18n() {
  return useI18n({ messages: TRANSFER_MESSAGES })
}

/** Extra assets-page strings (margin / futures tabs, transfer action); merged with the wallet scope. */
export const ASSETS_EXTRA_MESSAGES = {
  'zh-CN': {
    assetsExtra: {
      tab: { margin: '杠杆账户', futures: '合约账户' },
      transfer: '划转',
    },
  },
  'en-US': {
    assetsExtra: {
      tab: { margin: 'Margin', futures: 'Futures' },
      transfer: 'Transfer',
    },
  },
} as const
