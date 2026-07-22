import type { PaddleOcrModelPresetName } from 'paddleocr'

export type OcrModelVariant = 'mobile' | 'server'

export type ModelAsset = {
  preset: PaddleOcrModelPresetName
  dir: string
  det: string
  rec: string
  dict: string
}

export const MODEL_ASSETS: Record<OcrModelVariant, ModelAsset> = {
  mobile: {
    preset: 'PP-OCRv5_mobile',
    dir: 'ppocr_v5_mobile',
    det: 'PP-OCRv5_mobile_det_infer.onnx',
    rec: 'PP-OCRv5_mobile_rec_infer.onnx',
    dict: 'ppocrv5_dict.txt',
  },
  server: {
    preset: 'PP-OCRv5_server',
    dir: 'ppocr_v5_server',
    det: 'PP-OCRv5_server_det_infer.onnx',
    rec: 'PP-OCRv5_server_rec_infer.onnx',
    dict: 'ppocrv5_dict.txt',
  },
}

export function getModelAsset(variant: OcrModelVariant): ModelAsset {
  return MODEL_ASSETS[variant]
}
