import { Worker } from 'node:worker_threads'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OcrModelVariant } from './config'
import type {
  OcrImageInput,
  OcrRecognizeOptions,
  OcrRuntimeOptions,
} from './engine'

type OcrWorkerSuccess = {
  id: number
  ok: true
  result: { text: string }
}

type OcrWorkerFailure = {
  id: number
  ok: false
  error: {
    message: string
    stack?: string
  }
}

type OcrWorkerResponse = OcrWorkerSuccess | OcrWorkerFailure

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

type OcrWorkerRequestPayload =
  | {
      type: 'recognizeText'
      options: OcrRecognizeOptions
    }
  | {
      type: 'recognizeImageFromPath'
      imagePath: string
      runtime: OcrRuntimeOptions
    }

const __dirname = dirname(fileURLToPath(import.meta.url))

let defaultRuntime: OcrRuntimeOptions | null = null
let worker: Worker | null = null
let nextRequestId = 1
const pendingRequests = new Map<number, {
  resolve: (value: { text: string }) => void
  reject: (reason: unknown) => void
}>()

export function setDefaultOcrRuntime(options: OcrRuntimeOptions) {
  defaultRuntime = options
}

function getWorker(): Worker {
  if (worker) return worker

  worker = new Worker(join(__dirname, 'ocr-worker.js'))
  worker.on('message', (message: OcrWorkerResponse) => {
    const pending = pendingRequests.get(message.id)
    if (!pending) return
    pendingRequests.delete(message.id)
    if (message.ok) {
      pending.resolve(message.result)
      return
    }
    const error = new Error(message.error.message)
    error.stack = message.error.stack
    pending.reject(error)
  })
  worker.on('error', (error) => {
    rejectAllPending(error instanceof Error ? error : new Error(String(error)))
    worker = null
  })
  worker.on('exit', (code) => {
    if (code !== 0) {
      rejectAllPending(new Error(`OCR 工作线程异常退出：${code}`))
    }
    worker = null
  })
  return worker
}

function rejectAllPending(error: Error): void {
  for (const pending of pendingRequests.values()) {
    pending.reject(error)
  }
  pendingRequests.clear()
}

function callWorker(request: OcrWorkerRequestPayload): Promise<{ text: string }> {
  const id = nextRequestId
  nextRequestId += 1
  const activeWorker = getWorker()
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject })
    activeWorker.postMessage({ ...request, id })
  })
}

export type { OcrImageInput, OcrRecognizeOptions, OcrRuntimeOptions, OcrModelVariant }

export async function recognizeText(options: OcrRecognizeOptions) {
  setDefaultOcrRuntime({ modelRoot: options.modelRoot, variant: options.variant })
  return callWorker({
    type: 'recognizeText',
    options,
  })
}

export async function recognizeImageFromPath(imagePath: string) {
  if (!defaultRuntime) {
    throw new Error('请先在“设置”中完成一次 OCR 识别，或配置模型后再执行对账')
  }
  return callWorker({
    type: 'recognizeImageFromPath',
    imagePath,
    runtime: defaultRuntime,
  })
}
