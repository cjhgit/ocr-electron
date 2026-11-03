import { basename, dirname, join } from 'node:path'
import {
  amountsEqual,
  findFuzzyCodeCandidates,
  findFuzzyCodeSpan,
  isOrderNumberCode,
  normalizeCouponCode,
  parseMerchantRevenueNearSpan,
  parseMerchantScreenshot,
  parsePaymentScreenshot,
  parseUniqueNonZeroTailPayment,
  parseVoucherAmountAtSpan,
  parseVoucherAmountCandidatesAtSpan,
} from './ocr-parser'
import {
  FINANCE_CHECK_AMOUNT_TOLERANCE,
  FINANCE_CHECK_OCR_WORKER_COUNT,
  FINANCE_CHECK_ROW_BATCH_SIZE,
} from './constants'
import {
  parseStructuredScreenshot,
  type StructuredScreenshot,
} from './structured-ocr'
import type {
  CheckStatus,
  FieldCheck,
  RowCheckResult,
  RowRecord,
  WorkbookCheckResult,
} from './types'
import { CheckStatusKey, overallStatus, summarizeRows } from './types'
import { iterateRowBatches } from './excel-reader'
import {
  loadImageIdMap,
  WorkbookImageExtractor,
} from './xlsx-images'

function formatLogDuration(startedAt: number): string {
  return `${Date.now() - startedAt}ms`
}

/** 模糊查找键：原始券码 + 去前导 0 后的码（Excel 文本码常带 0，OCR 可能丢掉） */
function fuzzyCodeKeys(rawCode: string | number | null, normalizedCode: string | null): string[] {
  return [...new Set([String(rawCode ?? '').trim(), normalizedCode ?? ''].filter(Boolean))]
}

function formatOptionalLogDuration(durationMs: number | null): string {
  return durationMs == null ? '-' : `${durationMs}ms`
}

export class FinanceCheckCancelledError extends Error {
  constructor(message = '用户已取消') {
    super(message)
    this.name = 'FinanceCheckCancelledError'
  }
}

export type PaddleOcrRecognizeResult = {
  text: string
}

export type OcrRecognizeProvider = (imagePath: string) => Promise<PaddleOcrRecognizeResult>

export type FinanceCheckerOptions = {
  tolerance?: number
  ocrRecognizeProvider: OcrRecognizeProvider
}

export type WorkbookCheckOptions = {
  cacheDir?: string
  sheetName?: string
  rowNumbers?: Set<number>
  limit?: number
  concurrency?: number
}

export type ConcurrentWorkbookCheckOptions = WorkbookCheckOptions & {
  onRowProcessed?: (processed: number, total: number, rowResult: RowCheckResult) => void | Promise<void>
  shouldCancel?: () => boolean | Promise<boolean>
}

