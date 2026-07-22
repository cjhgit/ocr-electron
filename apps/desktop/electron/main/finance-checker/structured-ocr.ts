import {
  MERCHANT_ORDER_RE,
  normalizeCouponCode,
  parseMerchantScreenshot,
  parsePaymentScreenshot,
} from './ocr-parser'

const AMOUNT_RE = /[￥¥]\s*(\d+(?:\.\d+)?)/
const ORDER_NO_RE = /(?<!\d)(80\d{9})(?!\d)/
const VOUCHER_CODE_LINE_RE = /(?<!\d)(0\d{11})(?!\d)/
const PROJECT_ID_RE = /项目ID\s*(\d+)/
const DATETIME_RE = /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/

export type StructuredScreenshotImageType = 'payment' | 'merchant'

export type StructuredAmountItem = {
  code: string
  amount: number
}

export type StructuredMerchantItem = {
  code: string
  revenue: number
  title?: string
}

export type StructuredVoucherRedemption = {
  voucher_code: string
  title?: string
  project_id?: string
  received_amount?: number
}

export type StructuredScreenshot = {
  page: string | null
  order_info: Record<string, unknown>
  consumption_info: Record<string, number>
  voucher_redemptions: StructuredVoucherRedemption[]
  group_buys: StructuredMerchantItem[]
  pay_bills: StructuredMerchantItem[]
  parsed_payment_amounts: StructuredAmountItem[]
  parsed_merchant_revenues: StructuredAmountItem[]
}

export function parseStructuredScreenshot(
  text: string,
  options: { imageType?: StructuredScreenshotImageType | null } = {},
): StructuredScreenshot {
  const imageType = options.imageType ?? null
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const paymentAmounts =
    imageType === 'merchant' ? new Map<string, number>() : parsePaymentScreenshot(text)
  const merchantRevenues =
    imageType === 'payment' ? new Map<string, number>() : parseMerchantScreenshot(text)

  return {
    page: detectPage(lines),
    order_info: parseOrderInfo(lines),
    consumption_info: parseConsumptionInfo(lines),
    voucher_redemptions: parseVoucherRedemptions(lines),
    group_buys: parseMerchantItems(text, imageType, 'group_buy_detail'),
    pay_bills: parseMerchantItems(text, imageType, 'pay_bill_detail'),
    parsed_payment_amounts: amountMapToItems(paymentAmounts),
    parsed_merchant_revenues: amountMapToItems(merchantRevenues),
  }
}

function detectPage(lines: string[]): string | null {
  const joined = lines.join('\n')
  if (joined.includes('订单详情')) return 'order_detail'
  if (joined.includes('买单详情')) return 'pay_bill_detail'
  if (joined.includes('团购详情')) return 'group_buy_detail'
  if (joined.includes('买单') && joined.includes('收益')) return 'pay_bill_detail'
  if (joined.includes('团购') && joined.includes('收益')) return 'group_buy_detail'
  return null
}

function parseOrderInfo(lines: string[]): Record<string, unknown> {
  const orderInfo: Record<string, unknown> = {}
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const nextLine = index + 1 < lines.length ? lines[index + 1]! : ''
    if (line === '订单号') orderInfo.order_no = nextLine
    else if (line === '订单状态') orderInfo.order_status = nextLine
    else if (line === '消费门店') orderInfo.merchant_name = nextLine
    else if (line === '手机尾号') orderInfo.phone_tail = nextLine
    else if (line === '下单时间') orderInfo.ordered_at = nextLine
    else if (line === '活动') orderInfo.activity = nextLine
    else if (line.startsWith('取餐码')) orderInfo.pickup_code = line.replace('取餐码', '').trim()

    const orderMatch = ORDER_NO_RE.exec(line)
    if (!line.includes('订单号') && orderMatch && orderInfo.order_no == null) {
      orderInfo.order_no = orderMatch[1]
    }
    const datetimeMatch = DATETIME_RE.exec(line)
    if (datetimeMatch && orderInfo.ordered_at == null) orderInfo.ordered_at = datetimeMatch[0]
  }
  return orderInfo
}

function parseConsumptionInfo(lines: string[]): Record<string, number> {
  const info: Record<string, number> = {}
  const keyMap: Record<string, string> = {
    实际消费金额: 'actual_consumption_amount',
    团购券抵扣: 'group_coupon_deduction',
    尾款实收: 'tail_payment_received',
    实收金额: 'total_received_amount',
    团购券实收: 'group_coupon_received',
  }
  const start = findLineIndex(lines, '消费信息')
  if (start == null) return info
  let end = lines.length
  for (const marker of ['代金券核销信息', '订单信息', '退款']) {
    const markerIndex = findLineIndex(lines, marker, start + 1)
    if (markerIndex != null) end = Math.min(end, markerIndex)
  }
  for (let index = start; index < end; index += 1) {
    const line = lines[index]!
    for (const [chineseKey, englishKey] of Object.entries(keyMap)) {
      if (!line.includes(chineseKey)) continue
      let amount = amountFromLine(line)
      if (amount == null && index + 1 < lines.length) amount = amountFromLine(lines[index + 1]!)
      if (amount != null) info[englishKey] = amount
      break
    }
  }
  return info
}

