const VOUCHER_CODE_RE = /(?<!\d)(0\d{11})(?!\d)/g
const ORDER_CODE_RE = /(?<!\d)(80\d{9})(?!\d)/g
// OCR 偶尔丢失券码前导 0（031754194560 -> 31754194560），仅当所在行基本只有该数字时采信
const VOUCHER_ALT_CODE_RE = /(?<!\d)([123]\d{10})(?!\d)/g
export const MERCHANT_ORDER_RE = /(?<!\d)(80\d{9}|0\d{11}|[123]\d{10})(?!\d)/g
const DECIMAL_AMOUNT_RE = /(?<!\d)(\d+\.\d{2})(?!\d)/g
const BRACKET_AMOUNT_RE = /\[(\d+(?:\.\d+)?)[^\]]*元\]/g
const AMOUNT_COMPARE_EPSILON = 1e-9

export function normalizeCouponCode(code: string | number | null | undefined): string | null {
  if (code == null) return null
  let text = String(code).trim()
  if (!text) return null
  if (text.endsWith('.0')) text = text.slice(0, -2)
  text = text.replace(/^0+/, '') || '0'
  return text
}

export function isOrderNumberCode(code: string | null | undefined): boolean {
  if (!code) return false
  let text = String(code).trim()
  if (text.endsWith('.0')) text = text.slice(0, -2)
  return /^80\d{9}$/.test(text)
}

function parseYenToken(token: string): number | null {
  const trimmed = token.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed)
    return value >= 1 && value <= 9999 ? value : null
  }
  if (/^9[Aa]$/.test(trimmed)) return 94
  if (/^\d[Aa]$/.test(trimmed) && trimmed[0] === '9') return 94
  if (/^[O0Q][Aa4]$/i.test(trimmed)) return 94
  if (/^\d+\.\d+$/.test(trimmed)) {
    const value = Number(trimmed)
    return value >= 1 && value <= 9999 ? value : null
  }
  return null
}

export function parsePaymentAmountAfterCode(text: string, start: number): number | null {
  const snippet = text.slice(start, start + 80)
  const yenMatch = /[¥￥yY$]\s*(\S+)/.exec(snippet)
  if (yenMatch) {
    const amount = parseYenToken(yenMatch[1] ?? '')
    if (amount != null) return amount
  }
  // 排除时间片段（如 11:13.32 的 13.32）被误当金额
  const decimalMatch = /(?<![\d:：])(\d+\.\d{2})(?!\d)/.exec(snippet)
  return decimalMatch ? Number(decimalMatch[1]) : null
}

const PAID_LABEL_RE = /实付\s*[¥￥]?\s*(\d+(?:\.\d+)?)/g

/**
 * 「待到店使用」等新版式里，实付金额（实付¥95）出现在券码上方，
 * 券码下方反而有券面值（(1张）￥100），因此优先取距券码最近的「实付」标签金额。
 */
export function parsePaidAmountNearCode(text: string, codeStart: number, codeEnd: number): number | null {
  const windowStart = Math.max(0, codeStart - 120)
  const windowEnd = Math.min(text.length, codeEnd + 120)
  let best: { distance: number; amount: number } | null = null
  for (const match of text.slice(windowStart, windowEnd).matchAll(PAID_LABEL_RE)) {
    if (match.index == null) continue
    const value = Number(match[1])
    if (!(value > 0 && value <= 99999)) continue
    const matchStart = windowStart + match.index
    const matchEnd = matchStart + match[0].length
    const distance = matchEnd <= codeStart ? codeStart - matchEnd : matchStart - codeEnd
    if (best == null || distance < best.distance) best = { distance, amount: value }
  }
  return best?.amount ?? null
}

function registerPaymentPair(pairs: Map<string, number>, code: string | null, amount: number | null): void {
  const normalized = normalizeCouponCode(code)
  if (normalized && amount != null) pairs.set(normalized, amount)
}

function collectPaymentCodes(text: string): Array<[number, number, string]> {
  const matches = new Map<number, [number, number, string]>()
  for (const pattern of [VOUCHER_CODE_RE, ORDER_CODE_RE]) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      if (match.index != null) {
        matches.set(match.index, [match.index, match.index + match[0].length, match[1] ?? match[0]])
      }
    }
  }
  VOUCHER_ALT_CODE_RE.lastIndex = 0
  for (const match of text.matchAll(VOUCHER_ALT_CODE_RE)) {
    const index = match.index
    if (index == null || matches.has(index)) continue
    const rawCode = match[1] ?? match[0]
    const normalized = normalizeCouponCode(rawCode)
    if (!normalized) continue
    const lineStart = text.lastIndexOf('\n', index - 1) + 1
    const newlineIndex = text.indexOf('\n', index)
    const line = text.slice(lineStart, newlineIndex === -1 ? text.length : newlineIndex)
    const digitsOnly = line.replace(/\D/g, '')
    // 所在行数字长度需与券码接近，避免把日期、手机号等长数字串误认成券码
    if (digitsOnly.length <= normalized.length + 4) {
      matches.set(index, [index, index + match[0].length, rawCode])
    }
  }
  appendCodesFromSpaceBrokenLines(text, matches)
  return [...matches.keys()].sort((a, b) => a - b).map((key) => matches.get(key)!)
}