type RowCheckWithTimings = {
  rowResult: RowCheckResult
  timings: {
    paymentImageMs: number | null
    merchantImageMs: number | null
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  async function runWorker(): Promise<void> {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      await worker(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))
}

export class FinanceChecker {
  private readonly tolerance: number
  private readonly ocrRecognizeProvider: OcrRecognizeProvider
  private readonly ocrCache = new Map<string, Promise<PaddleOcrRecognizeResult>>()
  private readonly paymentCache = new Map<string, Promise<Map<string, number>>>()
  private readonly merchantCache = new Map<string, Promise<Map<string, number>>>()

  constructor(options: FinanceCheckerOptions) {
    this.tolerance = options.tolerance ?? FINANCE_CHECK_AMOUNT_TOLERANCE
    this.ocrRecognizeProvider = options.ocrRecognizeProvider
  }

  async checkWorkbookConcurrent(
    xlsxPath: string,
    options: ConcurrentWorkbookCheckOptions = {},
  ): Promise<WorkbookCheckResult> {
    const readStartedAt = Date.now()
    const imageCacheDir = options.cacheDir ?? join(dirname(xlsxPath), '.cache', basename(xlsxPath, '.xlsx'))
    const imageIdMap = await loadImageIdMap(xlsxPath)
    const imageExtractor = new WorkbookImageExtractor(xlsxPath, imageCacheDir)
    const concurrency = options.concurrency ?? FINANCE_CHECK_OCR_WORKER_COUNT
    const batchSize = FINANCE_CHECK_ROW_BATCH_SIZE
    const seenCouponCodes = new Map<string, number>()
    const rowResults: RowCheckResult[] = []
    let sheetName = options.sheetName ?? ''
    let totalRows = 0
    let processed = 0
    let acceptedDataRows = 0
    let reachedLimit = false

    try {
      for await (const batch of iterateRowBatches(xlsxPath, {
        sheetName: options.sheetName,
        batchSize,
      })) {
        sheetName = batch.sheetName
        if (totalRows === 0) {
          totalRows = options.limit != null
            ? Math.min(batch.dataRowCount, options.limit)
            : batch.dataRowCount
          console.log(
            `[finance-check] 读取 Excel 元信息完成: ${xlsxPath}, sheet=${sheetName}, dataRows=${batch.dataRowCount}, batchSize=${batchSize}, duration=${formatLogDuration(readStartedAt)}`,
          )
        }

        const pendingChecks: RowRecord[] = []
        for (const row of batch.rows) {
          if (options.rowNumbers && !options.rowNumbers.has(row.rowNumber)) continue
          if (row.isSummaryRow) {
            if (options.limit == null && (options.rowNumbers == null || options.rowNumbers.has(row.rowNumber))) {
              rowResults.push(this.buildSummaryRowResult(row))
            }
            continue
          }
          if (options.limit != null && acceptedDataRows >= options.limit) {
            reachedLimit = true
            break
          }
          acceptedDataRows += 1
          const normalizedCode = normalizeCouponCode(row.couponCode)
          if (normalizedCode != null && !seenCouponCodes.has(normalizedCode)) {
            seenCouponCodes.set(normalizedCode, row.rowNumber)
          }
          pendingChecks.push(row)
        }

        const duplicateFirstRowByRow = new Map<number, number>()
        for (const row of pendingChecks) {
          const normalizedCode = normalizeCouponCode(row.couponCode)
          if (normalizedCode == null) continue
          const firstRow = seenCouponCodes.get(normalizedCode)
          if (firstRow != null && firstRow !== row.rowNumber) {
            duplicateFirstRowByRow.set(row.rowNumber, firstRow)
          }
        }

        console.log(
          `[finance-check] 开始处理批次 #${batch.batchIndex}: rows=${pendingChecks.length}, progress=${processed}/${totalRows || batch.dataRowCount}`,
        )

        await runWithConcurrency(pendingChecks, concurrency, async (row) => {
          if (options.shouldCancel && (await options.shouldCancel())) {
            throw new FinanceCheckCancelledError()
          }
          const rowStartedAt = Date.now()
          const { rowResult, timings } = await this.buildDataRowResult(
            row,
            duplicateFirstRowByRow,
            imageIdMap,
            imageExtractor,
          )
          rowResults.push(rowResult)
          processed += 1
          console.log(
            `[finance-check] 第 ${row.rowNumber} 行处理完成: duration=${formatLogDuration(rowStartedAt)}, paymentImageParse=${formatOptionalLogDuration(timings.paymentImageMs)}, merchantImageParse=${formatOptionalLogDuration(timings.merchantImageMs)}, progress=${processed}/${totalRows}`,
          )
          await options.onRowProcessed?.(processed, totalRows, rowResult)
        })

        // 批次结束后释放本批行引用，图片文件仍落在磁盘缓存，OCR 文本缓存保留以复用同图
        pendingChecks.length = 0
        if (reachedLimit) break
      }

      if (options.rowNumbers) {
        const available = new Set(rowResults.map((item) => item.row.rowNumber))
        const missing = [...options.rowNumbers].filter((rowNumber) => !available.has(rowNumber))
        if (missing.length > 0) {
          throw new Error(`表格中不存在以下行号: ${missing.sort((a, b) => a - b).join(', ')}`)
        }
      }

      rowResults.sort((a, b) => a.row.rowNumber - b.row.rowNumber)
      return {
        source: xlsxPath,
        sheetName,
        rows: rowResults,
        imageCacheDir,
      }
    } finally {
      await imageExtractor.close()
    }
  }

  async checkRow(
    row: RowRecord,
    imageIdMap: Map<string, string>,
    imageExtractor: WorkbookImageExtractor,
  ): Promise<RowCheckResult> {
    return {
      row,
      paymentCheck: await this.checkPayment(row, imageIdMap, imageExtractor),
      merchantCheck: await this.checkMerchant(row, imageIdMap, imageExtractor),
    }
  }

  private buildSummaryRowResult(row: RowRecord): RowCheckResult {
    return {
      row,
      paymentCheck: skipCheck('推单实付金额', row.expectedPaidAmount),
      merchantCheck: skipCheck('商家实收', row.expectedMerchantAmount),
    }
  }

  private async buildDataRowResult(
    row: RowRecord,
    duplicateFirstRowByRow: Map<number, number>,
    imageIdMap: Map<string, string>,
    imageExtractor: WorkbookImageExtractor,
  ): Promise<RowCheckWithTimings> {
    const duplicateFirstRow = duplicateFirstRowByRow.get(row.rowNumber)
    if (duplicateFirstRow != null) {
      const duplicateMessage = `核销券码与第 ${duplicateFirstRow} 行重复`
      return {
        rowResult: {
          row,
          paymentCheck: failCheck('推单实付金额', row.expectedPaidAmount, duplicateMessage),
          merchantCheck: failCheck('商家实收', row.expectedMerchantAmount, duplicateMessage),
        },
        timings: {
          paymentImageMs: null,
          merchantImageMs: null,
        },
      }
    }
    return this.checkRowWithTimings(row, imageIdMap, imageExtractor)
  }

  private async checkRowWithTimings(
    row: RowRecord,
    imageIdMap: Map<string, string>,
    imageExtractor: WorkbookImageExtractor,
  ): Promise<RowCheckWithTimings> {
    const paymentStartedAt = Date.now()
    let paymentCheck: FieldCheck
    try {
      paymentCheck = await this.checkPayment(row, imageIdMap, imageExtractor)
    } catch (error) {
      console.error(`[finance-check] 第 ${row.rowNumber} 行推单实付金额核验失败`, error)
      paymentCheck = errorCheck('推单实付金额', row.expectedPaidAmount, formatImageCheckError(error))
    }
    const paymentImageMs = Date.now() - paymentStartedAt

    const merchantStartedAt = Date.now()
    let merchantCheck: FieldCheck
    try {
      merchantCheck = await this.checkMerchant(row, imageIdMap, imageExtractor)
    } catch (error) {
      console.error(`[finance-check] 第 ${row.rowNumber} 行商家实收核验失败`, error)
      merchantCheck = errorCheck('商家实收', row.expectedMerchantAmount, formatImageCheckError(error))
    }
    const merchantImageMs = Date.now() - merchantStartedAt

    return {
      rowResult: {
        row,
        paymentCheck,
        merchantCheck,
      },
      timings: {
        paymentImageMs,
        merchantImageMs,
      },
    }
  }

  private getOcrResult(imagePath: string): Promise<PaddleOcrRecognizeResult> {
    if (!this.ocrCache.has(imagePath)) {
      const startedAt = Date.now()
      console.log(`[finance-check] OCR 开始: ${imagePath}`)
      const request = this.ocrRecognizeProvider(imagePath)
        .then((result) => {
          console.log(`[finance-check] OCR 完成: ${imagePath}, duration=${formatLogDuration(startedAt)}, textLength=${result.text.length}`)
          return result
        })
        .catch((error) => {
          this.ocrCache.delete(imagePath)
          console.error(`[finance-check] OCR 失败: ${imagePath}, duration=${formatLogDuration(startedAt)}`, error)
          throw error
        })
      this.ocrCache.set(imagePath, request)
    }
    return this.ocrCache.get(imagePath)!
  }

  private async getOcrText(imagePath: string): Promise<string> {
    return (await this.getOcrResult(imagePath)).text
  }

  private getPaymentMap(imagePath: string): Promise<Map<string, number>> {
    if (!this.paymentCache.has(imagePath)) {
      this.paymentCache.set(imagePath, this.getOcrText(imagePath).then((text) => parsePaymentScreenshot(text)))
    }
    return this.paymentCache.get(imagePath)!
  }

  private getMerchantMap(imagePath: string): Promise<Map<string, number>> {
    if (!this.merchantCache.has(imagePath)) {
      this.merchantCache.set(imagePath, this.getOcrText(imagePath).then((text) => parseMerchantScreenshot(text)))
    }
    return this.merchantCache.get(imagePath)!
  }

  private async checkPayment(
    row: RowRecord,
    imageIdMap: Map<string, string>,
    imageExtractor: WorkbookImageExtractor,
  ): Promise<FieldCheck> {
    const fieldName = '推单实付金额'
    const normalizedCode = normalizeCouponCode(row.couponCode)
    if (!normalizedCode) return errorCheck(fieldName, row.expectedPaidAmount, '缺少核销券码')
    const imagePath = await imageExtractor.resolveImagePath(row.paymentImageId, imageIdMap)
    if (!imagePath) return errorCheck(fieldName, row.expectedPaidAmount, '未找到实付券码截图')

    const paymentMap = await this.getPaymentMap(imagePath)
    const imageName = imagePath.split(/[/\\]/).pop() ?? imagePath
    const ocrText = await this.getOcrText(imagePath)
    let actual = paymentMap.get(normalizedCode) ?? null
    let fuzzyExtra: Record<string, unknown> | null = null
    if (actual == null) {
      // OCR 在长图上可能丢字或多识别（如 033966624104 -> 0396624104），编辑距离 <= 2 时模糊定位后照常取金额
      for (const key of fuzzyCodeKeys(row.couponCode, normalizedCode)) {
        const span = findFuzzyCodeSpan(ocrText, key)
        if (!span) continue
        // 用表格原始券码判定订单号类型：坏码可能不再满足 80 开头 11 位格式
        let amount = parseVoucherAmountAtSpan(
          ocrText,
          span.start,
          span.end,
          span.run,
          undefined,
          isOrderNumberCode(row.couponCode),
        )
        if (amount != null && !amountsEqual(row.expectedPaidAmount, amount, this.tolerance)) {
          // 区段标签可能被读坏导致取到券面值（如 ¥20 而非 19.8）：候选金额与期望一致的才校正
          const hit = parseVoucherAmountCandidatesAtSpan(ocrText, span.end)
            .find((candidate) => amountsEqual(row.expectedPaidAmount, candidate, this.tolerance))
          if (hit != null) amount = hit
        }
        if (amount != null) {
          actual = amount
          fuzzyExtra = { fuzzy_matched_run: span.run, fuzzy_distance: span.distance }
          break
        }
      }
    }
    if (actual == null) {
      // 坏得更厉害的券码（距离 3-4）：在候选里找「区段金额与期望一致」的那个，金额对得上才采信
      outer: for (const key of fuzzyCodeKeys(row.couponCode, normalizedCode)) {
        for (const span of findFuzzyCodeCandidates(ocrText, key, 4)) {
          const amount = parseVoucherAmountAtSpan(
            ocrText,
            span.start,
            span.end,
            span.run,
            undefined,
            isOrderNumberCode(row.couponCode),
          )
          if (amount != null && amountsEqual(row.expectedPaidAmount, amount, this.tolerance)) {
            actual = amount
            fuzzyExtra = { fuzzy_matched_run: span.run, fuzzy_distance: span.distance, amount_anchored: true }
            break outer
          }
          // 标签被读坏的区段：遍历区段内多个金额候选，与期望一致的才采信
          for (const candidate of parseVoucherAmountCandidatesAtSpan(ocrText, span.end)) {
            if (amountsEqual(row.expectedPaidAmount, candidate, this.tolerance)) {
              actual = candidate
              fuzzyExtra = { fuzzy_matched_run: span.run, fuzzy_distance: span.distance, amount_anchored: true }
              break outer
            }
          }
        }
      }
    }
    if (actual == null && isOrderNumberCode(row.couponCode)) {
      // 智能点餐短截图可能整图没有订单号：用顶部汇总里唯一的非零尾款实收兜底，金额一致才通过
      const tail = parseUniqueNonZeroTailPayment(ocrText)
      if (tail != null && amountsEqual(row.expectedPaidAmount, tail, this.tolerance)) {
        actual = tail
        fuzzyExtra = { summary_tail_anchored: true }
      }
    }
    if (actual == null) {
      const message = isOrderNumberCode(row.couponCode)
        ? `实付券码截图中未识别到订单号 ${row.couponCode} 的尾款实收`
        : `实付券码截图中未识别到券码 ${row.couponCode}`
      return {
        fieldName,
        status: CheckStatusKey.ERROR,
        expected: row.expectedPaidAmount,
        actual: null,
        message,
        details: buildCheckDetails(imageName, imagePath, ocrText, 'payment', {
          coupon_code: row.couponCode,
          recognized_codes: [...paymentMap.keys()],
        }),
      }
    }
    if (amountsEqual(row.expectedPaidAmount, actual, this.tolerance)) {
      return {
        fieldName,
        status: CheckStatusKey.PASS,
        expected: row.expectedPaidAmount,
        actual,
        message: fuzzyExtra ? '实付金额一致（券码模糊匹配）' : '实付金额一致',
        details: buildCheckDetails(imageName, imagePath, ocrText, 'payment', {
          coupon_code: row.couponCode,
          ...fuzzyExtra,
        }),
      }
    }
    return {
      fieldName,
      status: CheckStatusKey.FAIL,
      expected: row.expectedPaidAmount,
      actual,
      message: '实付金额不一致',
      details: buildCheckDetails(imageName, imagePath, ocrText, 'payment', {
        coupon_code: row.couponCode,
        ...fuzzyExtra,
      }),
    }
  }

  private async checkMerchant(
    row: RowRecord,
    imageIdMap: Map<string, string>,
    imageExtractor: WorkbookImageExtractor,
  ): Promise<FieldCheck> {
    const fieldName = '商家实收'
    const normalizedCode = normalizeCouponCode(row.couponCode)
    if (!normalizedCode) return errorCheck(fieldName, row.expectedMerchantAmount, '缺少核销券码')
    const imagePath = await imageExtractor.resolveImagePath(row.merchantImageId, imageIdMap)
    if (!imagePath) return errorCheck(fieldName, row.expectedMerchantAmount, '未找到商家实收图')

    const merchantMap = await this.getMerchantMap(imagePath)
    const imageName = imagePath.split(/[/\\]/).pop() ?? imagePath
    const ocrText = await this.getOcrText(imagePath)
    let actual = merchantMap.get(normalizedCode) ?? null
    let fuzzyExtra: Record<string, unknown> | null = null
    if (actual == null) {
      for (const key of fuzzyCodeKeys(row.couponCode, normalizedCode)) {
        const span = findFuzzyCodeSpan(ocrText, key)
        if (!span) continue
        const revenue = parseMerchantRevenueNearSpan(ocrText, span.start)
        if (revenue != null) {
          actual = revenue
          fuzzyExtra = { fuzzy_matched_run: span.run, fuzzy_distance: span.distance }
          break
        }
      }
    }
    if (actual == null) {
      outer: for (const key of fuzzyCodeKeys(row.couponCode, normalizedCode)) {
        for (const span of findFuzzyCodeCandidates(ocrText, key, 4)) {
          const revenue = parseMerchantRevenueNearSpan(ocrText, span.start)
          if (revenue != null && amountsEqual(row.expectedMerchantAmount, revenue, this.tolerance)) {
            actual = revenue
            fuzzyExtra = { fuzzy_matched_run: span.run, fuzzy_distance: span.distance, amount_anchored: true }
            break outer
          }
        }
      }
    }
    if (actual == null) {
      return {
        fieldName,
        status: CheckStatusKey.ERROR,
        expected: row.expectedMerchantAmount,
        actual: null,
        message: `商家实收图中未识别到券码 ${row.couponCode} 对应的收益`,
        details: buildCheckDetails(imageName, imagePath, ocrText, 'merchant', {
          coupon_code: row.couponCode,
          recognized_order_ids: [...merchantMap.keys()],
        }),
      }
    }
    if (amountsEqual(row.expectedMerchantAmount, actual, this.tolerance)) {
      return {
        fieldName,
        status: CheckStatusKey.PASS,
        expected: row.expectedMerchantAmount,
        actual,
        message: fuzzyExtra ? '商家实收一致（券码模糊匹配）' : '商家实收一致',
        details: buildCheckDetails(imageName, imagePath, ocrText, 'merchant', {
          coupon_code: row.couponCode,
          ...fuzzyExtra,
        }),
      }
    }
    return {
      fieldName,
      status: CheckStatusKey.FAIL,
      expected: row.expectedMerchantAmount,
      actual,
      message: '商家实收不一致',
      details: buildCheckDetails(imageName, imagePath, ocrText, 'merchant', {
        coupon_code: row.couponCode,
        ...fuzzyExtra,
      }),
    }
  }
}

function formatImageCheckError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/maxMemoryUsageInMB limit exceeded/i.test(message)) {
    return 'OCR 识别失败：图片分辨率过大或解码内存超限，请压缩图片后重试'
  }
  return `图片核验失败：${message}`
}