function findLineIndex(lines: string[], keyword: string, start = 0): number | null {
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index]!.includes(keyword)) return index
  }
  return null
}

function findVoucherCodeNearRedemption(lines: string[], index: number): string | null {
  const currentLine = lines[index]!
  VOUCHER_CODE_LINE_RE.lastIndex = 0
  const onCurrent = VOUCHER_CODE_LINE_RE.exec(currentLine)
  if (onCurrent) return onCurrent[1] ?? onCurrent[0]
  return nextMatch(lines, index + 1, VOUCHER_CODE_LINE_RE, 4)
}

function cleanVoucherTitle(line: string): string {
  return line.replace(/\s*详情>\s*$/, '').trim()
}

function parseVoucherRedemptions(lines: string[]): StructuredVoucherRedemption[] {
  const items: StructuredVoucherRedemption[] = []
  let index = 0
  while (index < lines.length) {
    if (!lines[index]!.includes('核销券码')) {
      index += 1
      continue
    }
    const code = findVoucherCodeNearRedemption(lines, index)
    if (!code) {
      index += 1
      continue
    }
    const windowStart = Math.max(0, index - 4)
    const windowEnd = Math.min(lines.length, index + 10)
    const item: StructuredVoucherRedemption = { voucher_code: code }
    for (let back = index - 1; back >= windowStart; back -= 1) {
      const line = lines[back]!
      if (line.includes('代金券')) {
        item.title = cleanVoucherTitle(line)
        break
      }
    }
    for (let offset = windowStart; offset < windowEnd; offset += 1) {
      const projectMatch = PROJECT_ID_RE.exec(lines[offset]!)
      if (projectMatch) {
        item.project_id = projectMatch[1]
        break
      }
    }
    for (let offset = index; offset < windowEnd; offset += 1) {
      const line = lines[offset]!
      if (line === '实收金额' || line.startsWith('实收金额')) {
        let amount = amountFromLineForVoucher(line)
        for (let look = 1; amount == null && look <= 3 && offset + look < lines.length; look += 1) {
          amount = amountFromLineForVoucher(lines[offset + look]!)
        }
        if (amount != null) item.received_amount = amount
        break
      }
    }
    items.push(item)
    index += 1
  }
  return items
}

function parseMerchantItems(
  text: string,
  imageType: StructuredScreenshotImageType | null,
  page: 'group_buy_detail' | 'pay_bill_detail',
): StructuredMerchantItem[] {
  if (imageType === 'payment') return []
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const detected = detectPage(lines)
  if (detected && detected !== page) return []
  const revenueMap = parseMerchantScreenshot(text)
  if (revenueMap.size === 0) return []
  const items: StructuredMerchantItem[] = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!
    MERCHANT_ORDER_RE.lastIndex = 0
    for (const match of line.matchAll(MERCHANT_ORDER_RE)) {
      const rawCode = match[1] ?? match[0]
      const code = normalizeCouponCode(rawCode)
      if (!code || !revenueMap.has(code)) continue
      const item: StructuredMerchantItem = { code, revenue: revenueMap.get(code)! }
      const title = nearbyTitle(lines, lineIndex)
      if (title) item.title = title
      if (!items.some((existing) => existing.code === item.code && existing.revenue === item.revenue)) {
        items.push(item)
      }
    }
  }
  return items
}

function nearbyTitle(lines: string[], index: number): string | null {
  for (let i = index - 1; i >= Math.max(0, index - 4); i -= 1) {
    const line = lines[i]!
    if (['团购', '买单', '代金券'].some((keyword) => line.includes(keyword))) return line
  }
  return null
}

function amountMapToItems(amounts: Map<string, number>): StructuredAmountItem[] {
  return [...amounts.entries()].map(([code, amount]) => ({ code, amount }))
}

function amountFromLine(line: string): number | null {
  const match = AMOUNT_RE.exec(line)
  if (match) return Number(match[1])
  if (/^\d+(?:\.\d+)?$/.test(line.trim())) return Number(line.trim())
  return null
}

function amountFromLineForVoucher(line: string): number | null {
  const trimmed = line.trim()
  if (/^80\d{9}$/.test(trimmed) || /^0\d{11}$/.test(trimmed)) return null
  const match = AMOUNT_RE.exec(trimmed)
  if (match) {
    const value = Number(match[1])
    return value >= 1 && value <= 9999 ? value : null
  }
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const value = Number(trimmed)
    return value >= 1 && value <= 9999 ? value : null
  }
  return null
}

function nextMatch(lines: string[], start: number, pattern: RegExp, limit: number): string | null {
  for (const line of lines.slice(start, start + limit)) {
    const match = pattern.exec(line)
    if (match) return match[1] ?? match[0]
  }
  return null
}
