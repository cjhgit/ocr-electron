import { createWriteStream } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import { ZipFile as YazlZipFile } from 'yazl'

export type OpenZipIndex = {
  zip: ZipFile
  entries: Map<string, Entry>
}

function openZipFile(filePath: string, lazyEntries: boolean): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries, autoClose: false }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error(`无法打开 zip: ${filePath}`))
        return
      }
      resolve(zipFile)
    })
  })
}

export async function openZipIndex(filePath: string): Promise<OpenZipIndex> {
  const zip = await openZipFile(filePath, false)
  const entries = new Map<string, Entry>()
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject)
    zip.on('entry', (entry: Entry) => {
      entries.set(entry.fileName, entry)
    })
    zip.on('end', () => resolve())
  })
  return { zip, entries }
}

function readEntryBuffer(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, readStream) => {
      if (error || !readStream) {
        reject(error ?? new Error(`无法读取 zip 条目: ${entry.fileName}`))
        return
      }
      const chunks: Buffer[] = []
      readStream.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
      readStream.on('error', reject)
      readStream.on('end', () => {
        resolve(Buffer.concat(chunks))
      })
    })
  })
}

export async function readZipEntries(
  filePath: string,
  entryNames: Iterable<string>,
): Promise<Map<string, Buffer>> {
  const wanted = new Set([...entryNames].filter(Boolean))
  const result = new Map<string, Buffer>()
  if (wanted.size === 0) return result

  const { zip, entries } = await openZipIndex(filePath)
  try {
    for (const name of wanted) {
      const entry = entries.get(name)
      if (!entry || /\/$/.test(entry.fileName)) continue
      result.set(name, await readEntryBuffer(zip, entry))
    }
  } finally {
    zip.close()
  }
  return result
}

export async function readZipEntry(filePath: string, entryName: string): Promise<Buffer | null> {
  const entries = await readZipEntries(filePath, [entryName])
  return entries.get(entryName) ?? null
}

export async function extractZipEntryToFile(
  zip: ZipFile,
  entry: Entry,
  destination: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    zip.openReadStream(entry, (error, readStream) => {
      if (error || !readStream) {
        reject(error ?? new Error(`无法读取 zip 条目: ${entry.fileName}`))
        return
      }
      const writeStream = createWriteStream(destination)
      readStream.on('error', reject)
      writeStream.on('error', reject)
      writeStream.on('finish', () => resolve())
      readStream.pipe(writeStream)
    })
  })
}

export async function rewriteZipWithPatches(
  sourcePath: string,
  outputPath: string,
  patches: Map<string, Buffer>,
): Promise<void> {
  const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`
  const { zip, entries } = await openZipIndex(sourcePath)
  const out = new YazlZipFile()
  const outputStream = createWriteStream(tempPath)
  const finished = pipeline(out.outputStream, outputStream)

  try {
    for (const entry of entries.values()) {
      if (/\/$/.test(entry.fileName)) {
        out.addEmptyDirectory(entry.fileName.replace(/\/$/, ''))
        continue
      }

      const patched = patches.get(entry.fileName)
      if (patched) {
        out.addBuffer(patched, entry.fileName)
        continue
      }

      await new Promise<void>((resolve, reject) => {
        zip.openReadStream(entry, (error, readStream) => {
          if (error || !readStream) {
            reject(error ?? new Error(`无法读取 zip 条目: ${entry.fileName}`))
            return
          }
          out.addReadStream(readStream, entry.fileName, {
            compress: entry.compressionMethod !== 0,
            size: entry.uncompressedSize,
          })
          readStream.on('error', reject)
          readStream.on('end', () => resolve())
        })
      })
    }
    out.end()
    await finished
  } catch (error) {
    zip.close()
    await unlink(tempPath).catch(() => undefined)
    throw error
  }

  zip.close()
  await rename(tempPath, outputPath)
}
