import ExcelJS from 'exceljs'
import { FINANCE_CHECK_ROW_BATCH_SIZE } from './constants'
import type { RowRecord } from './types'
import { extractDispimgId } from './xlsx-images'

const HEADER_ALIASES = {
  pushDate: ['推单日期'],
  city: ['城市'],
  merchantName: ['商家名称'],
  pusher: ['推单人员'],
  couponCode: ['核销券码'],
  paymentImage: ['实付券码', '实付券码图', '实付券码截图', '一键买单或智能点餐'],
  expectedPaidAmount: ['推单实付金额'],
  expectedMerchantAmount: ['商家实收', '商家实收金额'],
  merchantImage: ['商家实收图', '商家实收截图', '实收截图'],
  remark: ['备注'],
} as const

type HeaderField = keyof typeof HEADER_ALIASES

const HEADER_FIELD_LABELS: Record<HeaderField, string> = {
  pushDate: '推单日期',
  city: '城市',
  merchantName: '商家名称',
  pusher: '推单人员',
  couponCode: '核销券码',
  paymentImage: '实付券码',
  expectedPaidAmount: '推单实付金额',
  expectedMerchantAmount: '商家实收',
  merchantImage: '商家实收图',
  remark: '备注',
}

export const FINANCE_CHECK_UPLOAD_REQUIRED_FIELDS = [
  'couponCode',
  'paymentImage',
  'expectedMerchantAmount',
  'merchantImage',
] as const satisfies readonly HeaderField[]

const PROCESSING_REQUIRED_FIELDS: HeaderField[] = [
  'couponCode',
  'paymentImage',
  'expectedPaidAmount',
  'expectedMerchantAmount',
  'merchantImage',
]

type SheetCandidate = {
  sheetName: string
  headerMap: Partial<Record<HeaderField, number>>
  matchCount: number
  dataRowCount: number
}

type StreamWorksheet = ExcelJS.stream.xlsx.WorksheetReader & {
  name?: string
  id?: number | string
}

function normalizeHeader(value: unknown): string {
  if (value == null) return ''
  return String(value)
    .trim()
    .replace(/\u52b5/g, '\u5238') // 劵 → 券
    .replace(/\s+/g, '')
}

function buildHeaderMapFromValues(values: unknown[]): Partial<Record<HeaderField, number>> {
  const normalized = new Map<string, number>()
  values.forEach((header, index) => {
    const text = normalizeHeader(header)
    if (text && index > 0) normalized.set(text, index)
  })
  const mapping: Partial<Record<HeaderField, number>> = {}
  for (const [fieldName, aliases] of Object.entries(HEADER_ALIASES) as Array<[HeaderField, readonly string[]]>) {
    for (const alias of aliases) {
      const col = normalized.get(alias)
      if (col != null) {
        mapping[fieldName] = col
        break
      }
    }
  }
  return mapping
}

function cellText(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.result != null) return cellText(record.result)
    if (record.text != null) return cellText(record.text)
    if (record.richText != null && Array.isArray(record.richText)) {
      return cellText(record.richText.map((part) => (part as { text?: string }).text ?? '').join(''))
    }
  }
  const text = String(value).trim()
  return text || null
}

function parseAmount(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number') return value
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.result != null) return parseAmount(record.result)
  }
  const text = String(value).trim()
  if (!text || text.startsWith('=')) return null
  const match = /-?\d+(?:\.\d+)?/.exec(text.replace(/,/g, ''))
  return match ? Number(match[0]) : null
}

function isSummaryRow(values: Record<string, unknown>): boolean {
  const coupon = values.couponCode
  const paid = values.expectedPaidAmount
  const merchant = values.expectedMerchantAmount
  if (coupon == null && values.paymentImage == null && values.merchantImage == null) {
    if (typeof paid === 'string' && paid.startsWith('=')) return true
    if (typeof merchant === 'string' && merchant.startsWith('=')) return true
    if (typeof paid === 'object' && paid && 'formula' in (paid as object)) return true
    if (typeof merchant === 'object' && merchant && 'formula' in (merchant as object)) return true
  }
  return false
}

