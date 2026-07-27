import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'
import { decode as decodeJpeg } from 'jpeg-js'
import { decode as decodePng } from 'fast-png'
import { getModelPreset, PaddleOcrService } from 'paddleocr'
import { getModelAsset, type OcrModelVariant } from './config'

/**
 * PP-OCRv6_* presets use detection.limitType="min": when the short side is already
 * >= 736, the detector barely downscales. A 3024x4032 image becomes ~3008x4000
 * (~138MB float32 tensor) and can SIGTRAP onnxruntime-node.
 *
 * Keep long-side inputs bounded, and force detection resize to "max".
 */
const OCR_INPUT_MAX_LONG_SIDE = 1920
const OCR_DETECTION_MAX_SIDE_LENGTH = 960
const OCR_DETECTION_MAX_SIDE_LIMIT = 1920

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

function downscaleImageIfNeeded(image: OcrImageInput, maxLongSide = OCR_INPUT_MAX_LONG_SIDE): OcrImageInput {
  const longSide = Math.max(image.width, image.height)
  if (longSide <= maxLongSide) {
    return image
  }

  const scale = maxLongSide / longSide
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const data = new Uint8Array(width * height * 4)

  // Nearest-neighbor is enough: detector will resize again.
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor(y / scale))
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor(x / scale))
      const sourceIndex = (sourceY * image.width + sourceX) * 4
      const targetIndex = (y * width + x) * 4
      data[targetIndex] = image.data[sourceIndex] ?? 0
      data[targetIndex + 1] = image.data[sourceIndex + 1] ?? 0
      data[targetIndex + 2] = image.data[sourceIndex + 2] ?? 0
      data[targetIndex + 3] = image.data[sourceIndex + 3] ?? 255
    }
  }

  console.log(
    `[ocr] downscaled input: ${image.width}x${image.height} -> ${width}x${height} (maxLongSide=${maxLongSide})`,
  )
  return { width, height, data }
}

async function getOcrInstance(modelRoot: string, variant: OcrModelVariant) {
  const key = `${modelRoot}:${variant}`
  if (cachedKey === key && cachedOcr) {
    return cachedOcr
  }

  const asset = getModelAsset(variant)
  const modelDir = join(modelRoot, asset.dir)
  console.log(`[ocr] loading model: variant=${variant}, preset=${asset.preset}, dir=${modelDir}`)

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
  console.log(`[ocr] model files loaded: variant=${variant}, det=${detModel.byteLength}, rec=${recModel.byteLength}, dict=${dictionary.length}`)

  cachedOcr = await PaddleOcrService.createInstance({
    // onnxruntime-node 与 paddleocr 的类型定义不完全一致
    ort: ort as never,
    modelPreset: asset.preset,
    detection: {
      modelBuffer: toArrayBuffer(detModel),
      // Override v6 preset limitType="min", which keeps large photos near full resolution.
      limitType: 'max',
      maxSideLength: OCR_DETECTION_MAX_SIDE_LENGTH,
      maxSideLimit: OCR_DETECTION_MAX_SIDE_LIMIT,
    },
    recognition: {
      modelBuffer: toArrayBuffer(recModel),
      charactersDictionary,
    },
  })
  cachedKey = key
  console.log(`[ocr] model initialized: variant=${variant}`)

  return cachedOcr
}

export async function recognizeText(options: OcrRecognizeOptions) {
  const { modelRoot, variant } = options
  const image = downscaleImageIfNeeded(options.image)
  console.log(`[ocr] recognize input: variant=${variant}, size=${image.width}x${image.height}, data=${image.data.length}`)
  const ocr = await getOcrInstance(modelRoot, variant)

  const results = await ocr.recognize(
    {
      width: image.width,
      height: image.height,
      data: image.data,
    },
    {
      detection: {
        limitType: 'max',
        maxSideLength: OCR_DETECTION_MAX_SIDE_LENGTH,
        maxSideLimit: OCR_DETECTION_MAX_SIDE_LIMIT,
      },
    },
  )
  console.log(`[ocr] recognize finished: variant=${variant}, boxes=${results.length}`)

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

export async function recognizeImageFromPath(imagePath: string, runtime: OcrRuntimeOptions) {
  const image = await loadImageFromPath(imagePath)
  return recognizeText({
    modelRoot: runtime.modelRoot,
    variant: runtime.variant,
    image,
  })
}