function buildCheckDetails(
  imageName: string,
  imagePath: string,
  ocrText: string,
  imageType: 'payment' | 'merchant',
  extra: Record<string, unknown> = {},
): StructuredScreenshot & Record<string, unknown> {
  return {
    ...parseStructuredScreenshot(ocrText, { imageType }),
    image: imageName,
    imagePath,
    ...extra,
  }
}

function skipCheck(fieldName: string, expected: number | null): FieldCheck {
  return { fieldName, status: CheckStatusKey.SKIP, expected, actual: null, message: '汇总行，跳过校验', details: {} }
}

function errorCheck(fieldName: string, expected: number | null, message: string): FieldCheck {
  return { fieldName, status: CheckStatusKey.ERROR, expected, actual: null, message, details: {} }
}

function failCheck(fieldName: string, expected: number | null, message: string): FieldCheck {
  return { fieldName, status: CheckStatusKey.FAIL, expected, actual: null, message, details: {} }
}

function fieldCheckToDict(check: FieldCheck | null) {
  if (!check) return null
  return {
    field_name: check.fieldName,
    status: check.status,
    expected: check.expected,
    actual: check.actual,
    message: check.message,
    details: check.details,
  }
}

export function renderJsonReport(result: WorkbookCheckResult) {
  return {
    source: result.source,
    summary: summarizeRows(result.rows),
    rows: result.rows.map((rowResult) => ({
      row_number: rowResult.row.rowNumber,
      coupon_code: rowResult.row.couponCode,
      expected_paid_amount: rowResult.row.expectedPaidAmount,
      expected_merchant_amount: rowResult.row.expectedMerchantAmount,
      remark: rowResult.row.remark,
      overall_status: overallStatus(rowResult),
      payment_check: fieldCheckToDict(rowResult.paymentCheck),
      merchant_check: fieldCheckToDict(rowResult.merchantCheck),
    })),
  }
}

export type FinanceCheckJsonReport = ReturnType<typeof renderJsonReport>

export function isFailureSummary(summary: Record<CheckStatus, number>): boolean {
  return summary.fail > 0 || summary.error > 0
}
