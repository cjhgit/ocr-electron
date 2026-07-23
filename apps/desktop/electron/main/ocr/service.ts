import { fork, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OcrModelVariant } from './config'
import type {
  OcrImageInput,
  OcrRecognizeOptions,
  OcrRuntimeOptions,
} from './engine'

export type OcrNodeMode = 'auto' | 'custom'

export type OcrNodeConfig = {
  mode: OcrNodeMode
  customPath: string
}

export type OcrNodeRuntimeInfo = {
  mode: OcrNodeMode
  customPath: string
  resolvedPath: string
  usingElectronAsNode: boolean
  source: 'custom' | 'env' | 'nvm' | 'path' | 'shell' | 'electron'
}

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

type OcrWorkerFatal = {
  type: 'fatal'
  error: {
    message: string
    stack?: string
  }
}

type OcrWorkerResponse = OcrWorkerSuccess | OcrWorkerFailure | OcrWorkerFatal

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
const require = createRequire(import.meta.url)
const OCR_REQUEST_TIMEOUT_MS = 5 * 60_000

let defaultRuntime: OcrRuntimeOptions | null = null
let nodeConfig: OcrNodeConfig = {
  mode: 'auto',
  customPath: '',
}
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

export function setOcrNodeConfig(config: OcrNodeConfig): void {
  const normalized = normalizeOcrNodeConfig(config)
  const changed = normalized.mode !== nodeConfig.mode || normalized.customPath !== nodeConfig.customPath
  nodeConfig = normalized
  if (changed && worker) {
    console.log('[ocr] node config changed, restarting worker process')
    worker.kill()
    worker = null
  }
}

export function normalizeOcrNodeMode(value: unknown): OcrNodeMode {
  return value === 'custom' ? 'custom' : 'auto'
}

export function normalizeOcrNodeConfig(config: Partial<OcrNodeConfig> | null | undefined): OcrNodeConfig {
  return {
    mode: normalizeOcrNodeMode(config?.mode),
    customPath: typeof config?.customPath === 'string' ? config.customPath.trim() : '',
  }
}

function isElectronExecPath(execPath: string): boolean {
  return basename(execPath).toLowerCase().includes('electron')
}

export function resolveOcrNodeRuntimeInfo(config: OcrNodeConfig = nodeConfig): OcrNodeRuntimeInfo {
  const normalized = normalizeOcrNodeConfig(config)
  if (normalized.mode === 'custom') {
    return {
      mode: normalized.mode,
      customPath: normalized.customPath,
      resolvedPath: normalized.customPath,
      usingElectronAsNode: false,
      source: 'custom',
    }
  }

  if (!process.versions.electron || !isElectronExecPath(process.execPath)) {
    return {
      mode: normalized.mode,
      customPath: normalized.customPath,
      resolvedPath: process.execPath,
      usingElectronAsNode: false,
      source: 'env',
    }
  }

  const candidates: Array<{ path?: string; source: OcrNodeRuntimeInfo['source'] }> = [
    { path: process.env.OCR_NODE_EXEC_PATH, source: 'env' },
    { path: process.env.NODE_BINARY, source: 'env' },
    { path: process.env.npm_node_execpath, source: 'env' },
    { path: process.env.NVM_BIN ? join(process.env.NVM_BIN, 'node') : undefined, source: 'nvm' },
    ...((process.env.PATH ?? '').split(delimiter).map((entry) => ({
      path: entry ? join(entry, 'node') : undefined,
      source: 'path' as const,
    }))),
  ]

  for (const candidate of candidates) {
    if (candidate.path && candidate.path !== process.execPath && existsSync(candidate.path)) {
      return {
        mode: normalized.mode,
        customPath: normalized.customPath,
        resolvedPath: candidate.path,
        usingElectronAsNode: false,
        source: candidate.source,
      }
    }
  }

  try {
    const result = spawnSync('zsh', ['-ic', 'command -v node'], {
      encoding: 'utf8',
      timeout: 5000,
    })
    const nodePath = result.stdout.trim().split(/\r?\n/).at(-1)
    if (nodePath && nodePath !== process.execPath && existsSync(nodePath)) {
      return {
        mode: normalized.mode,
        customPath: normalized.customPath,
        resolvedPath: nodePath,
        usingElectronAsNode: false,
        source: 'shell',
      }
    }
  } catch (error) {
    console.warn('[ocr] 通过 shell 查找 Node 失败:', error)
  }

  console.warn('[ocr] 未找到独立 Node 可执行文件，将回退到 Electron-as-Node')
  return {
    mode: normalized.mode,
    customPath: normalized.customPath,
    resolvedPath: process.execPath,
    usingElectronAsNode: Boolean(process.versions.electron),
    source: 'electron',
  }
}

