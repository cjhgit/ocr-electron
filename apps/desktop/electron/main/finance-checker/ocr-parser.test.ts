import { describe, expect, it } from 'vitest'
import {
  amountsEqual,
  findFuzzyCodeCandidates,
  findFuzzyCodeSpan,
  normalizeCouponCode,
  parseMerchantRevenueNearSpan,
  parseMerchantScreenshot,
  parsePaymentScreenshot,
  parseUniqueNonZeroTailPayment,
  parseVoucherAmountAtSpan,
  parseVoucherAmountCandidatesAtSpan,
} from './ocr-parser'

describe('amountsEqual', () => {
  it('allows differences exactly on the tolerance boundary', () => {
    expect(amountsEqual(1.2, 1.15, 0.05)).toBe(true)
    expect(amountsEqual(1.2, 1.149999, 0.05)).toBe(false)
  })
})

describe('parsePaymentScreenshot', () => {
  it('extracts the paid amount above the voucher code on 待到店使用 screenshots', () => {
    const text = [
      '待到店使用',
      '请在2027/10/1023:59(含)前到店消费',
      '昭苏县博斯坎酸奶粽子（乌孙路店)',
      '100元代金券> ¥95',
      '代金券 周一至周日·全场通用 ×1',
      '随时退·过期自动退·免预约 实付¥95>',
      '待使用券码1张 申请退款 查看券码',
      '·031754194560复制 待使用',
      '代金券详情',
      '(1张）￥100',
    ].join('\n')

    const code = normalizeCouponCode('031754194560')

    // 券面值 ￥100 出现在券码下方，不应被当成实付金额
    expect(parsePaymentScreenshot(text).get(code!)).toBe(95)
  })

  it('matches voucher codes displayed without the leading zero', () => {
    const text = [
      '待到店使用',
      '实付¥95> 随时退·过期自动退·免预约',
      '待使用 .32399494083 复制',
      '(1张）￥100',
    ].join('\n')

    const code = normalizeCouponCode('032399494083')

    expect(parsePaymentScreenshot(text).get(code!)).toBe(95)
  })

  it('prefers labeled 实收金额 over the face-value 抵扣金额 after the code on 核销详情 screenshots', () => {
    const text = [
      '消费信息',
      '实际消费金额 ￥298',
      '团购券抵扣 ￥100',
      '尾款实收 ￥198',
      '实收金额 ¥288',
      '团购券实收 ￥90',
      '尾款实收 ￥198',
      '代金券核销信息(1张)',
      '90代100元代金券 详情>',
      '项目ID 1324542103',
      '核销券码 031702703114□',
      '抵扣金额￥100',
      '实收金额￥90',
      '核销方式',
      '券码状态已核销',
      '订单信息',
      '订单号 80014796607 □',
      '订单状态 已完成',
    ].join('\n')

    const voucherCode = normalizeCouponCode('031702703114')
    const orderCode = normalizeCouponCode('80014796607')
    const payments = parsePaymentScreenshot(text)

    expect(payments.get(voucherCode!)).toBe(90)
    expect(payments.get(orderCode!)).toBe(198)
  })

  it('matches voucher codes split by OCR with an inner space', () => {
    const text = [
      '订单详情',
      '待到店使用 领红包',
      '【伊犁特色揪片子】精品双> ¥176',
      '周一至周日·到店吃 ×1',
      '随时退、过期自动退、免预约 实付¥176>',
      '待使用券码1张 申请退款',
      '03316892 3692复制 待使用',
      '团购详情',
    ].join('\n')

    const code = normalizeCouponCode('033168923692')

    expect(parsePaymentScreenshot(text).get(code!)).toBe(176)
  })
})

