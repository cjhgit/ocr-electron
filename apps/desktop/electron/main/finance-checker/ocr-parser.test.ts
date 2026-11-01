import { describe, expect, it } from 'vitest'
import {
  amountsEqual,
  normalizeCouponCode,
  parseMerchantScreenshot,
  parsePaymentScreenshot,
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
