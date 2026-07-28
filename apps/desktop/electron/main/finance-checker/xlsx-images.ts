import { mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import type { Entry, ZipFile } from 'yauzl'
import {
  extractZipEntryToFile,
  openZipIndex,
  readZipEntries,
  type OpenZipIndex,
} from './zip-io'

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

export async function loadImageIdMap(xlsxPath: string): Promise<Map<string, string>> {
  const entries = await readZipEntries(xlsxPath, [
    'xl/cellimages.xml',
    'xl/_rels/cellimages.xml.rels',
  ])
  const cellImagesData = entries.get('xl/cellimages.xml')
  const relsData = entries.get('xl/_rels/cellimages.xml.rels')
  if (!cellImagesData || !relsData) return new Map()

  const parser = new DOMParser()
  const cellImagesDoc = parser.parseFromString(cellImagesData.toString('utf8'), 'application/xml')
  const relsDoc = parser.parseFromString(relsData.toString('utf8'), 'application/xml')
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

export class WorkbookImageExtractor {
  private readonly indexPromise: Promise<OpenZipIndex>
  private readonly extracted = new Map<string, Promise<string | null>>()
  private closed = false

  constructor(
    xlsxPath: string,
    private readonly outputDir: string,
  ) {
    this.indexPromise = openZipIndex(xlsxPath)
  }

  resolveImagePath(
    imageId: string | null | undefined,
    imageIdMap: Map<string, string>,
  ): Promise<string | null> {
    if (!imageId) return Promise.resolve(null)
    const mediaName = imageIdMap.get(imageId)
    if (!mediaName) return Promise.resolve(null)

    if (!this.extracted.has(mediaName)) {
      this.extracted.set(mediaName, this.extractMedia(mediaName))
    }
    return this.extracted.get(mediaName)!
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      const { zip } = await this.indexPromise
      zip.close()
    } catch {
      // ignore close errors after failed open
    }
  }

  private async extractMedia(mediaName: string): Promise<string | null> {
    const { zip, entries } = await this.indexPromise
    const entry = entries.get(`xl/media/${mediaName}`)
    if (!entry || /\/$/.test(entry.fileName)) return null

    await mkdir(this.outputDir, { recursive: true })
    const target = join(this.outputDir, mediaName)
    await extractZipEntryToFile(zip as ZipFile, entry as Entry, target)
    return target
  }
}
