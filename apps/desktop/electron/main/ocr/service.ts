import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'
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

let cachedKey: string | null = null
let cachedOcr: PaddleOcrService | null = null

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
  const ocr = await getOcrInstance(modelRoot, variant)

  const results = await ocr.recognize({
    width: image.width,
    height: image.height,
    data: image.data,
  })

  return ocr.processRecognition(results)
}
