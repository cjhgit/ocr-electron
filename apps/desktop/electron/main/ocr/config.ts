import type { PaddleOcrModelPresetName } from 'paddleocr'

export type OcrModelVariant = 'server' | 'v6_small' | 'v6_medium'

export type ModelAsset = {
  preset: PaddleOcrModelPresetName
  dir: string
  det: string
  rec: string
  dict: string
}

export const MODEL_ASSETS: Record<OcrModelVariant, ModelAsset> = {
  server: {
    preset: 'PP-OCRv5_server',
    dir: 'ppocr_v5_server',
    det: 'PP-OCRv5_server_det_infer.onnx',
    rec: 'PP-OCRv5_server_rec_infer.onnx',
    dict: 'ppocrv5_dict.txt',
  },
  v6_small: {
    preset: 'PP-OCRv6_small',
    dir: 'ppocr_v6_small',
    det: 'PP-OCRv6_small_det_infer.onnx',
    rec: 'PP-OCRv6_small_rec_infer.onnx',
    dict: 'ppocrv6_dict.txt',
  },
  v6_medium: {
    preset: 'PP-OCRv6_medium',
    dir: 'ppocr_v6_medium',
    det: 'PP-OCRv6_medium_det_infer.onnx',
    rec: 'PP-OCRv6_medium_rec_infer.onnx',
    dict: 'ppocrv6_dict.txt',
  },
}

export function getModelAsset(variant: OcrModelVariant): ModelAsset {
  return MODEL_ASSETS[variant]
}

export function isOcrModelVariant(value: unknown): value is OcrModelVariant {
  return value === 'server' || value === 'v6_small' || value === 'v6_medium'
}