function extractCellDispimgId(cell: ExcelJS.Cell): string | null {
  const fromValue = extractDispimgId(cell.value)
  if (fromValue) return fromValue
  const fromFormula = extractDispimgId(cell.formula)
  if (fromFormula) return fromFormula
  return extractDispimgId(cell.text)
}

function countMatchedRequiredFields(
  headerMap: Partial<Record<HeaderField, number>>,
  required: readonly HeaderField[],
): number {
  return required.filter((field) => headerMap[field] != null).length
}

function assertRequiredHeaders(headerMap: Partial<Record<HeaderField, number>>, required: readonly HeaderField[]): void {
  const missing = required.filter((field) => headerMap[field] == null)
  if (missing.length > 0) {
    throw new Error(`表格缺少必要列：${missing.map((field) => HEADER_FIELD_LABELS[field]).join('、')}`)
  }
}

function createWorkbookReader(xlsxPath: string): ExcelJS.stream.xlsx.WorkbookReader {
  return new ExcelJS.stream.xlsx.WorkbookReader(xlsxPath, {
    entries: 'ignore',
    sharedStrings: 'cache',
    styles: 'ignore',
    hyperlinks: 'ignore',
    worksheets: 'emit',
  })
}

function parseStreamRow(row: ExcelJS.Row, headerMap: Partial<Record<HeaderField, number>>): RowRecord | null {
  const get = (field: HeaderField): unknown => {
    const col = headerMap[field]
    return col == null ? null : row.getCell(col).value
  }
  const paymentCell = headerMap.paymentImage ? row.getCell(headerMap.paymentImage) : null
  const merchantCell = headerMap.merchantImage ? row.getCell(headerMap.merchantImage) : null
  const values = {
    couponCode: get('couponCode'),
    expectedPaidAmount: get('expectedPaidAmount'),
    expectedMerchantAmount: get('expectedMerchantAmount'),
    paymentImage: paymentCell?.value ?? null,
    merchantImage: merchantCell?.value ?? null,
  }
  if (Object.values(values).every((value) => value == null)) return null

  return {
    rowNumber: row.number,
    pushDate: get('pushDate'),
    city: cellText(get('city')),
    merchantName: cellText(get('merchantName')),
    pusher: cellText(get('pusher')),
    couponCode: cellText(values.couponCode),
    expectedPaidAmount: parseAmount(values.expectedPaidAmount),
    expectedMerchantAmount: parseAmount(values.expectedMerchantAmount),
    paymentImageId: paymentCell ? extractCellDispimgId(paymentCell) : null,
    merchantImageId: merchantCell ? extractCellDispimgId(merchantCell) : null,
    remark: cellText(get('remark')),
    isSummaryRow: isSummaryRow(values),
  }
}

