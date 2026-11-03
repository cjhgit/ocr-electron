#!/usr/bin/env node
// 从对账表格中提取指定行（含图片）生成小文件，用于只重跑问题行，避免全量耗时。
//
// 用法:
//   node scripts/extract-rows.mjs --task <taskId> [输出.xlsx]        # 从任务结果提取失败行
//   node scripts/extract-rows.mjs <源.xlsx> <输出.xlsx> <行号,...>   # 手动指定行号
//
// 行号保持与源文件一致，DISPIMG 图片按引用裁剪，跨行共享公式已归一化。

import { createRequire } from 'module'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const yauzl = require('yauzl')
const yazl = require('yazl')

const API_BASE = process.env.FINANCE_API_BASE ?? 'http://localhost:47821'

function parseArgs(argv) {
  const args = { task: null, source: null, out: null, rows: [] }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--task') {
      args.task = argv[i + 1]
      i += 1
      if (argv[i + 1] && !argv[i + 1].endsWith('.xlsx')) args.out = argv[++i]
    } else if (argv[i]?.endsWith('.xlsx')) {
      if (!args.source) args.source = argv[i]
      else args.out = argv[i]
    } else if (argv[i]) {
      args.rows = argv[i].split(',').map((n) => Number(n.trim())).filter(Number.isInteger)
    }
  }
  return args
}

async function fetchFailedRows(taskId) {
  const task = (await (await fetch(`${API_BASE}/api/finance-check/tasks/${taskId}`)).json()).data
  if (!task) throw new Error(`任务不存在: ${taskId}`)
  if (task.taskStatus !== 'succeeded') throw new Error(`任务未完成: ${task.taskStatus}`)
  const items = (await (await fetch(`${API_BASE}/api/finance-check/tasks/${taskId}/items?page=1&pageSize=10000`)).json()).data
  const rows = items
    .filter((it) => it.paymentCheckStatus !== 'pass' || it.merchantCheckStatus !== 'pass')
    .map((it) => it.rowNumber)
  return { source: task.sourcePath, rows }
}

function readZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: false }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('open failed'))
      const entries = new Map()
      let ended = false
      let pending = 0
      const maybeResolve = () => {
        if (ended && pending === 0) resolve(entries)
      }
      zip.on('error', reject)
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) return
        pending += 1
        zip.openReadStream(entry, (e, rs) => {
          if (e || !rs) {
            pending -= 1
            return reject(e)
          }
          const chunks = []
          rs.on('data', (c) => chunks.push(c))
          rs.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks))
            pending -= 1
            maybeResolve()
          })
          rs.on('error', reject)
        })
      })
      zip.on('end', () => {
        ended = true
        maybeResolve()
      })
    })
  })
}

function normalizeSharedFormulas(xml) {
  return xml
    .replace(/<f t="shared"[^>]*\/>/g, '')
    .replace(/<f t="shared"[^>]*>([\s\S]*?)<\/f>/g, '<f>$1</f>')
}

