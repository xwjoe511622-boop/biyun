/* BIYUN 演示模式的模拟后端（仅在 VITE_DEMO=1 时由 vite.config.ts 注入页面，正式构建不包含）：真实币种 + 2026-11-16 前后的真实价格作起点，在浏览器里模拟跳动。
 * 拦截 fetch 与 WebSocket，不连接任何真实服务器。 */
(function () {
  'use strict'
  // 演示账号：页面打开即为已登录状态
  try { if (!localStorage.getItem('picat.session.v2')) localStorage.setItem('picat.session.v2', JSON.stringify({ v: 2, key: 'cdemo0bitwinex0preview0session01' })) } catch (e) {}
  // [base, 起始价, 24h涨跌%, 价格小数位, 数量小数位, 24h成交额(USDT), 品牌色]
  var SPOT = [
    ['WIN', 3.7, 4.85, 4, 2, 3.62e7, '#C99A4A'],
    ['BTC', 64849.52, 1.32, 2, 5, 2.73e9, '#F7931A'],
    ['ETH', 1817.26, 2.05, 2, 4, 1.07e9, '#627EEA'],
    ['SOL', 71.22, 1.90, 2, 3, 2.89e8, '#9945FF'],
    ['XRP', 0.9577, 1.06, 4, 1, 1.84e8, '#23292F'],
    ['BNB', 591.75, 0.96, 2, 3, 1.21e8, '#F3BA2F'],
    ['DOGE', 0.05889, 2.34, 5, 0, 9.6e7, '#C2A633'],
    ['TRX', 0.303, -1.01, 4, 1, 5.2e7, '#EB0029'],
    ['HYPE', 39.69, 1.88, 3, 2, 8.1e7, '#50E3C2'],
    ['LINK', 9.10, -0.35, 3, 2, 4.0e7, '#2A5ADA'],
    ['SUI', 0.9354, -2.42, 4, 1, 3.6e7, '#4DA2FF'],
    ['AVAX', 7.16, 0.30, 3, 2, 2.9e7, '#E84142'],
    ['LTC', 44.80, 0.19, 2, 3, 2.4e7, '#345D9D'],
    ['ZEC', 226.33, -2.24, 2, 3, 2.9e7, '#ECB244'],
    ['SHIB', 0.00000608, -0.34, 8, 0, 1.5e7, '#FFA409'],
    ['XAUT', 4012.40, -0.82, 2, 4, 6.4e7, '#D4AF37'],
    ['PAXG', 4109.03, -0.16, 2, 4, 8.3e7, '#E4CE4D'],
    ['TAO', 211.72, -1.49, 2, 3, 1.0e8, '#14151A'],
    ['RENDER', 1.57, 0.46, 4, 1, 2.1e7, '#CF1011'],
    ['WLD', 0.46, -1.90, 4, 1, 1.7e8, '#1E1E1E'],
    ['NEAR', 1.83, -7.07, 3, 1, 3.0e8, '#00C08B'],
    ['ONDO', 0.32, -1.08, 4, 1, 4.5e7, '#1B5CFF'],
    ['UNI', 3.47, 0.34, 3, 2, 1.9e8, '#FF007A'],
    ['PEPE', 0.0000025, 1.30, 8, 0, 1.6e8, '#4C9540'],
  ]
  // [base, 起始价, 涨跌%, 价格小数位, 面值, 最大杠杆, 24h成交额]
  var FUT = [
    ['BTC', 64861.3, 1.29, 1, '0.001', 125, 6.9e9],
    ['ETH', 1817.91, 2.01, 2, '0.01', 100, 3.1e9],
    ['SOL', 71.26, 1.84, 3, '0.1', 75, 6.2e8],
    ['XRP', 0.9581, 1.02, 4, '10', 75, 3.3e8],
    ['BNB', 592.10, 0.91, 2, '0.01', 75, 1.9e8],
    ['DOGE', 0.05892, 2.30, 5, '100', 75, 2.1e8],
    ['HYPE', 39.71, 1.80, 3, '0.1', 50, 2.6e8],
    ['XAUT', 4013.1, -0.80, 1, '0.001', 100, 4.2e8],
    ['NVDA', 168.89, -5.47, 2, '0.01', 20, 1.6e8],
    ['TSLA', 379.78, 0.46, 2, '0.01', 20, 1.2e8],
  ]
  var SCALES = ['1min', '5min', '15min', '30min', '60min', '4h', '1day', '1week', '1month']
  var SEC = { '1min': 60, '5min': 300, '15min': 900, '30min': 1800, '60min': 3600, '4h': 14400, '1day': 86400, '1week': 604800, '1month': 2592000 }

  var ICONS = __ICONS__
  function icon(base, color) {
    if (ICONS[base]) return ICONS[base]
    var t = base.length > 3 ? base.slice(0, 3) : base
    var fs = t.length > 2 ? 11 : 13
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="' + color + '"/><text x="16" y="20.5" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="' + fs + '" fill="#fff">' + t + '</text></svg>'
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  }

  // ---------- 价格状态 ----------
  var M = {} // key -> state
  function seedRand(s) { return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646 } }
  function mk(key, price, chg, pd, vd, quoteVol, futures, mult) {
    var open = price / (1 + chg / 100)
    var hi = Math.max(price, open) * (1 + 0.012 + Math.random() * 0.01)
    var lo = Math.min(price, open) * (1 - 0.012 - Math.random() * 0.01)
    M[key] = { key: key, p: price, open: open, high: hi, low: lo, pd: pd, vd: vd, amount: quoteVol, vol: quoteVol / price, futures: futures, mult: mult || '1', tid: 1e9 + Math.floor(Math.random() * 1e8), bars: {} }
  }
  SPOT.forEach(function (r) { mk(r[0].toLowerCase() + 'usdt', r[1], r[2], r[3], r[4], r[5], false) })
  FUT.forEach(function (r) { mk('e_' + r[0].toLowerCase() + 'usdt', r[1], r[2], r[3], 0, r[6], true, r[4]) })

  function fmt(v, d) { return Number(v).toFixed(d) }
  function step(s) {
    var vol = s.key.indexOf('nvda') >= 0 || s.key.indexOf('tsla') >= 0 || s.key.indexOf('xaut') >= 0 ? 0.00025 : 0.0006
    var drift = (s.open * 1 - s.p) / s.p * 0.002 // 轻微回归，避免跑飞
    s.p = s.p * (1 + (Math.random() - 0.5) * 2 * vol + drift * 0.1)
    var tick = Math.pow(10, -s.pd)
    s.p = Math.max(tick, Math.round(s.p / tick) * tick)
    if (s.p > s.high) s.high = s.p
    if (s.p < s.low) s.low = s.p
    var q = s.amount / 86400 * (0.5 + Math.random())
    s.amount += q; s.vol += q / s.p
  }
  function ticker(s) {
    return { close: fmt(s.p, s.pd), open: fmt(s.open, s.pd), high: fmt(s.high, s.pd), low: fmt(s.low, s.pd), vol: fmt(s.futures ? s.vol / Number(s.mult) : s.vol, 2), amount: fmt(s.futures ? s.amount / Number(s.mult) : s.amount, 2), rose: fmt((s.p - s.open) / s.open, 6) }
  }
  function review(fut) {
    var out = {}
    Object.keys(M).forEach(function (k) { if (M[k].futures === fut) out[k] = ticker(M[k]) })
    return out
  }
  function trade(s, ts) {
    var side = Math.random() < 0.5 ? 'BUY' : 'SELL'
    var tick = Math.pow(10, -s.pd)
    var price = s.p + (side === 'BUY' ? tick : -tick) * Math.floor(Math.random() * 2)
    var notional = Math.exp(Math.log(20) + Math.random() * Math.log(4000))
    var vol = s.futures ? Math.max(1, Math.round(notional / (price * Number(s.mult)))) : Number(fmt(notional / price, Math.max(s.vd, 0)))
    if (!s.futures && vol <= 0) vol = Math.pow(10, -s.vd)
    var amount = s.futures ? vol * Number(s.mult) * price : vol * price
    return { id: String(s.tid++), price: fmt(price, s.pd), vol: s.futures ? String(vol) : fmt(vol, s.vd), amount: fmt(amount, 4), side: side, ds: '', ts: ts }
  }
  function depth(s, level) {
    var tick = Math.pow(10, -s.pd) * Math.pow(10, Math.min(level, 3))
    var asks = [], buys = []
    var base = Math.round(s.p / tick) * tick
    for (var i = 1; i <= 30; i++) {
      var size = function () { var n = Math.exp(Math.log(50) + Math.random() * Math.log(400)) * (1 + i * 0.08); return s.futures ? String(Math.max(1, Math.round(n / (s.p * Number(s.mult))))) : fmt(n / s.p, Math.max(s.vd, 0) || 0) }
      asks.push([fmt(base + tick * i, s.pd), size()])
      buys.push([fmt(base - tick * (i - 1) - (i === 1 ? tick * 0 : 0) - tick * 0, s.pd), size()])
    }
    buys = buys.map(function (r, i) { return [fmt(base - tick * i, s.pd), r[1]] })
    return { asks: asks, buys: buys }
  }
  function history(s, scale, endIdx, size) {
    var sec = SEC[scale] || 60
    var now = Math.floor(Date.now() / 1000)
    var cur = Math.floor(now / sec) * sec
    var end = endIdx ? Math.floor(endIdx / sec) * sec - sec : cur
    var n = size || 300
    var key = scale
    if (!s.bars[key]) s.bars[key] = {}
    var cache = s.bars[key]
    var r = seedRand((s.key.length * 7919 + sec) % 2147483646 + 1)
    // 从当前价向过去随机游走，保证同一根 K 线前后一致
    var sigma = Math.min(0.06, 0.0016 * Math.sqrt(sec / 60)) * (s.key.indexOf('nvda') >= 0 || s.key.indexOf('tsla') >= 0 || s.key.indexOf('xaut') >= 0 ? 0.5 : 1)
    var bars = []
    var close = s.p
    var t = cur
    var maxBack = Math.floor((cur - end) / sec) + n
    for (var i = 0; i <= maxBack; i++) {
      var b = cache[t]
      if (!b) {
        var open = close * (1 + (r() - 0.5) * 2 * sigma)
        var hi = Math.max(open, close) * (1 + r() * sigma * 0.7)
        var lo = Math.min(open, close) * (1 - r() * sigma * 0.7)
        var v = (s.amount / 86400) * sec * (0.4 + r() * 1.2) / close
        b = { id: t, open: open, high: hi, low: lo, close: close, vol: s.futures ? v / Number(s.mult) : v }
        cache[t] = b
      }
      if (t <= end) bars.push(b)
      close = b.open
      t -= sec
      if (bars.length >= n) break
    }
    bars.reverse()
    return bars.map(function (b) { return out(s, b) })
  }
  function out(s, b) { return { id: b.id, open: fmt(b.open, s.pd), high: fmt(b.high, s.pd), low: fmt(b.low, s.pd), close: fmt(b.close, s.pd), vol: fmt(b.vol, 4), amount: fmt(b.vol * b.close, 2) } }
  function liveBar(s, scale) {
    var sec = SEC[scale] || 60
    var t = Math.floor(Date.now() / 1000 / sec) * sec
    if (!s.bars[scale]) history(s, scale, null, 2)
    var b = s.bars[scale][t]
    if (!b) { b = { id: t, open: s.p, high: s.p, low: s.p, close: s.p, vol: 0 }; s.bars[scale][t] = b }
    b.close = s.p; if (s.p > b.high) b.high = s.p; if (s.p < b.low) b.low = s.p
    b.vol += (s.amount / 86400) * (0.5 + Math.random()) / s.p / (s.futures ? Number(s.mult) : 1)
    return out(s, b)
  }

  setInterval(function () { Object.keys(M).forEach(function (k) { step(M[k]) }) }, 700)

  // ---------- WebSocket ----------
  function parse(ch) {
    var m = /^market_(.+)_(ticker|trade_ticker|depth_step(\d+)|kline_(\w+))$/.exec(ch)
    if (!m) return null
    var sym = m[1], kind = m[2]
    if (kind === 'trade_ticker') { kind = 'trade' }
    else if (m[3] !== undefined) { kind = 'depth' }
    else if (m[4] !== undefined) { kind = 'kline' }
    if (kind === 'ticker' && /_trade$/.test(sym)) { sym = sym.replace(/_trade$/, ''); kind = 'trade' }
    return { sym: sym, kind: kind, level: m[3] ? Number(m[3]) : 0, scale: m[4] }
  }
  function FakeSocket(url) {
    var self = this
    this.url = String(url); this.readyState = 0; this.binaryType = 'arraybuffer'; this.protocol = ''; this.extensions = ''; this.bufferedAmount = 0
    this._fut = /futures/i.test(this.url)
    this._subs = {}; this._timers = []; this._l = {}
    setTimeout(function () { if (self.readyState !== 0) return; self.readyState = 1; self._emit('open', {}) }, 30)
    this._timers.push(setInterval(function () { self._tick() }, 1000))
  }
  FakeSocket.CONNECTING = 0; FakeSocket.OPEN = 1; FakeSocket.CLOSING = 2; FakeSocket.CLOSED = 3
  FakeSocket.prototype.CONNECTING = 0; FakeSocket.prototype.OPEN = 1; FakeSocket.prototype.CLOSING = 2; FakeSocket.prototype.CLOSED = 3
  FakeSocket.prototype.addEventListener = function (t, f) { (this._l[t] = this._l[t] || []).push(f) }
  FakeSocket.prototype.removeEventListener = function (t, f) { this._l[t] = (this._l[t] || []).filter(function (x) { return x !== f }) }
  FakeSocket.prototype._emit = function (t, ev) {
    ev.type = t; ev.target = this
    var h = this['on' + t]; if (typeof h === 'function') { try { h.call(this, ev) } catch (e) { console.error(e) } }
    ;(this._l[t] || []).forEach(function (f) { try { f(ev) } catch (e) { console.error(e) } })
  }
  FakeSocket.prototype._send = function (obj) {
    if (this.readyState !== 1) return
    var self = this, data = JSON.stringify(obj)
    setTimeout(function () { if (self.readyState === 1) self._emit('message', { data: data }) }, 5)
  }
  FakeSocket.prototype.close = function () {
    if (this.readyState >= 2) return
    this.readyState = 3; this._timers.forEach(clearInterval)
    this._emit('close', { code: 1000, reason: '', wasClean: true })
  }
  FakeSocket.prototype.send = function (raw) {
    var msg; try { msg = JSON.parse(String(raw)) } catch (e) { return }
    if (!msg || !msg.event || !msg.params) return
    var ch = msg.params.channel, ts = Date.now(), self = this
    if (ch === 'review') {
      if (msg.event === 'req') this._send({ channel: 'review', event_rep: 'rep', ts: ts, status: 'ok', data: review(this._fut) })
      if (msg.event === 'sub') this._subs.review = { kind: 'review' }
      if (msg.event === 'unsub') delete this._subs.review
      return
    }
    var p = parse(ch); if (!p) return
    var s = M[p.sym]; if (!s) return
    if (msg.event === 'unsub') { delete this._subs[ch]; return }
    if (msg.event === 'req') {
      if (p.kind === 'trade') {
        var list = []; for (var i = 0; i < (msg.params.top || 50); i++) list.push(trade(s, ts - i * (800 + Math.floor(Math.random() * 3000))))
        this._send({ channel: ch, event_rep: 'rep', ts: ts, status: 'ok', data: list })
      } else if (p.kind === 'kline') {
        this._send({ channel: ch, event_rep: 'rep', ts: ts, status: 'ok', data: history(s, p.scale, msg.params.endIdx, msg.params.pageSize || 300) })
      } else if (p.kind === 'ticker') {
        this._send({ channel: ch, event_rep: 'rep', ts: ts, status: 'ok', tick: ticker(s) })
      } else if (p.kind === 'depth') {
        this._send({ channel: ch, event_rep: 'rep', ts: ts, status: 'ok', tick: depth(s, p.level) })
      }
      return
    }
    if (msg.event === 'sub') {
      this._subs[ch] = p
      // 首帧立即推送
      setTimeout(function () { self._push(ch, p, Date.now()) }, 20)
    }
  }
  FakeSocket.prototype._push = function (ch, p, ts) {
    if (p.kind === 'review') { this._send({ channel: 'review', ts: ts, data: review(this._fut) }); return }
    var s = M[p.sym]; if (!s) return
    if (p.kind === 'ticker') this._send({ channel: ch, ts: ts, tick: ticker(s) })
    else if (p.kind === 'depth') this._send({ channel: ch, ts: ts, tick: depth(s, p.level) })
    else if (p.kind === 'kline') this._send({ channel: ch, ts: ts, tick: liveBar(s, p.scale) })
    else if (p.kind === 'trade') {
      var n = 1 + Math.floor(Math.random() * 3), d = []
      for (var i = 0; i < n; i++) d.push(trade(s, ts))
      this._send({ channel: ch, ts: ts, tick: { data: d } })
    }
  }
  FakeSocket.prototype._tick = function () {
    var self = this, ts = Date.now()
    Object.keys(this._subs).forEach(function (ch) {
      var p = self._subs[ch]
      if (p.kind === 'review' && Math.random() < 0.5) return
      if (p.kind === 'trade' && Math.random() < 0.3) return
      self._push(ch, p, ts)
    })
  }
  window.WebSocket = FakeSocket

  // ---------- HTTP ----------
  var KLINE = SCALES
  // 板块标签（演示）：后台“币种标签”配置的序号
  var TAGS = { TAO: 2, RENDER: 2, WLD: 2, NEAR: 2, ONDO: 3, LINK: 3, AVAX: 3, XAUT: 4, PAXG: 4, DOGE: 5, SHIB: 5, PEPE: 5, UNI: 6, HYPE: 6 }
  function spotInfo() {
    var market = { USDT: {} }, coinList = { USDT: { name: 'USDT', showName: 'USDT', showPrecision: 2, icon: icon('USDT', '#26A17B'), sort: 0, isFiat: 0, otcOpen: 1 } }
    SPOT.forEach(function (r, i) {
      var b = r[0], pd = r[3], vd = r[4]
      var steps = [0, 1, 2].map(function (k) { var d = pd - k; return d > 0 ? (Math.pow(10, -d)).toFixed(d) : String(Math.pow(10, -d)) })
      market.USDT[b + '/USDT'] = { symbol: b.toLowerCase() + 'usdt', name: b + '/USDT', showName: b + '/USDT', price: pd, volume: vd, depth: steps.join(','), limitPriceMin: Math.pow(10, -pd).toFixed(pd), limitVolumeMin: vd > 0 ? Math.pow(10, -vd).toFixed(vd) : '1', marketBuyMin: '5', marketSellMin: vd > 0 ? Math.pow(10, -vd).toFixed(vd) : '1', sort: i + 1, isShow: 1, newcoinFlag: b === 'HYPE' || b === 'TAO' ? 1 : 0, is_open_lever: ['BTC', 'ETH', 'SOL'].indexOf(b) >= 0 ? 1 : 0, multiple: ['BTC', 'ETH', 'SOL'].indexOf(b) >= 0 ? 5 : 0, borrowRuleConfigured: ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE'].indexOf(b) >= 0 }
      coinList[b] = { name: b, showName: b, showPrecision: Math.max(vd, 4), icon: icon(b, r[6]), sort: i + 1, isFiat: 0, otcOpen: ['BTC', 'ETH'].indexOf(b) >= 0 ? 1 : 0, mainChainType: 1, coinTag: TAGS[b] || 1 }
    })
    ;[['USDC', '#2775CA'], ['NVDA', '#76B900'], ['TSLA', '#CC0000']].forEach(function (r, i) { coinList[r[0]] = { name: r[0], showName: r[0], showPrecision: 4, icon: icon(r[0], r[1]), sort: 100 + i, isFiat: 0, otcOpen: 0 } })
    return {
      msg: { company_name: 'BIYUN', logoUrl: '', iconUrl: '', contact_email: 'support@exchange.invalid' },
      nc: { nc_appkey: '', nc_prefix: '', nc_lang: 'cn' },
      switch: { otc_open: '1', lever_open: '1', is_enforce_google: '0', index_international_open: '1', fiat_trade_open: '1' },
      url: {},
      HIT: 'WIN',
      market: { market: market, coinList: coinList, followCoinList: {}, coinTagLangs: { zh_CN: { 1: '主流', 2: 'AI', 3: 'RWA', 4: '黄金', 5: 'Meme', 6: 'DeFi' }, en_US: { 1: 'Major', 2: 'AI', 3: 'RWA', 4: 'Gold', 5: 'Meme', 6: 'DeFi' } }, wsUrl: 'wss://ws.exchange.invalid/kline-api/ws', klineScale: KLINE, marketSort: ['USDT'], rate: { zh_CN: { USDT: '7.10' } } },
    }
  }
  function futInfo() {
    var list = FUT.map(function (r, i) {
      var b = r[0], pd = r[3]
      return {
        id: i + 1, contractName: 'E-' + b + '-USDT', symbol: b + '-USDT', contractType: 'E', contractSide: 1, multiplier: r[4], multiplierCoin: b, marginCoin: 'USDT', marginRate: '1', base: b, quote: 'USDT', maxLever: r[5], minLever: 1, capitalStartTime: 0, capitalFrequency: 8, sort: i + 1,
        coinResultVo: { symbolPricePrecision: pd, marginCoinPrecision: 4, depth: [String(pd), String(Math.max(pd - 1, 0)), String(Math.max(pd - 2, 0))], minOrderVolume: '1', minOrderMoney: '5', maxMarketVolume: '1000000', maxMarketMoney: '5000000', maxLimitVolume: '5000000', maxLimitMoney: '20000000', priceRange: '0.05', fundsInStatus: 1, fundsOutStatus: 1 },
      }
    })
    return { contractList: list, allContractList: list, wsUrl: 'wss://ws.exchange.invalid/futures-ws', marginCoinList: ['USDT'], currentTimeMillis: Date.now() }
  }
  function ok(data) { return { code: '0', msg: 'suc', data: data } }
  function raw(body) { return { __raw: true, body: body } }
  var INTRO = [
    ['WIN', 'WIN 已在 BIYUN 开放现货交易。（演示文案，上线前请替换为正式币种介绍）', 'https://www.exchange.invalid', 'https://etherscan.io'],
    ['BTC', '比特币是第一个去中心化数字货币，总量 2100 万枚，采用工作量证明共识。', 'https://bitcoin.org', 'https://mempool.space'],
    ['ETH', '以太坊是支持智能合约的公链，原生代币 ETH 用于支付 Gas 与质押。', 'https://ethereum.org', 'https://etherscan.io'],
    ['SOL', 'Solana 是高性能公链，以低费用和高吞吐量著称。', 'https://solana.com', 'https://solscan.io'],
    ['XRP', 'XRP Ledger 面向跨境支付与结算的开源账本。', 'https://xrpl.org', 'https://xrpscan.com'],
    ['BNB', 'BNB 是 BNB Chain 的原生代币。', 'https://www.bnbchain.org', 'https://bscscan.com'],
    ['DOGE', '狗狗币是社区驱动的加密货币。', 'https://dogecoin.com', 'https://dogechain.info'],
    ['XAUT', 'XAUT 是与实物黄金 1:1 挂钩的代币，每枚对应 1 金衡盎司黄金。', 'https://gold.tether.to', 'https://etherscan.io'],
  ]
  var NOTICES = [
    ['合约行情已上线：加密货币、黄金与美股永续合约行情开放浏览', 3, '合约行情、K 线与盘口已开放浏览，合约交易功能即将开放，具体时间请留意公告。'],
    ['行情中心新增 AI、RWA、黄金、Meme 等板块分类', 20, '行情中心与探索页已支持按板块浏览币种。'],
    ['关于 BIYUN 系统升级维护的公告', 70, '为提供更好的服务，BIYUN 将于近期进行系统升级，届时充提业务将短暂暂停。'],
    ['TAO、ONDO、RENDER 等现货交易对上线公告', 168, 'BIYUN 已上线多个 AI 与 RWA 板块现货交易对。'],
  ]
  var EARN_FLEX = [['USDT', '0.1200', '10'], ['USDC', '0.0850', '10'], ['BTC', '0.0215', '0.0001'], ['ETH', '0.0312', '0.001'], ['SOL', '0.0560', '0.1'], ['XAUT', '0.0180', '0.001']]
  var EARN_LOCK = [['USDT', 30, '0.1500', '50000', '100'], ['USDT', 90, '0.1800', '50000', '100'], ['BTC', 60, '0.0420', '2', '0.001'], ['ETH', 30, '0.0560', '50', '0.01'], ['SOL', 120, '0.0980', '2000', '1']]
  var VIP = [[0, '0', '0', '0', '0.0010', '0.0010', '0.0002', '0.0005'], [1, '1000000', '15000000', '25000', '0.0009', '0.0010', '0.00016', '0.0004'], [2, '5000000', '50000000', '100000', '0.0008', '0.0009', '0.00014', '0.00035'], [3, '20000000', '100000000', '250000', '0.0007', '0.0008', '0.00012', '0.00032'], [4, '100000000', '600000000', '500000', '0.0005', '0.0007', '0.0001', '0.0003'], [5, '150000000', '1000000000', '1000000', '0.0004', '0.0006', '0.00008', '0.00027']]
  // ---------- 演示账户 ----------
  var NOW = Date.now()
  var USER = { id: 10086512, uid: 10086512, nickName: 'BIYUN_Demo', userAccount: 'demo***@biyun.com', email: 'demo***@biyun.com', mobileNumber: '', countryCode: '+86', authLevel: 1, realName: '演示用户', accountStatus: '0', googleStatus: 1, isOpenMobileCheck: 0, isOpenEmailCheck: 1, isCapitalPwordSet: 1, inviteCode: 'BW8K2Q', lastLoginTime: NOW - 3600e3 }
  // 现货持仓：[币, 可用, 冻结]
  var HOLD = [['USDT', 25860.42, 1268.10], ['BTC', 0.42150, 0.05], ['ETH', 6.8215, 0], ['WIN', 12500, 0], ['SOL', 120.5, 0], ['XAUT', 1.2504, 0], ['BNB', 3.105, 0], ['XRP', 2860, 0], ['DOGE', 15000, 0]]
  function px(coin) { if (coin === 'USDT' || coin === 'USDC') return 1; var s = M[coin.toLowerCase() + 'usdt']; return s ? s.p : 0 }
  function spotBalance() {
    var btc = px('BTC'), map = {}, total = 0
    SPOT.forEach(function (r) { HOLD.some(function (h) { return h[0] === r[0] }) || HOLD.push([r[0], 0, 0]) })
    HOLD.forEach(function (h, i) {
      var v = (h[1] + h[2]) * px(h[0]) / btc; total += v
      map[h[0]] = { coinName: h[0], normalBalanceExact: h[1].toFixed(8), lockBalanceExact: h[2].toFixed(8), nonTradingBalance: '0', overchargeRestricted: false, normal_balance: h[1].toFixed(8), lock_balance: h[2].toFixed(8), total_balance: (h[1] + h[2]).toFixed(8), allBalance: (h[1] + h[2]).toFixed(8), overcharge_balance: '0', nc_lock_balance: '0', lock_position_balance: '0', lock_position_v2_amount: '0', btcValuatin: v.toFixed(8), allBtcValuatin: v.toFixed(8), depositOpen: 1, withdrawOpen: 1, sort: i + 1 }
    })
    return { totalBalance: total.toFixed(8), totalBalanceSymbol: 'BTC', platformCoin: 'WIN', allCoinMap: map }
  }
  // 合约持仓：[base, 方向, 数量(币), 开仓均价, 杠杆]
  // 合约暂未开放交易：演示账户没有合约持仓与合约资金
  var POS = []
  var WALLET = 0
  function futPositions() {
    return POS.map(function (r, i) {
      var idx = FUT.findIndex(function (f) { return f[0] === r[0] }), f = FUT[idx], s = M['e_' + r[0].toLowerCase() + 'usdt']
      var mark = s.p, qty = r[2], sign = r[1] === 'LONG' ? 1 : -1
      var notional = mark * qty, upnl = (mark - r[3]) * qty * sign, im = notional / r[4], mm = notional * 0.004
      var liq = r[1] === 'LONG' ? r[3] * (1 - 0.8 / r[4] * 3) : r[3] * (1 + 0.8 / r[4] * 3)
      return { i: i, f: f, idx: idx, r: r, mark: mark, qty: qty, sign: sign, notional: notional, upnl: upnl, im: im, mm: mm, liq: liq, pd: f[3] }
    })
  }
  function futAccount() {
    var ps = futPositions(), upnl = 0, im = 0, mm = 0
    ps.forEach(function (x) { upnl += x.upnl; im += x.im; mm += x.mm })
    upnl = Number(upnl.toFixed(4)); var mb = Number((WALLET + upnl).toFixed(4)), avail = mb - im
    return {
      assets: [{ asset: 'USDT', walletBalance: WALLET.toFixed(4), unrealizedProfit: upnl.toFixed(4), marginBalance: mb.toFixed(4), maintMargin: mm.toFixed(4), initialMargin: im.toFixed(4), positionInitialMargin: im.toFixed(4), openOrderInitialMargin: '0', crossWalletBalance: WALLET.toFixed(4), crossUnPnl: upnl.toFixed(4), availableBalance: avail.toFixed(4), maxWithdrawAmount: Math.max(0, avail - Math.max(upnl, 0)).toFixed(4) }],
      positions: ps.map(function (x) { return { symbol: x.r[0] + 'USDT', positionSide: x.r[1], positionAmt: (x.qty * x.sign).toString(), notional: (x.notional * x.sign).toFixed(4), isolatedWallet: '0', unrealizedProfit: x.upnl.toFixed(4), maintMargin: x.mm.toFixed(4), initialMargin: x.im.toFixed(4), entryPrice: x.r[3].toFixed(x.pd), breakEvenPrice: (x.r[3] * (1 + 0.0005 * x.sign)).toFixed(x.pd), markPrice: x.mark.toFixed(x.pd), liquidationPrice: x.liq.toFixed(x.pd), leverage: String(x.r[4]), marginType: 'cross' } }),
      totalOpenOrderInitialMargin: '0', riskSnapshotVersion: 1,
    }
  }
  function futRisk() { return futAccount().positions.map(function (p) { return { symbol: p.symbol, positionSide: p.positionSide, positionAmt: p.positionAmt, entryPrice: p.entryPrice, breakEvenPrice: p.breakEvenPrice, markPrice: p.markPrice, unRealizedProfit: p.unrealizedProfit, liquidationPrice: p.liquidationPrice, leverage: p.leverage, marginType: 'cross', isolatedMargin: '0', isolatedWallet: '0', notional: p.notional, maintMargin: p.maintMargin, initialMargin: p.initialMargin } }) }
  function futAssets() {
    var acc = futAccount().assets[0]
    return {
      positionList: futPositions().map(function (x) {
        var vol = String(Math.round(x.qty / Number(x.f[4])))
        return { id: 9001 + x.i, contractId: x.idx + 1, contractName: 'E-' + x.r[0] + '-USDT', symbol: x.r[0] + '-USDT', positionType: 1, orderSide: x.sign > 0 ? 'BUY' : 'SELL', positionVolume: vol, canCloseVolume: vol, openAvgPrice: x.r[3].toFixed(x.pd), indexPrice: x.mark.toFixed(x.pd), reducePrice: x.liq.toFixed(x.pd), holdAmount: x.im.toFixed(4), marginRate: (Number(acc.marginBalance) / x.notional).toFixed(4), keepRate: '0.004', maxFeeRate: '0.0005', realizedAmount: '-' + (x.notional * 0.0005).toFixed(4), unRealizedAmount: x.upnl.toFixed(4), openRealizedAmount: x.upnl.toFixed(4), settleProfit: '0', returnRate: (x.upnl / x.im).toFixed(4), leverageLevel: x.r[4], positionBalance: x.notional.toFixed(4), canSubMarginAmount: '0', capitalFee: '-' + (x.notional * 0.0001).toFixed(4), tradeFee: (x.notional * 0.0005).toFixed(4), takeProfitPrice: '', stopLossPrice: '' }
      }),
      accountList: [{ symbol: 'USDT', totalAmount: acc.marginBalance, totalEquities: acc.marginBalance, isolatedEquities: '0', canUseAmount: acc.availableBalance, transferableAmount: acc.maxWithdrawAmount, transferHeldProfit: '0', totalMargin: acc.marginBalance, isolateMargin: '0', lockAmount: '0', realizedAmount: '1286.52', cumulativeClosedPnl: '1286.52', currentPositionRealizedAmount: '-24.18', unRealizedAmount: acc.unrealizedProfit, totalMarginRate: '0' }],
    }
  }
  // 现货委托：[交易对, 方向, 价格, 数量, 已成交, 状态, 小时前]
  var ORD_OPEN = [['btcusdt', 'BUY', '63500.00', '0.02000', '0', 1, 2], ['btcusdt', 'SELL', '67000.00', '0.05000', '0', 1, 5], ['ethusdt', 'BUY', '1760.00', '0.5000', '0.1200', 3, 9], ['winusdt', 'BUY', '3.5000', '2000.00', '0', 1, 1]]
  var ORD_HIST = [['btcusdt', 'BUY', '62880.40', '0.10000', '0.10000', 2, 30], ['winusdt', 'BUY', '3.1200', '10000.00', '10000.00', 2, 52], ['ethusdt', 'SELL', '1902.55', '2.0000', '2.0000', 2, 75], ['solusdt', 'BUY', '68.40', '120.500', '120.500', 2, 96], ['btcusdt', 'SELL', '66500.00', '0.08000', '0', 4, 120], ['xautusdt', 'BUY', '3955.10', '1.2504', '1.2504', 2, 150]]
  function orderRow(r, i, open) {
    var b = r[0].replace('usdt', '').toUpperCase(), t = NOW - r[6] * 3600e3
    var total = (Number(r[2]) * Number(r[3])).toFixed(4), deal = Number(r[4])
    var st = { 1: '未成交', 2: '完全成交', 3: '部分成交', 4: '已撤销' }[r[5]]
    return { id: String((open ? 7.3e17 : 7.2e17) + i * 9137), symbol: r[0], side: r[1], side_text: r[1] === 'BUY' ? '买入' : '卖出', status: r[5], status_text: st, type: 1, source: 'WEB', time_long: t, created_at: new Date(t).toISOString().replace('T', ' ').slice(0, 19), price: r[2], volume: r[3], total_price: total, remain_volume: (Number(r[3]) - deal).toFixed(r[3].split('.')[1].length), deal_volume: r[4], deal_money: (deal * Number(r[2])).toFixed(4), avg_price: deal > 0 ? r[2] : '0', baseCoin: b, countCoin: 'USDT' }
  }
  function orderList(rows, open, body) {
    var sym = body && body.symbol ? String(body.symbol).toLowerCase() : ''
    var list = rows.map(function (r, i) { return orderRow(r, i, open) }).filter(function (o) { return !sym || o.symbol === sym })
    return { count: list.length, orderList: list }
  }
  function tradeList(body) {
    var sym = body && body.symbol ? String(body.symbol).toLowerCase() : ''
    var list = ORD_HIST.filter(function (r) { return r[5] === 2 && (!sym || r[0] === sym) }).map(function (r, i) { var t = NOW - r[6] * 3600e3; return { id: String(5.1e17 + i * 7717), symbol: r[0], side: r[1], side_text: r[1] === 'BUY' ? '买入' : '卖出', price: r[2], volume: r[3], deal_price: (Number(r[2]) * Number(r[3])).toFixed(4), fee: (Number(r[2]) * Number(r[3]) * 0.001).toFixed(6), feeCoin: 'USDT', ctime: new Date(t).toISOString().replace('T', ' ').slice(0, 19), time_long: t } })
    return { count: list.length, trade_list: list }
  }
  var TRADERS = [['金牛策略', 186.42, 78.5, 52860.2, 642.3, 412, 1286, 96], ['Alpha 量化', 92.17, 71.2, 31544.8, 388.6, 920, 2410, 152], ['黄金猎手 XAU', 64.85, 82.4, 18720.5, 210.4, 186, 655, 61], ['稳健网格', 38.62, 88.9, 9860.1, 145.7, 1580, 3122, 210], ['BTC 波段王', 125.3, 66.7, 44120.0, 512.9, 268, 1840, 88], ['美股合约 NVDA', -8.42, 54.3, -2310.6, 46.2, 92, 214, 33]]
  function traders() { return TRADERS.map(function (r, i) { return { uid: String(20001000 + i * 37), nickname: r[0], profitRatio: r[1], winRatio: r[2], profitUSDT: r[3], totalRatio: r[4], totalUSDT: r[3] * 2.4, orderCount: r[5], followerCount: r[6], currentFollowCount: Math.round(r[6] * 0.3), entryDay: r[7], follow: i === 1 ? 1 : -1, maxFollowCount: 500, avatar: '' } }) }
  function sapiEmpty() { return raw({ total: 0, rows: [] }) }
  function authRoute(method, p, body, path) {
    if (/\/common\/user_info$/.test(p)) return ok(USER)
    if (/\/finance\/(v5\/)?account_balance$/.test(p)) return ok(spotBalance())
    if (/\/order\/list\/new$/.test(p)) return ok(orderList(ORD_OPEN, true, body))
    if (/\/order\/entrust_history$/.test(p)) return ok(orderList(ORD_HIST, false, body))
    if (/\/trade\/list$/.test(p)) return ok(tradeList(body))
    if (/^\/api\/v3\/userDataStream$/.test(p) || /\/fapi\/v1\/listenKey$/.test(p)) return raw({ listenKey: 'demoListenKeyBitwinexPreview' })
    if (/^\/api\/v3\/account$/.test(p)) return raw({ canTrade: true, canWithdraw: true, canDeposit: true, accountType: 'SPOT', balances: HOLD.map(function (h) { return { asset: h[0], free: h[1].toFixed(8), locked: h[2].toFixed(8) } }) })
    if (/\/futures-api\/fapi\/v3\/account$/.test(p)) return raw(futAccount())
    if (/\/futures-api\/fapi\/v3\/positionRisk$/.test(p)) return raw(futRisk())
    if (/\/futures-api\/fapi\/v1\/openOrders$/.test(p)) return raw([])
    if (/\/futures-api\/order\/(current_order_list|history_order_list)$/.test(p)) return ok({ count: 0, orderList: [] })
    if (/^\/api\/v3\/openOrders$/.test(p)) {
      var q = /symbol=([A-Za-z0-9]+)/.exec(path), want = q ? q[1].toLowerCase() : ''
      return raw(ORD_OPEN.map(function (r, i) { return orderRow(r, i, true) }).filter(function (o) { return !want || o.symbol === want }).map(function (o) { return { symbol: o.symbol.toUpperCase(), orderId: o.id, clientOrderId: 'web_' + o.id, price: o.price, origQty: o.volume, executedQty: o.deal_volume, cummulativeQuoteQty: o.deal_money, status: o.status === 3 ? 'PARTIALLY_FILLED' : 'NEW', timeInForce: 'GTC', type: 'LIMIT', side: o.side, time: o.time_long, updateTime: o.time_long, isWorking: true, origQuoteOrderQty: '0' } }))
    }
    if (/\/futures-api\/position\/get_assets_list$/.test(p)) return ok(futAssets())
    if (/\/futures-api\/user\/get_user_config$/.test(p)) return ok({ marginModel: 1, marginModelCanSwitch: 0, nowLevel: 20, minLevel: 1, maxLevel: 125, userMaxLevel: 125, levelCanSwitch: 1, openContract: 1, transStatus: 1, coUnit: 1, pcSecondConfirm: 0, positionModelCanSwitch: 0, currentTimeMillis: Date.now(), expireTime: 0, leverOriginCeiling: { 20: '5000000', 50: '1000000', 100: '250000', 125: '50000' } })
    if (/\/futures-api\/common\/get_ladder_info$/.test(p)) return ok({ ladderList: [] })
    if (/\/traderUser\/list$/.test(p)) return ok(traders())
    if (/\/traderUser\/myTraders$/.test(p)) { var t = traders()[1]; return ok([{ traderUid: t.uid, nickname: t.nickname, type: 0, rate: 1, amount: 0, deposit: 2000, followAmount: '2000', profit: '186.42', profitRatio: 9.32, ctime: NOW - 86400e3 * 12, status: 1 }]) }
    if (/\/traderUser\/myStatistics$/.test(p)) return ok({ followTotalAmount: '2000', profit: '186.42', rate: 18 })
    if (/\/traderUser\/currentStatus$/.test(p)) return ok({ uid: USER.id, status: -1 })
    if (/\/security\/login_history$/.test(p)) return ok({ count: 5, historyLoginList: [0, 1, 2, 3, 4].map(function (i) { return { formatLgInTime: new Date(NOW - i * 86400e3 * 1.7).toISOString().replace('T', ' ').slice(0, 19), lgIp: ['116.24.85.***', '116.24.85.***', '203.198.12.***', '116.24.85.***', '58.62.33.***'][i], lgPlatform: ['Mac Chrome', 'Mac Chrome', 'iPhone Safari', 'Mac Chrome', 'Windows Edge'][i], lgStatus: 1 } }) })
    if (/\/security\/setting_history$/.test(p)) return ok({ count: 0, historySettingList: [] })
    if (/\/openapi\/my_api_list$/.test(p)) return ok({ count: 0, apiList: null })
    if (/\/message\/user_message$/.test(p)) return ok({ userMessageList: [
      { id: 301, receiveUid: USER.id, messageType: 1, messageContent: '欢迎来到 BIYUN！您的账户已完成注册，开启安全验证可提高账户安全等级。', status: 2, ctime: NOW - 86400e3 * 20 },
      { id: 302, receiveUid: USER.id, messageType: 4, messageContent: '您的身份认证已通过审核。', status: 2, ctime: NOW - 86400e3 * 19 },
      { id: 303, receiveUid: USER.id, messageType: 2, messageContent: '您的 25,000 USDT 充值已到账。', status: 2, ctime: NOW - 86400e3 * 15 },
      { id: 304, receiveUid: USER.id, messageType: 3, messageContent: '您的账户于 Mac Chrome 登录，如非本人操作请立即修改密码。', status: 1, ctime: NOW - 3600e3 },
      { id: 305, receiveUid: USER.id, messageType: 1, messageContent: 'WIN 生态代币 Launchpad 认购已开启，快去参与吧。', status: 1, ctime: NOW - 3600e3 * 20 }],
      count: 5, pageSize: 10, messageType: 0, typeList: [{ tid: 1, title: '系统消息' }, { tid: 2, title: '充提消息' }, { tid: 3, title: '安全消息' }, { tid: 4, title: '认证消息' }] })
    if (/\/message\/get_no_read_message_count$/.test(p)) return ok({ noReadMsgCount: 2 })
    if (/\/return\/invite_info_list$/.test(p)) return ok({ coin: 'USDT', id: USER.id, inviteCode: 'BW8K2Q', inviteUrl: location.origin + '/register?inviteCode=BW8K2Q', inviteQECode: '', invite_number: 12, invite_list: ['138****5521', '159****0732', 'li***@gmail.com', '186****9015', 'wa***@qq.com'].map(function (n, i) { return { invitee: n, register_time: Math.round(NOW - i * 86400e3 * 3.3) } }), invite_return_number: '0' })
    if (/\/invite_code\/bonusList$/.test(p)) return ok([0, 1, 2, 3, 4, 5].map(function (i) { return { id: 800 + i, uid: 10090000 + i * 13, pid: USER.id, roleId: i % 2, symbol: 'USDT', feeSymbol: 'USDT', fee: (12.4 + i * 3.1).toFixed(4), scale: 20, amount: ((12.4 + i * 3.1) * 0.2).toFixed(4), ctime: NOW - i * 86400e3 * 1.4, email: ['li***@gmail.com', 'wa***@qq.com'][i % 2] } }))
    if (/\/lever\/finance\/symbol\/balance$/.test(p)) {
      var ls = String((body && body.symbol) || 'btcusdt').toLowerCase(), lb = ls.replace('usdt', '').toUpperCase(), lp = px(lb) || 1
      return ok({ symbol: ls.toUpperCase(), name: lb + '/USDT', baseCoin: lb, quoteCoin: 'USDT', baseTotalBalance: (3000 / lp).toFixed(6), baseNormalBalance: (3000 / lp).toFixed(6), baseLockBalance: '0', baseBorrowBalance: '0', baseInterest: '0', baseCanBorrow: (12000 / lp).toFixed(6), baseMinPayment: '0.0001', baseEXNormalBalance: '0.4215', quoteTotalBalance: '5000', quoteNormalBalance: '5000', quoteLockBalance: '0', quoteBorrowBalance: '2000', quoteInterest: '0.42', quoteCanBorrow: '18000', quoteMinPayment: '1', quoteEXNormalBalance: '25860.42', riskRate: '400', burstPrice: (lp * 0.62).toFixed(2), rate: '0.0005', multiple: '5', symbolBalance: '0.092', baseReturnPrecision: 6, quoteReturnPrecision: 2 })
    }
    if (/\/lever\/borrow\/(new|history)$/.test(p)) return ok({ count: 0, financeList: [] })
    if (/\/lever\/order\/(list\/new|history)$/.test(p)) return ok({ count: 0, orderList: [] })
    if (/\/lever\/finance\/balance$/.test(p)) return ok({ leverMap: {}, totalBalance: '0', totalBalanceSymbol: 'BTC', portfolioHoldings: [] })
    return null
  }

  function route(method, path, body) {
    var p = path.split('?')[0]
    var a = authRoute(method, p, body, path); if (a) return a
    if (/\/common\/public_info_v4$/.test(p)) return ok(spotInfo())
    if (/^\/futures-api\/common\/public_info$/.test(p)) return ok(futInfo())
    if (/\/common\/exchange_filters$/.test(p)) return ok({ filters: { enabled: false, symbols: {} } })
    if (/\/futures-api\/common\/public_market_info$/.test(p)) {
      var id = Number(body && body.contractId) || 1, r = FUT[id - 1] || FUT[0], s = M['e_' + r[0].toLowerCase() + 'usdt']
      return ok({ tagPrice: fmt(s.p * 1.00002, r[3]), indexPrice: fmt(s.p * 0.99996, r[3]), currentFundRate: '0.0001', nextFundRate: '0.000085' })
    }
    if (/\/cms\/footer\/list$/.test(p)) return ok([
      { id: 1, title: '用户协议', fileName: 'user-agreement' }, { id: 2, title: '隐私政策', fileName: 'privacy-policy' },
      { id: 3, title: '风险提示', fileName: 'risk-disclosure' }, { id: 4, title: '反洗钱政策', fileName: 'aml-policy' }])
    if (/^\/api\/v3\/exchangeInfo$/.test(p)) return { __raw: true, body: { timezone: 'UTC', serverTime: Date.now(), symbols: SPOT.map(function (r) { return { symbol: r[0] + 'USDT', status: 'TRADING', baseAsset: r[0], quoteAsset: 'USDT' } }) } }
    if (/\/common\/coinSymbol_introduce$/.test(p)) return ok(INTRO.map(function (r, i) { return { id: i + 1, coinSymbol: r[0], introduction: r[1], officialUrl: r[2], blockchainUrl: r[3] } }))
    if (/\/notice\/notice_info_list$/.test(p)) {
      var size = (body && body.pageSize) || 10
      return ok({ noticeInfoList: NOTICES.slice(0, size).map(function (n, i) { return { id: i + 1, title: n[0], lang: 'zh_CN', timeLong: Date.now() - n[1] * 3600e3, content: '<p>' + n[2] + '</p>' } }), count: NOTICES.length, pageSize: size, openSearch: 1 })
    }
    if (/\/notice\/notice_info$/.test(p)) {
      var n = NOTICES[(Number(body && body.id) || 1) - 1] || NOTICES[0]
      return ok({ noticeInfo: { id: Number(body && body.id) || 1, title: n[0], lang: 'zh_CN', ctime: Date.now() - n[1] * 3600e3, content: '<p>' + n[2] + '</p><p>感谢您对 BIYUN 的支持。</p><p>BIYUN 团队</p>' } })
    }
    if (/\/fee_info$/.test(p)) {
      return ok({ pairMapList: SPOT.map(function (r) { var o = { symbol: r[0] + '/USDT' }; for (var v = 0; v <= 9; v++) { o['TRADE_MAKER_VIP' + v] = (0.001 - v * 0.0001).toFixed(4); o['TRADE_TAKER_VIP' + v] = (0.001 - v * 0.00008).toFixed(5) } return o }) })
    }
    if (/\/futures-api\/common\/getMakerAndTaker$/.test(p)) return ok(FUT.map(function (r) { return { contractSide: 1, openMakerFee: '0.0002', openTakerFee: '0.0005', closeMakerFee: '0.0002', closeTakerFee: '0.0005', multiplier: r[4], multiplierCoin: r[0] } }))
    if (/\/futures-api\/common\/funding_rate_list$/.test(p)) {
      var rows = []; for (var k = 0; k < 20; k++) rows.push({ ctime: Date.now() - k * 8 * 3600e3, amount: (0.0001 - Math.random() * 0.00006).toFixed(6), contractName: 'E-BTC-USDT' })
      return ok({ brokenLineList: rows.slice().reverse(), historyList: rows, count: rows.length })
    }
    // 业务模块（理财 / 借币 / VIP / Launchpad / Launchpool）为原始 JSON
    if (/\/sapi\/v1\/simple-earn\/flexible\/list$/.test(p)) return raw({ total: EARN_FLEX.length, rows: EARN_FLEX.map(function (r, i) { return { productId: r[0] + '001', asset: r[0], latestAnnualPercentageRate: r[1], minPurchaseAmount: r[2], status: 'PURCHASING', canPurchase: true, canRedeem: true, isSoldOut: false, hot: i < 2, tierAnnualPercentageRate: {} } }) })
    if (/\/sapi\/v1\/simple-earn\/locked\/list$/.test(p)) return raw({ total: EARN_LOCK.length, rows: EARN_LOCK.map(function (r, i) { return { projectId: r[0] + r[1], detail: { asset: r[0], rewardAsset: r[0], duration: r[1], renewable: true, isSoldOut: false, apr: r[2], status: 'PURCHASING', canPurchase: true, earlyRedeemable: r[1] <= 30, subscriptionStartTime: Date.now() - 864e5 * 10 }, quota: { totalPersonalQuota: r[3], minimum: r[4] } } }) })
    if (/\/sapi\/v2\/loan\/flexible\/loanable\/data$/.test(p)) return raw({ total: 4, rows: [['USDT', '0.0612'], ['USDC', '0.0598'], ['BTC', '0.0215'], ['ETH', '0.0268']].map(function (r) { return { loanCoin: r[0], annualInterestRate: r[1], flexibleInterestRate: (Number(r[1]) / 8760).toFixed(9), flexibleMinLimit: r[0] === 'BTC' ? '0.001' : r[0] === 'ETH' ? '0.01' : '10', flexibleMaxLimit: r[0] === 'BTC' ? '50' : r[0] === 'ETH' ? '800' : '2000000' } }) })
    if (/\/sapi\/v1\/vip\/levels$/.test(p)) return raw({ enabled: true, levels: VIP.map(function (r) { return { level: String(r[0]), spotVolume30d: r[1], futuresVolume30d: r[2], assetUsdt: r[3], platformCoin: '0', combine: 'OR', spotMaker: r[4], spotTaker: r[5], futuresMaker: r[6], futuresTaker: r[7] } }) })
    if (/\/sapi\/v1\/launchpad\/projects$/.test(p)) return raw({ total: 2, rows: [
      { projectId: 'LP2611', title: 'WIN 生态代币首发', tokenCoin: 'WIN', quoteCoin: 'USDT', price: '0.085', totalSupply: '50000000', subscribeStart: Date.now() - 864e5, subscribeEnd: Date.now() + 864e5 * 3, status: 'subscribing', allowUncommit: true },
      { projectId: 'LP2610', title: 'ORBIT 链上清算协议', tokenCoin: 'ORBIT', quoteCoin: 'USDT', price: '0.12', totalSupply: '20000000', subscribeStart: Date.now() - 864e5 * 20, subscribeEnd: Date.now() - 864e5 * 16, status: 'distributed' }] })
    if (/\/sapi\/v1\/launchpool\/pools$/.test(p)) return raw({ total: 3, rows: [
      { poolId: 'P1', title: '质押 BTC 挖 WIN', stakeCoin: 'BTC', rewardCoin: 'WIN', includeEarn: true, estApr: '0.0832', totalStaked: '1286.42', myStaked: '0', myPendingStake: '0', myUnclaimed: '0', minStake: '0.001', status: 'online' },
      { poolId: 'P2', title: '质押 USDT 挖 WIN', stakeCoin: 'USDT', rewardCoin: 'WIN', includeEarn: true, estApr: '0.1215', totalStaked: '38420650', myStaked: '0', myPendingStake: '0', myUnclaimed: '0', minStake: '10', status: 'online' },
      { poolId: 'P3', title: '质押 ETH 挖 WIN', stakeCoin: 'ETH', rewardCoin: 'WIN', includeEarn: false, estApr: '0.0967', totalStaked: '9620.5', myStaked: '0', myPendingStake: '0', myUnclaimed: '0', minStake: '0.01', status: 'online' }] })
    if (/\/common\/rate$/.test(p)) return ok({ rate: { zh_CN: { USDT: '7.10' } }, lang_coin: { zh_CN: 'CNY' } })
    if (/^\/sapi\//.test(p)) return sapiEmpty()
    return null
  }
  var realFetch = window.fetch.bind(window)
  window.__mockLog = []
  window.fetch = function (u, init) {
    var s = typeof u === 'string' ? u : (u && u.url) || ''
    if (!(s.charAt(0) === '/' || s.indexOf(location.origin) === 0)) return realFetch(u, init)
    var path = s.indexOf(location.origin) === 0 ? s.slice(location.origin.length) : s
    var method = (init && init.method) || 'GET', body = null
    try { body = init && init.body ? JSON.parse(init.body) : null } catch (e) {}
    var res = null
    try { res = route(method, path, body) } catch (e) { console.error(e) }
    window.__mockLog.push((res ? 'OK  ' : 'MISS ') + method + ' ' + path)
    if (!res) res = { code: '503', msg: '预览环境未连接后端', data: null }
    var payload = res.__raw ? res.body : res
    var status = res.__raw || res.code === '0' ? 200 : 503
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(new Response(JSON.stringify(payload), { status: status, headers: { 'Content-Type': 'application/json' } })) }, 60)
    })
  }
})()
