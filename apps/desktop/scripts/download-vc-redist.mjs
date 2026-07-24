#!/usr/bin/env node
/**
 * 下载 Microsoft Visual C++ Redistributable (x64) 到 build/vc_redist.x64.exe
 * 供 NSIS 安装包在安装时静默安装，避免 onnxruntime-node ERR_DLOPEN_FAILED。
 *
 * 用法: node scripts/download-vc-redist.mjs
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', 'build', 'vc_redist.x64.exe')
const URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
const MIN_BYTES = 1_000_000

async function main() {
  if (existsSync(OUT) && statSync(OUT).size >= MIN_BYTES) {
    console.log(`[vc-redist] already present: ${OUT} (${statSync(OUT).size} bytes)`)
    return
  }

  mkdirSync(dirname(OUT), { recursive: true })
  console.log(`[vc-redist] downloading ${URL}`)
  const response = await fetch(URL, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`)
  }

  await pipeline(response.body, createWriteStream(OUT))
  const size = statSync(OUT).size
  if (size < MIN_BYTES) {
    throw new Error(`downloaded file too small (${size} bytes), expected VC++ redistributable`)
  }
  console.log(`[vc-redist] saved ${OUT} (${size} bytes)`)
}

main().catch((error) => {
  console.error('[vc-redist] failed:', error)
  process.exit(1)
})
