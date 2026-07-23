import ExcelJS from 'exceljs'
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

function normalizeHeader(value: unknown): string {
  if (value == null) return ''
  return String(value)
    .trim()
    .replace(/\u52b5/g, '\u5238') // 劵 → 券
    .replace(/\s+/g, '')
}

function buildHeaderMap(headers: unknown[]): Partial<Record<HeaderField, number>> {
  const normalized = new Map<string, number>()
  headers.forEach((header, index) => {
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
  const text = String(value).trim()
  return text || null
}

function parseAmount(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number') return value
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
  }
  return false
}

function extractCellDispimgId(cell: ExcelJS.Cell): string | null {
  const fromFormula = extractDispimgId(cell.formula)
  if (fromFormula) return fromFormula
  const fromValue = extractDispimgId(cell.value)
  if (fromValue) return fromValue
  return extractDispimgId(cell.text)
}

async function readWorkbook(source: { path: string } | { buffer: Buffer | Uint8Array }): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  if ('path' in source) {
    await workbook.xlsx.readFile(source.path)
  } else {
    await workbook.xlsx.load(source.buffer as Buffer)
  }
  return workbook
}

function readWorksheetHeaders(worksheet: ExcelJS.Worksheet): unknown[] {
  const headers: unknown[] = []
  const headerRow = worksheet.getRow(1)
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = cell.value
  })
  return headers
}

function countMatchedRequiredFields(
  headerMap: Partial<Record<HeaderField, number>>,
  required: readonly HeaderField[],
): number {
  return required.filter((field) => headerMap[field] != null).length
}

function selectWorksheet(
  workbook: ExcelJS.Workbook,
  sheetName: string | undefined,
  required: readonly HeaderField[],
): ExcelJS.Worksheet {
  if (sheetName) {
    const worksheet = workbook.getWorksheet(sheetName)
    if (!worksheet) throw new Error(`工作表不存在: ${sheetName}`)
    return worksheet
  }

  if (workbook.worksheets.length === 0) throw new Error('表格中没有工作表')

  let bestWorksheet = workbook.worksheets[0]!
  let bestMatchCount = -1
  for (const worksheet of workbook.worksheets) {
    const headerMap = buildHeaderMap(readWorksheetHeaders(worksheet))
    const matchCount = countMatchedRequiredFields(headerMap, required)
    if (matchCount === required.length) return worksheet
    if (matchCount > bestMatchCount) {
      bestMatchCount = matchCount
      bestWorksheet = worksheet
    }
  }
  return bestWorksheet
}

function parseWorksheetRows(worksheet: ExcelJS.Worksheet) {
  const headers = readWorksheetHeaders(worksheet)
  const headerMap = buildHeaderMap(headers)
  const rows: RowRecord[] = []

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber)
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
    if (Object.values(values).every((value) => value == null)) continue
    rows.push({
      rowNumber,
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
    })
  }

  return { headerMap, rows }
}

function assertRequiredHeaders(headerMap: Partial<Record<HeaderField, number>>, required: readonly HeaderField[]): void {
  const missing = required.filter((field) => headerMap[field] == null)
  if (missing.length > 0) {
    throw new Error(`表格缺少必要列：${missing.map((field) => HEADER_FIELD_LABELS[field]).join('、')}`)
  }
}

export async function validateFinanceCheckUpload(buffer: Buffer, sheetName?: string): Promise<void> {
  const workbook = await readWorkbook({ buffer })
  const worksheet = selectWorksheet(workbook, sheetName, FINANCE_CHECK_UPLOAD_REQUIRED_FIELDS)
  const { headerMap, rows } = parseWorksheetRows(worksheet)
  assertRequiredHeaders(headerMap, FINANCE_CHECK_UPLOAD_REQUIRED_FIELDS)
  const dataRows = rows.filter((row) => !row.isSummaryRow)
  if (dataRows.length === 0) throw new Error('表格中没有可对账的数据行')
}

export async function loadRows(
  xlsxPath: string,
  sheetName?: string,
): Promise<{ rows: RowRecord[]; sheetName: string }> {
  const workbook = await readWorkbook({ path: xlsxPath })
  const worksheet = selectWorksheet(workbook, sheetName, PROCESSING_REQUIRED_FIELDS)
  const { headerMap, rows } = parseWorksheetRows(worksheet)
  assertRequiredHeaders(headerMap, PROCESSING_REQUIRED_FIELDS)
  return { rows, sheetName: worksheet.name }
}

export function normalizeHeaderForWriter(value: unknown): string {
  return normalizeHeader(value)
}
