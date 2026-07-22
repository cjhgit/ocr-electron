import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import AdmZip from 'adm-zip'
import { DOMParser } from '@xmldom/xmldom'

const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const ETC_NS = 'http://www.wps.cn/officeDocument/2017/etCustomData'
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const MAIN_DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const DISPIMG_RE = /DISPIMG\("([^"]+)"/i

export function extractDispimgId(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return DISPIMG_RE.exec(value)?.[1] ?? null
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['formula', 'result', 'text']) {
      const nested = extractDispimgId(record[key])
      if (nested) return nested
    }
  }
  return null
}

export function loadImageIdMap(xlsxPath: string): Map<string, string> {
  const zip = new AdmZip(xlsxPath)
  const cellImagesEntry = zip.getEntry('xl/cellimages.xml')
  if (!cellImagesEntry) return new Map()
  const relsEntry = zip.getEntry('xl/_rels/cellimages.xml.rels')
  if (!relsEntry) return new Map()

  const parser = new DOMParser()
  const cellImagesDoc = parser.parseFromString(cellImagesEntry.getData().toString('utf8'), 'application/xml')
  const relsDoc = parser.parseFromString(relsEntry.getData().toString('utf8'), 'application/xml')
  const relMap = new Map<string, string>()

  for (const rel of Array.from(relsDoc.getElementsByTagNameNS(PKG_REL_NS, 'Relationship'))) {
    const id = rel.getAttribute('Id')
    const target = rel.getAttribute('Target')
    if (id && target) relMap.set(id, basename(target))
  }

  const imageMap = new Map<string, string>()
  for (const cellImage of Array.from(cellImagesDoc.getElementsByTagNameNS(ETC_NS, 'cellImage'))) {
    const nameNode = cellImage.getElementsByTagNameNS(DRAWING_NS, 'cNvPr')[0]
    const blip = cellImage.getElementsByTagNameNS(MAIN_DRAWING_NS, 'blip')[0]
    if (!nameNode || !blip) continue
    const imageId = nameNode.getAttribute('name')
    const relId = blip.getAttributeNS(REL_NS, 'embed')
    if (imageId && relId && relMap.has(relId)) imageMap.set(imageId, relMap.get(relId)!)
  }

  return imageMap
}

export async function extractImages(xlsxPath: string, outputDir: string): Promise<Map<string, string>> {
  await mkdir(outputDir, { recursive: true })
  const extracted = new Map<string, string>()
  const zip = new AdmZip(xlsxPath)
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.startsWith('xl/media/') || entry.entryName.endsWith('/')) continue
    const filename = basename(entry.entryName)
    const target = join(outputDir, filename)
    await writeFile(target, entry.getData())
    extracted.set(filename, target)
  }
  return extracted
}

export function resolveImagePath(
  imageId: string | null | undefined,
  imageIdMap: Map<string, string>,
  extractedImages: Map<string, string>,
): string | null {
  if (!imageId) return null
  const mediaName = imageIdMap.get(imageId)
  if (!mediaName) return null
  return extractedImages.get(mediaName) ?? null
}
