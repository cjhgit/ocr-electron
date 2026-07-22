const VOUCHER_CODE_RE = /(?<!\d)(0\d{11})(?!\d)/g
const ORDER_CODE_RE = /(?<!\d)(80\d{9})(?!\d)/g
export const MERCHANT_ORDER_RE = /(?<!\d)(80\d{9}|0\d{11}|[23]\d{10})(?!\d)/g
const DECIMAL_AMOUNT_RE = /(?<!\d)(\d+\.\d{2})(?!\d)/g
const BRACKET_AMOUNT_RE = /\[(\d+(?:\.\d+)?)[^\]]*元\]/g

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
  const decimalMatch = /(?<!\d)(\d+\.\d{2})(?!\d)/.exec(snippet)
  return decimalMatch ? Number(decimalMatch[1]) : null
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
  return [...matches.keys()].sort((a, b) => a - b).map((key) => matches.get(key)!)
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
  for (const pattern of [/尾款实收[^\d]{0,12}(\d+(?:\.\d+)?)/, /尾款[^\d]{0,8}实收[^\d]{0,8}(\d+(?:\.\d+)?)/]) {
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
  const labelIndex = snippet.indexOf('实收金额')
  if (labelIndex < 0) return null
  const yenMatch = /[¥￥]\s*(\d+(?:\.\d+)?)/.exec(snippet.slice(labelIndex + '实收金额'.length))
  return yenMatch ? Number(yenMatch[1]) : null
}

export function parsePaymentScreenshot(text: string): Map<string, number> {
  const pairs = new Map<string, number>()
  const codes = collectPaymentCodes(text)
  for (let index = 0; index < codes.length; index += 1) {
    const [, end, code] = codes[index]!
    const nextStart = index + 1 < codes.length ? codes[index + 1]![0] : end + 80
    const snippetEnd = Math.min(nextStart, end + 80)
    const snippet = text.slice(end, snippetEnd)
    let amount = parsePaymentAmountAfterCode(snippet, 0)
    if (amount == null && !isOrderNumberCode(code)) amount = parseVoucherAmountNearCode(text, end)
    if (amount == null && isOrderNumberCode(code)) amount = parseOrderTailPaymentAmount(text, end)
    if (amount == null && isOrderNumberCode(code)) amount = parseTailPaymentAmount(text, end)
    registerPaymentPair(pairs, code, amount)
  }
  return pairs
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

export function parseBracketAmounts(text: string): number[] {
  const amounts: number[] = []
  for (const match of text.matchAll(BRACKET_AMOUNT_RE)) {
    amounts.push(Number(match[1]))
  }
  return amounts
}

export function amountsEqual(expected: number | null, actual: number | null, tolerance = 0.01): boolean {
  if (expected == null || actual == null) return false
  return Math.abs(expected - actual) <= tolerance
}
