import { describe, expect, it } from 'vitest'
import {
  amountsEqual,
  normalizeCouponCode,
  parseMerchantScreenshot,
} from './ocr-parser'

describe('amountsEqual', () => {
  it('allows differences exactly on the tolerance boundary', () => {
    expect(amountsEqual(1.2, 1.15, 0.05)).toBe(true)
    expect(amountsEqual(1.2, 1.149999, 0.05)).toBe(false)
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