describe('fuzzy code span', () => {
  const longText = [
    '代金券核销信息(4张)',
    '99代100元代金券 详情>',
    '项目ID 1540324124',
    '核销券码0396624104',
    '抵扣金额¥100',
    '实收金额￥99',
    '核销方式',
    '券码状态已核销',
    '99代100元代金券 详情>',
    '项目ID 1540324124',
    '核销券码 0351367249160',
    '抵扣金额￥100',
    '实收金额¥99',
    '订单号 80055076331',
  ].join('\n')

  it('locates runs with dropped or extra digits', () => {
    const dropped = findFuzzyCodeSpan(longText, '033966624104')
    expect(dropped?.run).toBe('0396624104')
    expect(dropped?.distance).toBeLessThanOrEqual(2)

    const extra = findFuzzyCodeSpan(longText, '035136724916')
    expect(extra?.run).toBe('0351367249160')
    expect(extra?.distance).toBeLessThanOrEqual(2)
  })

  it('does not match unrelated digit runs', () => {
    expect(findFuzzyCodeSpan(longText, '033333229457')).toBeNull()
    expect(findFuzzyCodeSpan(longText, '80055076999')).toBeNull()
  })

  it('extracts the labeled amount at the fuzzy span', () => {
    const span = findFuzzyCodeSpan(longText, '033966624104')
    expect(span).not.toBeNull()
    expect(parseVoucherAmountAtSpan(longText, span!.start, span!.end, span!.run)).toBe(99)
  })

  it('locates codes that dropped more digits via in-order subsequence', () => {
    const droppedText = [
      '核销券码03086637700日',
      '抵扣金额￥100',
      '实收金额￥98.25',
      '核销券码030144677474 日',
      '核销券码030947795',
      '抵扣金额￥100',
      '实收金额￥98.25',
      '订单号 80055609295',
    ].join('\n')

    const span = findFuzzyCodeSpan(droppedText, '030944477795')
    expect(span?.run).toBe('030947795')

    // 其他真实券码与订单号不应被误认
    expect(findFuzzyCodeSpan(droppedText, '033333229457')).toBeNull()
    expect(findFuzzyCodeSpan(droppedText, '80055699999')).toBeNull()
  })

  it('extracts tail payment for misread order numbers using the sheet-side code type', () => {
    const text = [
      '消费信息',
      '实际消费金额 ¥411',
      '团购券抵扣 ¥400',
      '尾款实收 ¥11',
      '团购券实收 ¥391',
      '代金券核销信息(4张)',
      '核销券码030994277073',
      '抵扣金额¥100',
      '实收金额¥97.75',
      '订单信息',
      '订单号 800595488日',
      '订单状态 已完成',
      '下单时间 2026-10-02 16:47:06',
    ].join('\n')

    // 表格券码 80059555488 被 OCR 读成 800595488，坏码不再满足订单号格式
    const span = findFuzzyCodeSpan(text, '80059555488')
    expect(span?.run).toBe('800595488')
    expect(parseVoucherAmountAtSpan(text, span!.start, span!.end, span!.run, undefined, true)).toBe(11)
  })

  it('does not treat time fragments as amounts for exact order numbers', () => {
    const text = [
      '消费信息',
      '尾款实收 ￥80',
      '团购券实收 ￥282',
      '订单信息',
      '订单号 80098170815 0',
      '订单状态 已完成',
      '手机尾号 3022',
      '下单时间 2026-10-18 11:13.32',
    ].join('\n')

    const payments = parsePaymentScreenshot(text)
    expect(payments.get(normalizeCouponCode('80098170815')!)).toBe(80)
  })

  it('extracts merchant revenue at a fuzzy span', () => {
    const text = [
      '团购详情',
      '团购 验券',
      '32254129809',
      '收益 91.88',
      '下单时间 2026/10/06 14:23:35',
      '消费门店 通辽市_老北京麻辣香锅(百货大楼店)',
    ].join('\n')

    const span = findFuzzyCodeSpan(text, '032254129829')
    expect(span?.run).toBe('32254129809')
    expect(parseMerchantRevenueNearSpan(text, span!.start)).toBe(91.88)
  })
})

describe('garbled labels', () => {
  it('matches 实收金额 with OCR-misread suffix characters', () => {
    const text = [
      '代金券核销信息(4张)',
      '核销券码032247668330',
      '抵扣金颠￥100',
      '实收金颜¥99',
      '核销方式',
      '券码状态 已核悄',
    ].join('\n')

    const code = normalizeCouponCode('032247668330')

    // 抵扣金额（券面值 100）排在前面，不应被当成实付
    expect(parsePaymentScreenshot(text).get(code!)).toBe(99)
  })

  it('matches 尾款实收 with a misread leading character', () => {
    const text = [
      '团购券抵扣 ￥400',
      '屌款实收 ￥40',
      '团购券实收 ￥396',
      '订单信息',
      '订单号 80065538299',
    ].join('\n')

    const code = normalizeCouponCode('80065538299')

    expect(parsePaymentScreenshot(text).get(code!)).toBe(40)
  })
})

describe('amount-anchored fuzzy candidates', () => {
  it('lists badly misread codes within distance 4', () => {
    const text = [
      '核销券码 03056777630',
      '抵扣金额¥100',
      '实收金额￥98.25',
      '核销方式',
    ].join('\n')

    const candidates = findFuzzyCodeCandidates(text, '030565777663', 4)
    expect(candidates[0]?.run).toBe('03056777630')
  })
})

describe('garbled section amounts', () => {
  it('collects both face value and paid amount as candidates', () => {
    const text = [
      '控#的23057687515',
      '挺抵1合ū ¥20',
      '实公合af 19.8',
      '核方式·',
    ].join('\n')

    const span = findFuzzyCodeSpan(text, '30576875215')
    expect(span).not.toBeNull()
    const candidates = parseVoucherAmountCandidatesAtSpan(text, span!.end)
    expect(candidates).toContain(20)
    expect(candidates).toContain(19.8)
  })

  it('falls back to the unique non-zero tail payment of the whole image', () => {
    const text = [
      '实收金额 ￥264',
      '智能点餐核销美团/大众点评团购实收 ¥180',
      '智能点餐核销一键买单尾款实收② ¥84',
      '收银核销美团/大众点评团购实收② ￥0',
      '收银核销一键买单尾款实收② ¥0',
    ].join('\n')

    expect(parseUniqueNonZeroTailPayment(text)).toBe(84)
  })

  it('returns null when multiple non-zero tails exist', () => {
    const text = [
      '智能点餐核销一键买单尾款实收② ¥84',
      '收银核销一键买单尾款实收② ¥6',
    ].join('\n')

    expect(parseUniqueNonZeroTailPayment(text)).toBeNull()
  })
})

describe('parseMerchantScreenshot', () => {
  it('matches merchant revenues for voucher codes displayed without the leading zero', () => {
    const text = [
      '团购详情',
      '团购',
      '17097773783',
      '收益 87.40',
      '下单时间 2026/06/20 13:03:06',
      '验券时间 2026/06/20 13:03:16',
      '消费门店 内江市_老表大排档（资州大道南二段店）',
      '项目名称 20251214_100元代金券_红房子餐饮店代金券[95.0元][1547664773]',
      '签约资质名称 官詹',
    ].join('\n')

    const code = normalizeCouponCode('017097773783')

    expect(parseMerchantScreenshot(text).get(code!)).toBe(87.4)
  })
})
