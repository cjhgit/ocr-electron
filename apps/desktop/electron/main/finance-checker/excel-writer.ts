import { mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import {
  CheckStatusKey,
  overallStatus,
  type RowCheckResult,
  type WorkbookCheckResult,
} from './types'
import { normalizeHeaderForWriter } from './excel-reader'

export const AI_AUDIT_COLUMN = 'AI 审核结果'

const STATUS_LABELS: Record<string, string> = {
  [CheckStatusKey.FAIL]: '不通过',
  [CheckStatusKey.ERROR]: '异常',
  [CheckStatusKey.SKIP]: '跳过',
}

function formatTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('') +
    '-' +
    [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('')
  )
}

export function auditOutputFilename(sourcePath: string, timestamp = new Date()): string {
  const source = basename(sourcePath)
  const dot = source.lastIndexOf('.')
  const stem = dot >= 0 ? source.slice(0, dot) : source
  const suffix = dot >= 0 ? source.slice(dot) : '.xlsx'
  return `${stem}-审核结果-${formatTimestamp(timestamp)}${suffix}`
}

export function defaultAuditOutputPath(sourcePath: string, timestamp = new Date()): string {
  return join(tmpdir(), auditOutputFilename(sourcePath, timestamp))
}

export function renderAuditCell(rowResult: RowCheckResult): string {
  const status = overallStatus(rowResult)
  if (status === CheckStatusKey.PASS) return '通过'
  const parts: string[] = []
  for (const check of [rowResult.paymentCheck, rowResult.merchantCheck]) {
    if (check) parts.push(formatCheckReason(check))
  }
  const reason = parts.length > 0 ? parts.join('；') : '无校验项'
  return `${STATUS_LABELS[status] ?? status}：${reason}`
}

function formatCheckReason(check: NonNullable<RowCheckResult['paymentCheck']>): string {
  if (check.status === CheckStatusKey.FAIL || check.status === CheckStatusKey.ERROR) {
    const expected = check.expected ?? '-'
    const actual = check.actual ?? '-'
    return `${check.fieldName}：${check.message} (表格=${expected}, 截图=${actual})`
  }
  return `${check.fieldName}：${check.message}`
}

function findAuditColumn(worksheet: ExcelJS.Worksheet): number {
  const headerRow = worksheet.getRow(1)
  let auditCol = 0
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (normalizeHeaderForWriter(cell.value) === AI_AUDIT_COLUMN) auditCol = colNumber
  })
  if (auditCol > 0) return auditCol
  const nextCol = Math.max(1, worksheet.columnCount + 1)
  headerRow.getCell(nextCol).value = AI_AUDIT_COLUMN
  headerRow.commit()
  return nextCol
}

export async function writeAuditWorkbook(
  sourcePath: string,
  result: WorkbookCheckResult,
  outputPath: string,
  sheetName?: string,
): Promise<string> {
  await mkdir(dirname(outputPath), { recursive: true })
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(sourcePath)
  const worksheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0]
  if (!worksheet) throw new Error(sheetName ? `工作表不存在: ${sheetName}` : '表格中没有工作表')
  const auditCol = findAuditColumn(worksheet)

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    worksheet.getRow(rowNumber).getCell(auditCol).value = null
  }

  for (const rowResult of result.rows) {
    const cell = worksheet.getRow(rowResult.row.rowNumber).getCell(auditCol)
    cell.value = renderAuditCell(rowResult)
    const status = overallStatus(rowResult)
    if (status === CheckStatusKey.PASS) {
      cell.font = { ...(cell.font ?? {}), color: { argb: 'FF008000' } }
    } else if (status === CheckStatusKey.FAIL || status === CheckStatusKey.ERROR) {
      cell.font = { ...(cell.font ?? {}), color: { argb: 'FFFF0000' } }
    }
  }

  await workbook.xlsx.writeFile(outputPath)
  return outputPath
}
