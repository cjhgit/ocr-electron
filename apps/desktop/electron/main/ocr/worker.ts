import {
  recognizeImageFromPath,
  recognizeText,
  type OcrRecognizeOptions,
  type OcrRuntimeOptions,
} from './engine'
import { initErrorLogging } from '../logger'

initErrorLogging('ocr-worker')

function notifyFatalError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'OCR 子进程发生未捕获异常'
  const stack = error instanceof Error ? error.stack : undefined
  process.send?.({
    type: 'fatal',
    error: { message, stack },
  })
}

process.on('uncaughtException', (error) => {
  console.error('[ocr-worker] uncaught exception:', error)
  notifyFatalError(error)
})

process.on('unhandledRejection', (reason) => {
  console.error('[ocr-worker] unhandled rejection:', reason)
  notifyFatalError(reason)
})

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
    console.log(`[ocr] request start: id=${message.id}, type=${message.type}`)
    const result = message.type === 'recognizeText'
      ? await recognizeText(message.options)
      : await recognizeImageFromPath(message.imagePath, message.runtime)
    console.log(`[ocr] request success: id=${message.id}`)
    process.send?.({
      id: message.id,
      ok: true,
      result: { text: result.text },
    })
  } catch (error) {
    console.error(`[ocr] request failed: id=${message.id}`, error)
    process.send?.({
      id: message.id,
      ok: false,
      error: {
        message: error instanceof Error ? error.message : 'OCR 识别失败',
        stack: error instanceof Error ? error.stack : undefined,
      },
    })
  }
}

let queue = Promise.resolve()

process.on('message', (message: OcrWorkerRequest) => {
  queue = queue.then(() => handleRequest(message)).catch((error) => {
    console.error('[ocr] request queue failed:', error)
  })
})