/**
 * OCR 偶尔把券码从中间断开（如 03316892 3692），逐行去掉空格后再补充匹配。
 * 已含券码的行跳过，匹配到的码以整行作为位置范围（金额就近查找用）。
 */
function appendCodesFromSpaceBrokenLines(text: string, matches: Map<number, [number, number, string]>): void {
  let offset = 0
  for (const line of text.split('\n')) {
    const lineStart = offset
    const lineEnd = offset + line.length
    offset = lineEnd + 1
    if (!line.trim()) continue
    const hasCodeInLine = [...matches.keys()].some((index) => index >= lineStart && index < lineEnd)
    if (hasCodeInLine) continue
    const compact = line.replace(/\s+/g, '')
    for (const pattern of [VOUCHER_CODE_RE, ORDER_CODE_RE]) {
      pattern.lastIndex = 0
      const match = pattern.exec(compact)
      if (match?.index != null) {
        matches.set(lineStart, [lineStart, lineEnd, match[1] ?? match[0]])
        break
      }
    }
    if (matches.has(lineStart)) continue
    VOUCHER_ALT_CODE_RE.lastIndex = 0
    const altMatch = VOUCHER_ALT_CODE_RE.exec(compact)
    if (altMatch?.index == null) continue
    const rawCode = altMatch[1] ?? altMatch[0]
    const normalized = normalizeCouponCode(rawCode)
    if (!normalized) continue
    const digitsOnly = compact.replace(/\D/g, '')
    if (digitsOnly.length <= normalized.length + 4) {
      matches.set(lineStart, [lineStart, lineEnd, rawCode])
    }
  }
}

export function parseTailPaymentAmount(text: string, start: number): number | null {
  for (const snippet of [text.slice(0, start), text.slice(start, start + 200)]) {
    const tailMatch = /尾款[^\d]{0,12}(\d+(?:\.\d+)?)/.exec(snippet)
    if (tailMatch) return Number(tailMatch[1])
  }
  return null
}

function nextYenAmount(text: string, limit = 120): number | null {
  const match = /[¥￥yY$]\s*(\S+)/.exec(text.slice(0, limit))
  return match ? parseYenToken(match[1] ?? '') : null
}

function collectPrefixYenAmounts(text: string, codeEnd: number): number[] {
  const amounts: number[] = []
  for (const match of text.slice(0, codeEnd).matchAll(/[¥￥yY$]\s*(\S+)/g)) {
    const amount = parseYenToken(match[1] ?? '')
    if (amount != null && amount >= 0) amounts.push(amount)
  }
  return amounts
}

function extractTailFromConsumptionAmounts(amounts: number[]): number | null {
  for (let index = 0; index < amounts.length - 2; index += 1) {
    const total = amounts[index]!
    const deduction = amounts[index + 1]!
    const tail = amounts[index + 2]!
    if (total <= 0 || deduction < 0 || tail < 0) continue
    if (deduction <= total && Math.abs(total - deduction - tail) <= 0.01) return tail
  }
  return null
}

