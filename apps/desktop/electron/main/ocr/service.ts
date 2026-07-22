import { fork, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
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
const OCR_REQUEST_TIMEOUT_MS = 5 * 60_000

let defaultRuntime: OcrRuntimeOptions | null = null
let worker: ChildProcess | null = null
let nextRequestId = 1
const pendingRequests = new Map<number, {
  resolve: (value: { text: string }) => void
  reject: (reason: unknown) => void
  timeout: NodeJS.Timeout
}>()

export function setDefaultOcrRuntime(options: OcrRuntimeOptions) {
  defaultRuntime = options
}

function isElectronExecPath(execPath: string): boolean {
  return basename(execPath).toLowerCase().includes('electron')
}

function resolveNodeExecPath(): string {
  if (!process.versions.electron || !isElectronExecPath(process.execPath)) {
    return process.execPath
  }

  const candidates = [
    process.env.OCR_NODE_EXEC_PATH,
    process.env.NODE_BINARY,
    process.env.npm_node_execpath,
    process.env.NVM_BIN ? join(process.env.NVM_BIN, 'node') : undefined,
    ...((process.env.PATH ?? '').split(delimiter).map((entry) => entry ? join(entry, 'node') : '')),
  ]

  for (const candidate of candidates) {
    if (candidate && candidate !== process.execPath && existsSync(candidate)) {
      return candidate
    }
  }

  try {
    const result = spawnSync('zsh', ['-ic', 'command -v node'], {
      encoding: 'utf8',
      timeout: 5000,
    })
    const nodePath = result.stdout.trim().split(/\r?\n/).at(-1)
    if (nodePath && nodePath !== process.execPath && existsSync(nodePath)) {
      return nodePath
    }
  } catch (error) {
    console.warn('[ocr] 通过 shell 查找 Node 失败:', error)
  }

  console.warn('[ocr] 未找到独立 Node 可执行文件，将回退到 Electron-as-Node')
  return process.execPath
}

function formatWorkerFailure(prefix: string, code: number | null, signal: NodeJS.Signals | null): Error {
  const reason = signal ? `signal=${signal}` : `code=${code ?? 'unknown'}`
  return new Error(`${prefix}（${reason}）`)
}

function getWorker(): ChildProcess {
  if (worker?.connected) return worker

  const execPath = resolveNodeExecPath()
  const usingElectronAsNode = execPath === process.execPath && process.versions.electron
  console.log('[ocr] starting worker process:', { execPath, usingElectronAsNode })
  worker = fork(join(__dirname, 'ocr-worker.js'), [], {
    execPath,
    env: usingElectronAsNode
      ? {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
        }
      : process.env,
    execArgv: process.execArgv.filter((arg) => !arg.startsWith('--inspect')),
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  worker.stdout?.on('data', (chunk) => {
    process.stdout.write(`[ocr-worker:${worker?.pid ?? 'unknown'}] ${chunk}`)
  })
  worker.stderr?.on('data', (chunk) => {
    process.stderr.write(`[ocr-worker:${worker?.pid ?? 'unknown'}] ${chunk}`)
  })
  worker.on('message', (message: OcrWorkerResponse) => {
    const pending = pendingRequests.get(message.id)
    if (!pending) return
    pendingRequests.delete(message.id)
    clearTimeout(pending.timeout)
    if (message.ok) {
      pending.resolve(message.result)
      return
    }
    const error = new Error(message.error.message)
    error.stack = message.error.stack
    pending.reject(error)
  })
  worker.on('error', (error) => {
    console.error('[ocr] worker process error:', error)
    rejectAllPending(error instanceof Error ? error : new Error(String(error)))
    worker = null
  })
  worker.on('exit', (code, signal) => {
    console.error('[ocr] worker process exited:', { code, signal })
    if (code !== 0 || pendingRequests.size > 0) {
      rejectAllPending(formatWorkerFailure('OCR 子进程异常退出', code, signal))
    }
    worker = null
  })
  return worker
}

function rejectAllPending(error: Error): void {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timeout)
    pending.reject(error)
  }
  pendingRequests.clear()
}

function callWorker(request: OcrWorkerRequestPayload): Promise<{ text: string }> {
  const id = nextRequestId
  nextRequestId += 1
  const activeWorker = getWorker()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error(`OCR 识别超时：${Math.round(OCR_REQUEST_TIMEOUT_MS / 1000)} 秒内未返回`))
      activeWorker.kill()
    }, OCR_REQUEST_TIMEOUT_MS)
    pendingRequests.set(id, { resolve, reject, timeout })
    activeWorker.send({ ...request, id }, (error) => {
      if (!error) return
      const pending = pendingRequests.get(id)
      if (!pending) return
      pendingRequests.delete(id)
      clearTimeout(pending.timeout)
      pending.reject(error)
    })
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
