import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'
import { decode as decodeJpeg } from 'jpeg-js'
import { decode as decodePng } from 'fast-png'
import { getModelPreset, PaddleOcrService } from 'paddleocr'
import { getModelAsset, type OcrModelVariant } from './config'

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer
}

export type OcrImageInput = {
  width: number
  height: number
  data: Uint8Array
}

export type OcrRecognizeOptions = {
  modelRoot: string
  variant: OcrModelVariant
  image: OcrImageInput
}

export type OcrRuntimeOptions = {
  modelRoot: string
  variant: OcrModelVariant
}

let cachedKey: string | null = null
let cachedOcr: PaddleOcrService | null = null
let defaultRuntime: OcrRuntimeOptions | null = null

export function setDefaultOcrRuntime(options: OcrRuntimeOptions) {
  defaultRuntime = options
}

async function getOcrInstance(modelRoot: string, variant: OcrModelVariant) {
  const key = `${modelRoot}:${variant}`
  if (cachedKey === key && cachedOcr) {
    return cachedOcr
  }

  const asset = getModelAsset(variant)
  const modelDir = join(modelRoot, asset.dir)

  const [detModel, recModel, dictText] = await Promise.all([
    readFile(join(modelDir, asset.det)),
    readFile(join(modelDir, asset.rec)),
    readFile(join(modelDir, asset.dict), 'utf-8'),
  ])

  const preset = getModelPreset(asset.preset)
  const dictionary = dictText.trimEnd().split(/\r?\n/)
  const charactersDictionary = preset.dictionary.useSpaceChar
    ? [...dictionary, ' ']
    : dictionary

  cachedOcr = await PaddleOcrService.createInstance({
    // onnxruntime-node 与 paddleocr 的类型定义不完全一致
    ort: ort as never,
    modelPreset: asset.preset,
    detection: {
      modelBuffer: toArrayBuffer(detModel),
    },
    recognition: {
      modelBuffer: toArrayBuffer(recModel),
      charactersDictionary,
    },
  })
  cachedKey = key

  return cachedOcr
}

export async function recognizeText(options: OcrRecognizeOptions) {
  const { modelRoot, variant, image } = options
  setDefaultOcrRuntime({ modelRoot, variant })
  const ocr = await getOcrInstance(modelRoot, variant)

  const results = await ocr.recognize({
    width: image.width,
    height: image.height,
    data: image.data,
  })

  return ocr.processRecognition(results)
}

function toRgba(data: Uint8Array, channels: number): Uint8Array {
  if (channels === 4) return data
  const rgba = new Uint8Array((data.length / channels) * 4)
  for (let source = 0, target = 0; source < data.length; source += channels, target += 4) {
    rgba[target] = data[source] ?? 0
    rgba[target + 1] = data[source + 1] ?? 0
    rgba[target + 2] = data[source + 2] ?? 0
    rgba[target + 3] = channels === 2 ? data[source + 1] ?? 255 : 255
  }
  return rgba
}

async function loadImageFromPath(imagePath: string): Promise<OcrImageInput> {
  const buffer = await readFile(imagePath)
  const lower = imagePath.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    const decoded = decodeJpeg(buffer, { useTArray: true })
    return {
      width: decoded.width,
      height: decoded.height,
      data: new Uint8Array(decoded.data),
    }
  }

  const decoded = decodePng(buffer)
  return {
    width: decoded.width,
    height: decoded.height,
    data: toRgba(new Uint8Array(decoded.data), decoded.channels),
  }
}

export async function recognizeImageFromPath(imagePath: string) {
  if (!defaultRuntime) {
    throw new Error('请先在“设置”中完成一次 OCR 识别，或配置模型后再执行对账')
  }
  const image = await loadImageFromPath(imagePath)
  return recognizeText({
    modelRoot: defaultRuntime.modelRoot,
    variant: defaultRuntime.variant,
    image,
  })
}