export function parseOrderTailPaymentAmount(text: string, codeEnd: number): number | null {
  const prefix = text.slice(0, codeEnd)
  // 「尾」也可能被误读（屌款实收 等），放宽为「款实收」
  for (const pattern of [/款实收[^\d]{0,12}(\d+(?:\.\d+)?)/, /尾款[^\d]{0,8}实收[^\d]{0,8}(\d+(?:\.\d+)?)/]) {
    const match = pattern.exec(prefix)
    if (match) return Number(match[1])
  }
  const garbledMatch = /BR[A-Za-z"' ]*[^\d]{0,6}¥\s*(\d+(?:\.\d+)?)/.exec(prefix)
  if (garbledMatch) return Number(garbledMatch[1])
  const deductionMatch = /团购券抵扣[^\d]{0,12}(\d+(?:\.\d+)?)/.exec(prefix)
  if (deductionMatch) {
    const tail = nextYenAmount(prefix.slice(deductionMatch.index! + deductionMatch[0].length))
    if (tail != null) return tail
  }
  return extractTailFromConsumptionAmounts(collectPrefixYenAmounts(text, codeEnd))
}

function isProjectLine(line: string): boolean {
  const keywords = ['代金券', '20260301', '1617341194', '项目', 'TRABM', 'MABR', 'TABM', 'MABM']
  return keywords.some((keyword) => line.includes(keyword))
}

function extractOrderIdsFromLine(line: string): string[] {
  const orderIds = extractOrderIdsFromLineText(line)
  // OCR 偶尔把券码从中间断开（如 03316892 3692），去空格后重试
  return orderIds.length > 0 ? orderIds : extractOrderIdsFromLineText(line.replace(/\s+/g, ''))
}

function extractOrderIdsFromLineText(line: string): string[] {
  if (isProjectLine(line)) return []
  const orderIds: string[] = []
  MERCHANT_ORDER_RE.lastIndex = 0
  for (const match of line.matchAll(MERCHANT_ORDER_RE)) {
    const rawId = match[1] ?? match[0]
    if (rawId.startsWith('20260301') || rawId === '1617341194') continue
    const digitsOnly = line.replace(/\D/g, '')
    const normalized = normalizeCouponCode(rawId)
    if (!normalized) continue
    if (digitsOnly.includes(normalized) && digitsOnly.length <= normalized.length + 4) {
      orderIds.push(rawId)
    }
  }
  return orderIds
}

function extractRevenue(window: string): number | null {
  for (const line of window.split('\n').slice(0, 8)) {
    if (isProjectLine(line) || line.includes('[')) continue
    DECIMAL_AMOUNT_RE.lastIndex = 0
    for (const match of line.matchAll(DECIMAL_AMOUNT_RE)) {
      const value = Number(match[1])
      if (value >= 1 && value <= 9999) return value
    }
  }
  return null
}

function parseVoucherAmountNearCode(text: string, codeEnd: number): number | null {
  const snippet = text.slice(codeEnd, codeEnd + 160)
  // 「实收金额」的「额」常被 OCR 误读（实收金颜/实收余颛 等），按「实收 + 短间隔 + ¥」宽松匹配
  const labelMatch = /实收[^¥￥]{0,6}[¥￥]\s*(\d+(?:\.\d+)?)/.exec(snippet)
  return labelMatch ? Number(labelMatch[1]) : null
}

export function parsePaymentScreenshot(text: string): Map<string, number> {
  const pairs = new Map<string, number>()
  const codes = collectPaymentCodes(text)
  for (let index = 0; index < codes.length; index += 1) {
    const [start, end, code] = codes[index]!
    const nextStart = index + 1 < codes.length ? codes[index + 1]![0] : end + 80
    const snippetEnd = Math.min(nextStart, end + 80)
    const amount = parseVoucherAmountAtSpan(text, start, end, code, snippetEnd)
    registerPaymentPair(pairs, code, amount)
  }
  return pairs
}

/**
 * 券码位置的金额解析链。
 * 订单号：实付标签（就近）→ 尾款实收（码前）→ 尾款 → 盲扫（码后）。
 * 券码：实付标签（就近）→ 实收金额标签（码后）→ 盲扫（码后）。
 * OCR 读坏的码可能不再满足订单号格式，调用方可传 forceOrder 按表格原始券码判定。
 */
export function parseVoucherAmountAtSpan(
  text: string,
  start: number,
  end: number,
  code?: string,
  snippetEnd?: number,
  forceOrder?: boolean,
): number | null {
  const snippet = text.slice(end, Math.min(snippetEnd ?? text.length, end + 80))
  let amount = parsePaidAmountNearCode(text, start, end)
  const order = forceOrder ?? (code ? isOrderNumberCode(code) : false)
  if (order) {
    if (amount == null) amount = parseOrderTailPaymentAmount(text, end)
    if (amount == null) amount = parseTailPaymentAmount(text, end)
    if (amount == null) amount = parsePaymentAmountAfterCode(snippet, 0)
    if (amount == null) amount = parseUniqueNonZeroTailPayment(text)
  } else {
    if (amount == null) amount = parseVoucherAmountNearCode(text, end)
    if (amount == null) amount = parsePaymentAmountAfterCode(snippet, 0)
  }
  return amount
}

/**
 * 区段内全部金额候选（¥ 前缀金额 + 裸小数），供「金额锚定」使用：
 * 标签被读坏的区段（如 实公合af 19.8），只要候选里有与期望一致的金额即可采信。
 */
export function parseVoucherAmountCandidatesAtSpan(text: string, end: number): number[] {
  const window = text.slice(end, end + 120)
  const values: number[] = []
  for (const match of window.matchAll(/[¥￥]\s*(\d{1,4}(?:\.\d{1,2})?)/g)) {
    values.push(Number(match[1]))
  }
  for (const match of window.matchAll(/(?<![\d:.])(\d{1,4}\.\d{1,2})(?!\d)/g)) {
    values.push(Number(match[1]))
  }
  return [...new Set(values)]
}

/**
 * 整图唯一的非零「尾款实收」：智能点餐短截图可能不含订单号段落，
 * 只能靠顶部汇总里唯一的非零尾款实收（收银通道的 0 元不算）。
 */
export function parseUniqueNonZeroTailPayment(text: string): number | null {
  const values: number[] = []
  for (const match of text.matchAll(/款实收[^\d¥￥]{0,8}[¥￥]\s*(\d+(?:\.\d+)?)/g)) {
    const value = Number(match[1])
    if (value > 0) values.push(value)
  }
  const unique = [...new Set(values)]
  return unique.length === 1 ? unique[0]! : null
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost)
    }
    previous = current
  }
  return previous[b.length]!
}