async function inspectWorkbook(
  xlsxPath: string,
  sheetName: string | undefined,
  required: readonly HeaderField[],
): Promise<{ sheetName: string; headerMap: Partial<Record<HeaderField, number>>; dataRowCount: number }> {
  const reader = createWorkbookReader(xlsxPath)
  const candidates: SheetCandidate[] = []

  for await (const worksheet of reader) {
    const streamWorksheet = worksheet as StreamWorksheet
    const name = streamWorksheet.name || `Sheet${streamWorksheet.id ?? ''}`
    let headerMap: Partial<Record<HeaderField, number>> | null = null
    let dataRowCount = 0

    for await (const row of worksheet) {
      if (row.number === 1) {
        const values = Array.isArray(row.values) ? [...row.values] : []
        headerMap = buildHeaderMapFromValues(values)
        continue
      }
      if (!headerMap) continue
      const parsed = parseStreamRow(row, headerMap)
      if (!parsed) continue
      if (!parsed.isSummaryRow) dataRowCount += 1
    }

    if (!headerMap) continue
    if (sheetName && name !== sheetName) continue
    candidates.push({
      sheetName: name,
      headerMap,
      matchCount: countMatchedRequiredFields(headerMap, required),
      dataRowCount,
    })
  }

  if (sheetName) {
    const matched = candidates.find((item) => item.sheetName === sheetName)
    if (!matched) throw new Error(`工作表不存在: ${sheetName}`)
    assertRequiredHeaders(matched.headerMap, required)
    if (matched.dataRowCount === 0) throw new Error('表格中没有可对账的数据行')
    return {
      sheetName: matched.sheetName,
      headerMap: matched.headerMap,
      dataRowCount: matched.dataRowCount,
    }
  }

  if (candidates.length === 0) throw new Error('表格中没有工作表')

  let best = candidates[0]!
  for (const candidate of candidates) {
    if (candidate.matchCount === required.length) {
      best = candidate
      break
    }
    if (candidate.matchCount > best.matchCount) best = candidate
  }

  assertRequiredHeaders(best.headerMap, required)
  if (best.dataRowCount === 0) throw new Error('表格中没有可对账的数据行')
  return {
    sheetName: best.sheetName,
    headerMap: best.headerMap,
    dataRowCount: best.dataRowCount,
  }
}

export async function validateFinanceCheckUpload(xlsxPath: string, sheetName?: string): Promise<void> {
  await inspectWorkbook(xlsxPath, sheetName, FINANCE_CHECK_UPLOAD_REQUIRED_FIELDS)
}

export async function loadRows(
  xlsxPath: string,
  sheetName?: string,
): Promise<{ rows: RowRecord[]; sheetName: string }> {
  const rows: RowRecord[] = []
  let resolvedSheetName = sheetName ?? ''
  for await (const batch of iterateRowBatches(xlsxPath, { sheetName, batchSize: Number.MAX_SAFE_INTEGER })) {
    resolvedSheetName = batch.sheetName
    rows.push(...batch.rows)
  }
  return { rows, sheetName: resolvedSheetName }
}

export async function* iterateRowBatches(
  xlsxPath: string,
  options: {
    sheetName?: string
    batchSize?: number
    requiredFields?: readonly HeaderField[]
  } = {},
): AsyncGenerator<{
  rows: RowRecord[]
  sheetName: string
  dataRowCount: number
  batchIndex: number
}> {
  const required = options.requiredFields ?? PROCESSING_REQUIRED_FIELDS
  const batchSize = Math.max(1, options.batchSize ?? FINANCE_CHECK_ROW_BATCH_SIZE)
  const selected = await inspectWorkbook(xlsxPath, options.sheetName, required)

  const reader = createWorkbookReader(xlsxPath)
  let batch: RowRecord[] = []
  let batchIndex = 0
  let yielded = false

  for await (const worksheet of reader) {
    const streamWorksheet = worksheet as StreamWorksheet
    if ((streamWorksheet.name || '') !== selected.sheetName) {
      for await (const _row of worksheet) {
        // drain other sheets without retaining rows
      }
      continue
    }

    let headerMap: Partial<Record<HeaderField, number>> | null = null
    for await (const row of worksheet) {
      if (row.number === 1) {
        const values = Array.isArray(row.values) ? [...row.values] : []
        headerMap = buildHeaderMapFromValues(values)
        continue
      }
      if (!headerMap) continue
      const parsed = parseStreamRow(row, headerMap)
      if (!parsed) continue
      batch.push(parsed)
      if (batch.length >= batchSize) {
        yielded = true
        yield {
          rows: batch,
          sheetName: selected.sheetName,
          dataRowCount: selected.dataRowCount,
          batchIndex,
        }
        batchIndex += 1
        batch = []
      }
    }
  }

  if (batch.length > 0 || !yielded) {
    yield {
      rows: batch,
      sheetName: selected.sheetName,
      dataRowCount: selected.dataRowCount,
      batchIndex,
    }
  }
}

export function normalizeHeaderForWriter(value: unknown): string {
  return normalizeHeader(value)
}