async function extractRows(source, out, rowNumbers) {
  const wanted = new Set(rowNumbers)
  const entries = await readZip(source)

  const sheetXml = entries.get('xl/worksheets/sheet1.xml').toString('utf8')
  const sheetDataStart = sheetXml.indexOf('<sheetData>')
  const sheetDataEnd = sheetXml.indexOf('</sheetData>')
  const prefix = sheetXml.slice(0, sheetDataStart)
  const suffix = sheetXml.slice(sheetDataEnd + '</sheetData>'.length)
  const rows = [...sheetXml.slice(sheetDataStart + '<sheetData>'.length, sheetDataEnd).matchAll(/<row .*?<\/row>/g)].map((m) => m[0])
  const rowNumber = (rowXml) => Number(/r="(\d+)"/.exec(rowXml)[1])

  // 纵向合并单元格的续行需要锚点行（DISPIMG 只在合并区左上角），自动补齐
  const mergeAnchorByRow = new Map()
  for (const ref of sheetXml.matchAll(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/g)) {
    const [, startCol, startRow, endCol, endRow] = ref
    if (startCol !== endCol) continue
    for (let rn = Number(startRow) + 1; rn <= Number(endRow); rn += 1) mergeAnchorByRow.set(rn, Number(startRow))
  }
  const expandWanted = (set) => {
    let changed = false
    for (const rn of [...set]) {
      const anchor = mergeAnchorByRow.get(rn)
      if (anchor != null && !set.has(anchor)) {
        set.add(anchor)
        changed = true
      }
    }
    return changed
  }
  while (expandWanted(wanted)) { /* 传递闭包：合并的合并 */ }

  const kept = rows.filter((r) => rowNumber(r) === 1 || wanted.has(rowNumber(r)))
  const missingRows = rowNumbers.filter((rn) => !kept.some((r) => rowNumber(r) === rn))
  if (missingRows.length > 0) {
    throw new Error(`以下行在源文件中不存在: ${missingRows.join(',')}`)
  }
  const lastRow = Math.max(...kept.map(rowNumber))
  const keptRowsXml = normalizeSharedFormulas(kept.join(''))
  const usedIds = new Set([...keptRowsXml.matchAll(/DISPIMG\(&quot;(ID_[0-9A-F]+)&quot;/g)].map((m) => m[1]))

  const cellImagesXml = entries.get('xl/cellimages.xml').toString('utf8')
  const cellImageBlocks = cellImagesXml.match(/<etc:cellImage>[\s\S]*?<\/etc:cellImage>/g) ?? []
  const blockById = new Map()
  for (const block of cellImageBlocks) {
    const name = /name="(ID_[0-9A-F]+)"/.exec(block)?.[1]
    if (name) blockById.set(name, block)
  }
  const relsXml = entries.get('xl/_rels/cellimages.xml.rels').toString('utf8')
  const relEntries = relsXml.match(/<Relationship [^>]*\/>/g) ?? []
  const relByRid = new Map(relEntries.map((rel) => [/Id="([^"]+)"/.exec(rel)[1], rel]))
  const mediaByRid = new Map(relEntries.map((rel) => [/Id="([^"]+)"/.exec(rel)[1], /media\/([^"]+)"/.exec(rel)?.[1]]).filter(([, media]) => media))

  const usedRids = new Set()
  const keptBlocks = []
  for (const id of usedIds) {
    const block = blockById.get(id)
    if (!block) throw new Error(`cellimages 缺少 ${id}`)
    const rid = /r:embed="(rId\d+)"/.exec(block)?.[1]
    if (!rid || !mediaByRid.has(rid)) throw new Error(`rels 缺少 ${id} 的 ${rid}`)
    keptBlocks.push(block)
    usedRids.add(rid)
  }

  const patchedSheet = `${prefix.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:L${lastRow}"/>`)}<sheetData>${keptRowsXml}</sheetData>${suffix}`
  const patchedCellImages = `${cellImagesXml.slice(0, cellImagesXml.indexOf('<etc:cellImage>'))}${keptBlocks.join('')}${cellImagesXml.slice(cellImagesXml.lastIndexOf('</etc:cellImage>') + '</etc:cellImage>'.length)}`
  const patchedRels = relsXml.replace(/(<Relationships[^>]*>)[\s\S]*(<\/Relationships>)/, `$1${[...usedRids].map((rid) => relByRid.get(rid)).join('')}$2`)

  const out2 = new yazl.ZipFile()
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'docProps/app.xml', 'docProps/core.xml', 'docProps/custom.xml',
    'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml', 'xl/styles.xml', 'xl/theme/theme1.xml']) {
    if (entries.has(name)) out2.addBuffer(entries.get(name), name, { compress: true })
  }
  for (const name of entries.keys()) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name) && name !== 'xl/worksheets/sheet1.xml') {
      out2.addBuffer(entries.get(name), name, { compress: true })
    }
  }
  out2.addBuffer(Buffer.from(patchedSheet, 'utf8'), 'xl/worksheets/sheet1.xml', { compress: true })
  out2.addBuffer(Buffer.from(patchedCellImages, 'utf8'), 'xl/cellimages.xml', { compress: true })
  out2.addBuffer(Buffer.from(patchedRels, 'utf8'), 'xl/_rels/cellimages.xml.rels', { compress: true })
  for (const rid of usedRids) {
    const mediaName = `xl/media/${mediaByRid.get(rid)}`
    const buf = entries.get(mediaName)
    if (!buf) throw new Error(`缺少媒体 ${mediaName}`)
    out2.addBuffer(buf, mediaName, { compress: true })
  }

  await new Promise((resolve, reject) => {
    out2.outputStream.pipe(fs.createWriteStream(out)).on('finish', resolve).on('error', reject)
    out2.end()
  })
  console.log(`已生成 ${out}: 行 ${kept.map(rowNumber).filter((n) => n > 1).sort((a, b) => a - b).join(',')}，图片 ${usedRids.size} 张，${(fs.statSync(out).size / 1024 / 1024).toFixed(1)}MB`)
}

const args = parseArgs(process.argv.slice(2))
if (args.task) {
  const { source, rows } = await fetchFailedRows(args.task)
  if (rows.length === 0) {
    console.log('该任务没有失败行，无需提取')
    process.exit(0)
  }
  console.log(`任务失败行: ${rows.join(',')}`)
  const out = args.out ?? path.join(path.dirname(source), `${path.basename(source, '.xlsx')}-失败行.xlsx`)
  await extractRows(source, out, rows)
} else if (args.source && args.rows.length > 0) {
  await extractRows(args.source, args.out ?? args.source.replace('.xlsx', '-提取.xlsx'), args.rows)
} else {
  console.log('用法: node scripts/extract-rows.mjs --task <taskId> [输出.xlsx] | node scripts/extract-rows.mjs <源.xlsx> <输出.xlsx> <行号,...>')
  process.exit(1)
}
