import { copyFile, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import AdmZip from 'adm-zip'
import {
  DOMParser,
  XMLSerializer,
  type Document as XmlDocument,
  type Element as XmlElement,
} from '@xmldom/xmldom'
import { normalizeHeaderForWriter } from './excel-reader'
import {
  CheckStatusKey,
  overallStatus,
  type RowCheckResult,
  type WorkbookCheckResult,
} from './types'

export const AI_AUDIT_COLUMN = 'AI 审核结果'

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const REF_RE = /^([A-Z]+)(\d+)$/

const STATUS_LABELS: Record<string, string> = {
  [CheckStatusKey.FAIL]: '不通过',
  [CheckStatusKey.ERROR]: '不通过',
  [CheckStatusKey.SKIP]: '跳过',
}

function nodes<T extends Node>(list: NodeListOf<T> | HTMLCollectionOf<T>): T[] {
  return Array.from(list)
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

function colLetter(index: number): string {
  let letters = ''
  let current = index
  while (current > 0) {
    current -= 1
    letters = String.fromCharCode(65 + (current % 26)) + letters
    current = Math.floor(current / 26)
  }
  return letters
}

function colIndex(letters: string): number {
  let value = 0
  for (const ch of letters) {
    value = value * 26 + (ch.charCodeAt(0) - 64)
  }
  return value
}

function splitRef(ref: string): [string, number] {
  const match = REF_RE.exec(ref)
  if (!match) throw new Error(`无效单元格引用: ${ref}`)
  return [match[1]!, Number(match[2])]
}

function loadSharedStrings(data: Buffer | undefined): string[] {
  if (!data) return []
  const doc = new DOMParser().parseFromString(data.toString('utf8'), 'application/xml')
  const strings: string[] = []
  for (const item of nodes(doc.getElementsByTagNameNS(MAIN_NS, 'si'))) {
    const texts = nodes(item.getElementsByTagNameNS(MAIN_NS, 't')).map(
      (node) => node.textContent ?? '',
    )
    strings.push(texts.join(''))
  }
  return strings
}

function cellText(cell: XmlElement, sharedStrings: string[]): string | null {
  const cellType = cell.getAttribute('t')
  const valueNode = cell.getElementsByTagNameNS(MAIN_NS, 'v')[0]
  const inlineNode = cell.getElementsByTagNameNS(MAIN_NS, 't')[0]

  if (cellType === 's' && valueNode?.textContent != null) {
    const index = Number(valueNode.textContent)
    return sharedStrings[index] ?? null
  }
  if (cellType === 'inlineStr' && inlineNode) return inlineNode.textContent ?? ''
  if (valueNode?.textContent != null) return valueNode.textContent
  return null
}

function resolveSheetPath(entries: Map<string, Buffer>, sheetName?: string): string {
  const workbookDoc = new DOMParser().parseFromString(
    entries.get('xl/workbook.xml')!.toString('utf8'),
    'application/xml',
  )
  const relsDoc = new DOMParser().parseFromString(
    entries.get('xl/_rels/workbook.xml.rels')!.toString('utf8'),
    'application/xml',
  )

  const relMap = new Map<string, string>()
  for (const rel of nodes(relsDoc.getElementsByTagNameNS(PKG_REL_NS, 'Relationship'))) {
    const id = rel.getAttribute('Id')
    const target = rel.getAttribute('Target')
    if (id && target) relMap.set(id, target.replace(/^\//, ''))
  }

  const sheets = nodes(workbookDoc.getElementsByTagNameNS(MAIN_NS, 'sheet'))
  let sheet: XmlElement
  if (sheetName) {
    const found = sheets.find((item) => item.getAttribute('name') === sheetName)
    if (!found) throw new Error(`工作表不存在: ${sheetName}`)
    sheet = found
  } else {
    const bookView = workbookDoc.getElementsByTagNameNS(MAIN_NS, 'workbookView')[0]
    const activeIdx = bookView ? Number(bookView.getAttribute('activeTab') ?? 0) : 0
    sheet = sheets[activeIdx] ?? sheets[0]!
  }

  const relId = sheet.getAttributeNS(REL_NS, 'id')
  let target = relMap.get(relId ?? '') ?? ''
  if (!target.startsWith('xl/')) target = `xl/${target}`
  return target
}

function findRow(sheetData: XmlElement, rowNumber: number): XmlElement | null {
  for (const row of nodes(sheetData.getElementsByTagNameNS(MAIN_NS, 'row'))) {
    if (row.getAttribute('r') === String(rowNumber)) return row
  }
  return null
}

function getOrCreateRow(sheetData: XmlElement, rowNumber: number): XmlElement {
  const existing = findRow(sheetData, rowNumber)
  if (existing) return existing

  const row = sheetData.ownerDocument!.createElementNS(MAIN_NS, 'row')
  row.setAttribute('r', String(rowNumber))
  const rows = nodes(sheetData.getElementsByTagNameNS(MAIN_NS, 'row'))
  let insertAt = rows.length
  for (let index = 0; index < rows.length; index += 1) {
    if (Number(rows[index]!.getAttribute('r') ?? 0) > rowNumber) {
      insertAt = index
      break
    }
  }
  if (insertAt >= rows.length) sheetData.appendChild(row)
  else sheetData.insertBefore(row, rows[insertAt]!)
  return row
}

function headerMap(sheetData: XmlElement, sharedStrings: string[]): Map<string, string> {
  const row = findRow(sheetData, 1)
  const mapping = new Map<string, string>()
  if (!row) return mapping

  for (const cell of nodes(row.getElementsByTagNameNS(MAIN_NS, 'c'))) {
    const ref = cell.getAttribute('r')
    if (!ref) continue
    const header = normalizeHeaderForWriter(cellText(cell, sharedStrings))
    if (header) mapping.set(header, splitRef(ref)[0])
  }
  return mapping
}

function removeCell(row: XmlElement, ref: string): void {
  for (const cell of nodes(row.getElementsByTagNameNS(MAIN_NS, 'c'))) {
    if (cell.getAttribute('r') === ref) row.removeChild(cell)
  }
}

function makeInlineCell(ref: string, text: string, styleIndex: number | null): XmlElement {
  const doc = new DOMParser().parseFromString('<root/>', 'application/xml')
  const cell = doc.createElementNS(MAIN_NS, 'c')
  cell.setAttribute('r', ref)
  cell.setAttribute('t', 'inlineStr')
  if (styleIndex != null) cell.setAttribute('s', String(styleIndex))
  const inline = doc.createElementNS(MAIN_NS, 'is')
  const textNode = doc.createElementNS(MAIN_NS, 't')
  if (text && (/^\s/.test(text) || /\s$/.test(text))) {
    textNode.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve')
  }
  textNode.textContent = text
  inline.appendChild(textNode)
  cell.appendChild(inline)
  return cell
}

function setRowCell(row: XmlElement, colLetters: string, rowNumber: number, cell: XmlElement): void {
  const ref = `${colLetters}${rowNumber}`
  cell.setAttribute('r', ref)
  removeCell(row, ref)

  const cells = nodes(row.getElementsByTagNameNS(MAIN_NS, 'c'))
  let insertAt = cells.length
  const targetIndex = colIndex(colLetters)
  for (let index = 0; index < cells.length; index += 1) {
    const existingRef = cells[index]!.getAttribute('r')
    if (existingRef && colIndex(splitRef(existingRef)[0]) > targetIndex) {
      insertAt = index
      break
    }
  }
  if (insertAt >= cells.length) row.appendChild(cell)
  else row.insertBefore(cell, cells[insertAt]!)
}

function findFontId(stylesRoot: XmlElement, rgbValues: string[]): number | null {
  const fonts = stylesRoot.getElementsByTagNameNS(MAIN_NS, 'fonts')[0]
  if (!fonts) return null
  const fontNodes = nodes(fonts.getElementsByTagNameNS(MAIN_NS, 'font'))
  for (let index = 0; index < fontNodes.length; index += 1) {
    const font = fontNodes[index]!
    const color = font.getElementsByTagNameNS(MAIN_NS, 'color')[0]
    if (!color) continue
    const rgb = (color.getAttribute('rgb') ?? '').toUpperCase()
    if (rgbValues.includes(rgb)) return index
  }
  return null
}

function appendFont(stylesRoot: XmlElement, rgb: string): number {
  const fonts = stylesRoot.getElementsByTagNameNS(MAIN_NS, 'fonts')[0]!
  const doc = stylesRoot.ownerDocument!
  const font = doc.createElementNS(MAIN_NS, 'font')
  font.appendChild(createAttrElement(doc, 'sz', '11'))
  font.appendChild(createAttrElement(doc, 'color', undefined, { rgb }))
  font.appendChild(createAttrElement(doc, 'name', '宋体', { val: '宋体' }))
  font.appendChild(createAttrElement(doc, 'charset', '0'))
  font.appendChild(createAttrElement(doc, 'scheme', 'minor'))
  fonts.appendChild(font)
  fonts.setAttribute('count', String(fonts.getElementsByTagNameNS(MAIN_NS, 'font').length))
  return fonts.getElementsByTagNameNS(MAIN_NS, 'font').length - 1
}

function createAttrElement(
  doc: XmlDocument,
  name: string,
  value?: string,
  attrs: Record<string, string> = {},
): XmlElement {
  const element = doc.createElementNS(MAIN_NS, name)
  if (value != null) element.setAttribute('val', value)
  for (const [key, attrValue] of Object.entries(attrs)) {
    element.setAttribute(key, attrValue)
  }
  return element
}

function appendCellXf(stylesRoot: XmlElement, fontId: number): number {
  const cellXfs = stylesRoot.getElementsByTagNameNS(MAIN_NS, 'cellXfs')[0]!
  const doc = stylesRoot.ownerDocument!
  const xf = doc.createElementNS(MAIN_NS, 'xf')
  xf.setAttribute('numFmtId', '0')
  xf.setAttribute('fontId', String(fontId))
  xf.setAttribute('fillId', '0')
  xf.setAttribute('borderId', '0')
  xf.setAttribute('xfId', '0')
  xf.setAttribute('applyFont', '1')
  cellXfs.appendChild(xf)
  cellXfs.setAttribute('count', String(cellXfs.getElementsByTagNameNS(MAIN_NS, 'xf').length))
  return cellXfs.getElementsByTagNameNS(MAIN_NS, 'xf').length - 1
}

function ensureAuditStyles(stylesRoot: XmlElement): [number, number] {
  let greenFontId = findFontId(stylesRoot, ['FF008000', 'FF006100'])
  let redFontId = findFontId(stylesRoot, ['FFFF0000', 'FF9C0006'])
  if (greenFontId == null) greenFontId = appendFont(stylesRoot, 'FF008000')
  if (redFontId == null) redFontId = appendFont(stylesRoot, 'FFFF0000')
  return [appendCellXf(stylesRoot, greenFontId), appendCellXf(stylesRoot, redFontId)]
}

function styleForStatus(status: string, passStyle: number, failStyle: number): number | null {
  if (status === CheckStatusKey.PASS) return passStyle
  if (status === CheckStatusKey.FAIL || status === CheckStatusKey.ERROR) return failStyle
  return null
}

function serializeXml(doc: XmlDocument | XmlElement): Buffer {
  const xml = new XMLSerializer().serializeToString(doc)
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${xml}`, 'utf8')
}

function patchWorkbookEntries(
  entries: Map<string, Buffer>,
  result: WorkbookCheckResult,
  sheetName?: string,
): void {
  const sheetPath = resolveSheetPath(entries, sheetName)
  const sharedStrings = loadSharedStrings(entries.get('xl/sharedStrings.xml'))

  const stylesDoc = new DOMParser().parseFromString(
    entries.get('xl/styles.xml')!.toString('utf8'),
    'application/xml',
  )
  const stylesRoot = stylesDoc.documentElement
  if (!stylesRoot) throw new Error('styles.xml 缺少根节点')
  const [passStyle, failStyle] = ensureAuditStyles(stylesRoot)
  entries.set('xl/styles.xml', serializeXml(stylesDoc))

  const sheetDoc = new DOMParser().parseFromString(
    entries.get(sheetPath)!.toString('utf8'),
    'application/xml',
  )
  const sheetData = sheetDoc.getElementsByTagNameNS(MAIN_NS, 'sheetData')[0]
  if (!sheetData) throw new Error('表格缺少 sheetData')

  const headers = headerMap(sheetData, sharedStrings)
  let auditCol = headers.get(AI_AUDIT_COLUMN)
  if (!auditCol) {
    const maxCol = Math.max(...Array.from(headers.values()).map(colIndex))
    auditCol = colLetter(maxCol + 1)
    const headerRow = getOrCreateRow(sheetData, 1)
    setRowCell(headerRow, auditCol, 1, makeInlineCell(`${auditCol}1`, AI_AUDIT_COLUMN, null))
  }

  for (const row of nodes(sheetData.getElementsByTagNameNS(MAIN_NS, 'row'))) {
    const rowNumber = Number(row.getAttribute('r') ?? 0)
    if (rowNumber >= 2) removeCell(row, `${auditCol}${rowNumber}`)
  }

  for (const rowResult of result.rows) {
    const rowNumber = rowResult.row.rowNumber
    const dataRow = getOrCreateRow(sheetData, rowNumber)
    setRowCell(
      dataRow,
      auditCol,
      rowNumber,
      makeInlineCell(
        `${auditCol}${rowNumber}`,
        renderAuditCell(rowResult),
        styleForStatus(overallStatus(rowResult), passStyle, failStyle),
      ),
    )
  }

  entries.set(sheetPath, serializeXml(sheetDoc))
}

export async function writeAuditWorkbook(
  sourcePath: string,
  result: WorkbookCheckResult,
  outputPath: string,
  sheetName?: string,
): Promise<string> {
  await mkdir(dirname(outputPath), { recursive: true })
  await copyFile(sourcePath, outputPath)

  const zip = new AdmZip(outputPath)
  const entries = new Map<string, Buffer>()
  const itemNames: string[] = []
  for (const entry of zip.getEntries()) {
    itemNames.push(entry.entryName)
    entries.set(entry.entryName, entry.getData())
  }

  patchWorkbookEntries(entries, result, sheetName)

  const outputZip = new AdmZip()
  for (const name of itemNames) {
    outputZip.addFile(name, entries.get(name)!)
  }
  outputZip.writeZip(outputPath)
  return outputPath
}
