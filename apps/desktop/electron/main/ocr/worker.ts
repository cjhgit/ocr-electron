import { parentPort } from 'node:worker_threads'
import {
  recognizeImageFromPath,
  recognizeText,
  type OcrRecognizeOptions,
  type OcrRuntimeOptions,
} from './engine'

type OcrWorkerRequest =
  | {
      id: number
      type: 'recognizeText'
      options: OcrRecognizeOptions
    }
  | {
      id: number
      type: 'recognizeImageFromPath'
      imagePath: string
      runtime: OcrRuntimeOptions
    }

async function handleRequest(message: OcrWorkerRequest): Promise<void> {
  try {
    const result = message.type === 'recognizeText'
      ? await recognizeText(message.options)
      : await recognizeImageFromPath(message.imagePath, message.runtime)
    parentPort?.postMessage({
      id: message.id,
      ok: true,
      result: { text: result.text },
    })
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      ok: false,
      error: {
        message: error instanceof Error ? error.message : 'OCR 识别失败',
        stack: error instanceof Error ? error.stack : undefined,
      },
    })
  }
}

parentPort?.on('message', (message: OcrWorkerRequest) => {
  void handleRequest(message)
})
