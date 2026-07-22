import { basename, dirname, join } from 'node:path'
import {
  amountsEqual,
  isOrderNumberCode,
  normalizeCouponCode,
  parseMerchantScreenshot,
  parsePaymentScreenshot,
} from './ocr-parser'
import { FINANCE_CHECK_ROW_CONCURRENCY } from './constants'
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
import { loadRows } from './excel-reader'
import {
  extractImages,
  loadImageIdMap,
  resolveImagePath,
} from './xlsx-images'

const AMOUNT_TOLERANCE = 0.01

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

function buildDuplicateFirstRowMap(rows: RowRecord[]): Map<number, number> {
  const seenCouponCodes = new Map<string, number>()
  const duplicateFirstRowByRow = new Map<number, number>()
  for (const row of rows) {
    if (row.isSummaryRow) continue
    const normalizedCode = normalizeCouponCode(row.couponCode)
    if (normalizedCode == null) continue
    const duplicateFirstRow = seenCouponCodes.get(normalizedCode)
    if (duplicateFirstRow == null) {
      seenCouponCodes.set(normalizedCode, row.rowNumber)
      continue
    }
    duplicateFirstRowByRow.set(row.rowNumber, duplicateFirstRow)
  }
  return duplicateFirstRowByRow
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
    this.tolerance = options.tolerance ?? AMOUNT_TOLERANCE
    this.ocrRecognizeProvider = options.ocrRecognizeProvider
  }

  async checkWorkbookConcurrent(
    xlsxPath: string,
    options: ConcurrentWorkbookCheckOptions = {},
  ): Promise<WorkbookCheckResult> {
    const rows = await loadRows(xlsxPath, options.sheetName)
    if (options.rowNumbers) {
      const available = new Set(rows.map((row) => row.rowNumber))
      const missing = [...options.rowNumbers].filter((rowNumber) => !available.has(rowNumber))
      if (missing.length > 0) {
        throw new Error(`表格中不存在以下行号: ${missing.sort((a, b) => a - b).join(', ')}`)
      }
    }

    const imageCacheDir = options.cacheDir ?? join(dirname(xlsxPath), '.cache', basename(xlsxPath, '.xlsx'))
    const imageIdMap = loadImageIdMap(xlsxPath)
    const extractedImages = await extractImages(xlsxPath, imageCacheDir)
    const duplicateFirstRowByRow = buildDuplicateFirstRowMap(rows)
    const concurrency = options.concurrency ?? FINANCE_CHECK_ROW_CONCURRENCY
    const rowResults: RowCheckResult[] = []
    const pendingChecks: Array<{ rowIndex: number; row: RowRecord }> = []
    let dataRowCount = 0

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]!
      if (options.rowNumbers && !options.rowNumbers.has(row.rowNumber)) continue
      if (row.isSummaryRow) {
        if (options.limit == null && (options.rowNumbers == null || options.rowNumbers.has(row.rowNumber))) {
          rowResults[rowIndex] = this.buildSummaryRowResult(row)
        }
        continue
      }
      if (options.limit != null && dataRowCount >= options.limit) break
      dataRowCount += 1
      pendingChecks.push({ rowIndex, row })
    }

    const totalRows = dataRowCount
    let processed = 0
    await runWithConcurrency(pendingChecks, concurrency, async ({ rowIndex, row }) => {
      if (options.shouldCancel && (await options.shouldCancel())) {
        throw new FinanceCheckCancelledError()
      }
      const rowResult = await this.buildDataRowResult(row, duplicateFirstRowByRow, imageIdMap, extractedImages)
      rowResults[rowIndex] = rowResult
      processed += 1
      await options.onRowProcessed?.(processed, totalRows, rowResult)
    })

    return {
      source: xlsxPath,
      rows: rowResults.filter((rowResult) => rowResult != null),
      imageCacheDir,
    }
  }

  async checkRow(
    row: RowRecord,
    imageIdMap: Map<string, string>,
    extractedImages: Map<string, string>,
  ): Promise<RowCheckResult> {
    return {
      row,
      paymentCheck: await this.checkPayment(row, imageIdMap, extractedImages),
      merchantCheck: await this.checkMerchant(row, imageIdMap, extractedImages),
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
    extractedImages: Map<string, string>,
  ): Promise<RowCheckResult> {
    const duplicateFirstRow = duplicateFirstRowByRow.get(row.rowNumber)
    if (duplicateFirstRow != null) {
      const duplicateMessage = `核销券码与第 ${duplicateFirstRow} 行重复`
      return {
        row,
        paymentCheck: failCheck('推单实付金额', row.expectedPaidAmount, duplicateMessage),
        merchantCheck: failCheck('商家实收', row.expectedMerchantAmount, duplicateMessage),
      }
    }
    return this.checkRow(row, imageIdMap, extractedImages)
  }

  private getOcrResult(imagePath: string): Promise<PaddleOcrRecognizeResult> {
    if (!this.ocrCache.has(imagePath)) {
      this.ocrCache.set(imagePath, this.ocrRecognizeProvider(imagePath))
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
    extractedImages: Map<string, string>,
  ): Promise<FieldCheck> {
    const fieldName = '推单实付金额'
    const normalizedCode = normalizeCouponCode(row.couponCode)
    if (!normalizedCode) return errorCheck(fieldName, row.expectedPaidAmount, '缺少核销券码')
    const imagePath = resolveImagePath(row.paymentImageId, imageIdMap, extractedImages)
    if (!imagePath) return errorCheck(fieldName, row.expectedPaidAmount, '未找到实付券码截图')

    const paymentMap = await this.getPaymentMap(imagePath)
    const actual = paymentMap.get(normalizedCode) ?? null
    const imageName = imagePath.split(/[/\\]/).pop() ?? imagePath
    const ocrText = await this.getOcrText(imagePath)
    if (actual == null) {
      const message = isOrderNumberCode(row.couponCode)
        ? `截图中未识别到订单号 ${row.couponCode} 的尾款实收`
        : `截图中未识别到券码 ${row.couponCode}`
      return {
        fieldName,
        status: CheckStatusKey.ERROR,
        expected: row.expectedPaidAmount,
        actual: null,
        message,
        details: buildCheckDetails(imageName, ocrText, 'payment', {
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
        message: '实付金额一致',
        details: buildCheckDetails(imageName, ocrText, 'payment', { coupon_code: row.couponCode }),
      }
    }
    return {
      fieldName,
      status: CheckStatusKey.FAIL,
      expected: row.expectedPaidAmount,
      actual,
      message: '实付金额不一致',
      details: buildCheckDetails(imageName, ocrText, 'payment', { coupon_code: row.couponCode }),
    }
  }

  private async checkMerchant(
    row: RowRecord,
    imageIdMap: Map<string, string>,
    extractedImages: Map<string, string>,
  ): Promise<FieldCheck> {
    const fieldName = '商家实收'
    const normalizedCode = normalizeCouponCode(row.couponCode)
    if (!normalizedCode) return errorCheck(fieldName, row.expectedMerchantAmount, '缺少核销券码')
    const imagePath = resolveImagePath(row.merchantImageId, imageIdMap, extractedImages)
    if (!imagePath) return errorCheck(fieldName, row.expectedMerchantAmount, '未找到商家实收图')

    const merchantMap = await this.getMerchantMap(imagePath)
    const actual = merchantMap.get(normalizedCode) ?? null
    const imageName = imagePath.split(/[/\\]/).pop() ?? imagePath
    const ocrText = await this.getOcrText(imagePath)
    if (actual == null) {
      return {
        fieldName,
        status: CheckStatusKey.ERROR,
        expected: row.expectedMerchantAmount,
        actual: null,
        message: `截图中未识别到券码 ${row.couponCode} 对应的收益`,
        details: buildCheckDetails(imageName, ocrText, 'merchant', {
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
        message: '商家实收一致',
        details: buildCheckDetails(imageName, ocrText, 'merchant', { coupon_code: row.couponCode }),
      }
    }
    return {
      fieldName,
      status: CheckStatusKey.FAIL,
      expected: row.expectedMerchantAmount,
      actual,
      message: '商家实收不一致',
      details: buildCheckDetails(imageName, ocrText, 'merchant', { coupon_code: row.couponCode }),
    }
  }
}

function buildCheckDetails(
  imageName: string,
  ocrText: string,
  imageType: 'payment' | 'merchant',
  extra: Record<string, unknown> = {},
): StructuredScreenshot & Record<string, unknown> {
  return {
    ...parseStructuredScreenshot(ocrText, { imageType }),
    image: imageName,
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