const WORKER_OUTPUT_MAX_CHARS = 8_192

function trimWorkerOutput(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized.length <= WORKER_OUTPUT_MAX_CHARS) return normalized
  return `...(truncated)\n${normalized.slice(-WORKER_OUTPUT_MAX_CHARS)}`
}

function formatWorkerFailure(
  prefix: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  output?: string,
): Error {
  const reason = signal ? `signal=${signal}` : `code=${code ?? 'unknown'}`
  const detail = output ? `\n${output}` : ''
  return new Error(`${prefix}（${reason}）${detail}`)
}

function validateCustomNodePath(nodePath: string): void {
  if (!existsSync(nodePath)) {
    throw new Error(`自定义 Node.js 路径不存在: ${nodePath}`)
  }

  const probe = spawnSync(nodePath, ['-p', 'process.version'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  })
  if (probe.error || probe.status !== 0) {
    const detail = trimWorkerOutput(
      [probe.stderr, probe.stdout, probe.error?.message].filter(Boolean).join('\n'),
    )
    throw new Error(
      `自定义 Node.js 无法运行: ${nodePath}${detail ? `\n${detail}` : ''}`,
    )
  }
}

function resolveAsarUnpackedPath(filePath: string): string {
  const unpacked = filePath.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1')
  return unpacked !== filePath && existsSync(unpacked) ? unpacked : filePath
}

function isPackagedApp(): boolean {
  return __dirname.includes('app.asar')
}

function resolveWorkerScriptPath(): string {
  const scriptPath = resolveAsarUnpackedPath(join(__dirname, 'ocr-worker.js'))
  if (!existsSync(scriptPath)) {
    throw new Error(`OCR worker 脚本不存在: ${scriptPath}`)
  }
  return scriptPath
}

const OCR_WORKER_MODULE_NAMES = [
  'onnxruntime-node',
  'onnxruntime-common',
  'paddleocr',
  'jpeg-js',
  'fast-png',
] as const

function resolvePackagedNodeModuleSearchPaths(): string[] {
  if (!isPackagedApp()) return []

  const paths = new Set<string>()
  for (const moduleName of OCR_WORKER_MODULE_NAMES) {
    try {
      const packageJsonPath = resolveAsarUnpackedPath(require.resolve(`${moduleName}/package.json`))
      if (existsSync(packageJsonPath)) {
        paths.add(dirname(dirname(packageJsonPath)))
      }
    } catch (error) {
      console.warn(`[ocr] resolve packaged module path failed: ${moduleName}`, error)
    }
  }
  return [...paths]
}

function resolveOnnxRuntimeNativeDir(): string | null {
  try {
    const packageJsonPath = require.resolve('onnxruntime-node/package.json')
    const packageRoot = resolveAsarUnpackedPath(dirname(packageJsonPath))
    const nativeDir = join(packageRoot, 'bin', 'napi-v6', process.platform, process.arch)
    return existsSync(nativeDir) ? nativeDir : null
  } catch (error) {
    console.warn('[ocr] resolve onnxruntime-node native dir failed:', error)
    return null
  }
}