const DIGIT_RUN_RE = /(?<!\d)\d{8,16}(?!\d)/g

export type FuzzyCodeSpan = {
  start: number
  end: number
  run: string
  distance: number
}

/**
 * 全部编辑距离 <= maxDistance 的候选数字串，按距离升序（同距按出现顺序）。
 * 供「金额锚定」回退使用：距离较远的坏码，只有当其所在区段金额与期望一致时才采信。
 */
export function findFuzzyCodeCandidates(text: string, code: string, maxDistance: number): FuzzyCodeSpan[] {
  if (!code) return []
  const candidates: FuzzyCodeSpan[] = []
  for (const match of text.matchAll(DIGIT_RUN_RE)) {
    const run = match[0]
    if (match.index == null) continue
    if (Math.abs(run.length - code.length) > maxDistance) continue
    const distance = levenshtein(run, code)
    if (distance > maxDistance) continue
    candidates.push({ start: match.index, end: match.index + run.length, run, distance })
  }
  candidates.sort((a, b) => a.distance - b.distance || a.start - b.start)
  return candidates
}

function isSubsequence(small: string, big: string): boolean {
  let index = 0
  for (const char of big) {
    if (index < small.length && small[index] === char) index += 1
  }
  return index === small.length
}

/**
 * OCR 在长图上识别券码可能丢数字或多识别（033966624104 -> 0396624104 / 0351367249160）。
 * 精确匹配失败时，用编辑距离 <= 2 在文本中定位最接近的数字串。
 * 丢字更多时（如 030944477795 -> 030947795，丢 3 位），回退到「按顺序子序列」匹配：
 * 数字串是券码的子序列（丢字）或券码是数字串的子序列（多字），且长度差 <= 4。
 */
export function findFuzzyCodeSpan(text: string, code: string, maxDistance = 2): FuzzyCodeSpan | null {
  if (!code) return null
  const exactish = findFuzzyCodeCandidates(text, code, maxDistance)
  const best = exactish[0]
  if (best) return best

  let fallback: FuzzyCodeSpan | null = null
  for (const match of text.matchAll(DIGIT_RUN_RE)) {
    const run = match[0]
    if (match.index == null) continue
    const lengthDiff = run.length - code.length
    if (lengthDiff >= -4 && lengthDiff <= 4 && (isSubsequence(run, code) || isSubsequence(code, run))) {
      const candidate: FuzzyCodeSpan = {
        start: match.index,
        end: match.index + run.length,
        run,
        distance: Math.abs(lengthDiff) + 2,
      }
      if (fallback == null || candidate.distance < fallback.distance) fallback = candidate
    }
  }
  return fallback
}

export function parseMerchantScreenshot(text: string): Map<string, number> {
  const pairs = new Map<string, number>()
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const orderIds = extractOrderIdsFromLine(line)
    if (orderIds.length === 0) continue
    const revenue = extractRevenue(lines.slice(index, index + 10).join('\n'))
    if (revenue == null) continue
    for (const rawOrderId of orderIds) {
      const orderId = normalizeCouponCode(rawOrderId)
      if (orderId) pairs.set(orderId, revenue)
    }
  }
  return pairs
}

/**
 * 商家图模糊定位后的收益提取：找到坏码所在行，取其后 10 行窗口内的金额（与精确路径口径一致）。
 */
export function parseMerchantRevenueNearSpan(text: string, start: number): number | null {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const newlineIndex = text.indexOf('\n', start)
  const lineText = text.slice(lineStart, newlineIndex === -1 ? text.length : newlineIndex).trim()
  const lineIndex = lines.findIndex((line) => line === lineText)
  if (lineIndex < 0) return null
  return extractRevenue(lines.slice(lineIndex, lineIndex + 10).join('\n'))
}

export function parseBracketAmounts(text: string): number[] {
  const amounts: number[] = []
  for (const match of text.matchAll(BRACKET_AMOUNT_RE)) {
    amounts.push(Number(match[1]))
  }
  return amounts
}

export function amountsEqual(expected: number | null, actual: number | null, tolerance: number): boolean {
  if (expected == null || actual == null) return false
  return Math.abs(expected - actual) <= tolerance + AMOUNT_COMPARE_EPSILON
}