function createWorkerEnv(nodeInfo: OcrNodeRuntimeInfo): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }

  if (nodeInfo.usingElectronAsNode) {
    env.ELECTRON_RUN_AS_NODE = '1'
  } else if (isPackagedApp()) {
    const moduleSearchPaths = resolvePackagedNodeModuleSearchPaths()
    if (moduleSearchPaths.length > 0) {
      const existing = env.NODE_PATH ?? ''
      env.NODE_PATH = [...moduleSearchPaths, existing].filter(Boolean).join(delimiter)
    }
  }

  const nativeDir = resolveOnnxRuntimeNativeDir()
  if (nativeDir) {
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    const pathEntries = (env[pathKey] ?? '').split(delimiter).filter(Boolean)
    if (!pathEntries.some((entry) => entry.toLowerCase() === nativeDir.toLowerCase())) {
      env[pathKey] = [nativeDir, ...pathEntries].join(delimiter)
    }
  }

  return env
}

function appendWorkerOutput(buffer: { stdout: string; stderr: string }, stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  buffer[stream] += text
  if (buffer[stream].length > WORKER_OUTPUT_MAX_CHARS * 2) {
    buffer[stream] = buffer[stream].slice(-WORKER_OUTPUT_MAX_CHARS * 2)
  }
}

function getWorker(): ChildProcess {
  if (worker?.connected) return worker

  const nodeInfo = resolveOcrNodeRuntimeInfo()
  if (nodeInfo.mode === 'custom') {
    if (!nodeInfo.resolvedPath) {
      throw new Error('请填写自定义 Node.js 路径')
    }
    validateCustomNodePath(nodeInfo.resolvedPath)
  }
  const workerScriptPath = resolveWorkerScriptPath()
  console.log('[ocr] starting worker process:', { ...nodeInfo, workerScriptPath })
  const workerOutput = { stdout: '', stderr: '' }
  worker = fork(workerScriptPath, [], {
    execPath: nodeInfo.resolvedPath,
    env: createWorkerEnv(nodeInfo),
    execArgv: process.execArgv.filter((arg) => !arg.startsWith('--inspect')),
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  worker.stdout?.on('data', (chunk) => {
    appendWorkerOutput(workerOutput, 'stdout', chunk)
    process.stdout.write(`[ocr-worker:${worker?.pid ?? 'unknown'}] ${chunk}`)
  })
  worker.stderr?.on('data', (chunk) => {
    appendWorkerOutput(workerOutput, 'stderr', chunk)
    process.stderr.write(`[ocr-worker:${worker?.pid ?? 'unknown'}] ${chunk}`)
  })
  worker.on('message', (message: OcrWorkerResponse) => {
    if ('type' in message && message.type === 'fatal') {
      const error = new Error(message.error.message)
      error.stack = message.error.stack
      console.error('[ocr] worker fatal error:', error)
      rejectAllPending(error)
      worker?.kill()
      worker = null
      return
    }

    const response = message as OcrWorkerSuccess | OcrWorkerFailure
    const pending = pendingRequests.get(response.id)
    if (!pending) return
    pendingRequests.delete(response.id)
    clearTimeout(pending.timeout)
    if (response.ok) {
      pending.resolve(response.result)
      return
    }
    const error = new Error(response.error.message)
    error.stack = response.error.stack
    pending.reject(error)
  })
  worker.on('error', (error) => {
    console.error('[ocr] worker process error:', error)
    rejectAllPending(error instanceof Error ? error : new Error(String(error)))
    worker = null
  })
  worker.on('exit', (code, signal) => {
    const output = trimWorkerOutput(
      [workerOutput.stderr, workerOutput.stdout].filter(Boolean).join('\n'),
    )
    console.error('[ocr] worker process exited:', { code, signal, output: output || undefined })
    if (code !== 0 || pendingRequests.size > 0) {
      rejectAllPending(formatWorkerFailure('OCR 子进程异常退出', code, signal, output || undefined))
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
