import { fork, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OcrModelVariant } from './config'
import type {
  OcrImageInput,
  OcrRecognizeOptions,
  OcrRuntimeOptions,
} from './engine'

export type OcrNodeMode = 'builtin' | 'custom'

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
  nodeVersion: string | null
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
const OCR_WORKER_RETRY_LIMIT = 2
const OCR_WORKER_POOL_MAX = 4

let defaultRuntime: OcrRuntimeOptions | null = null
let nodeConfig: OcrNodeConfig = {
  mode: 'builtin',
  customPath: '',
}
let nextRequestId = 1

type PendingOcrRequest = {
  id: number
  request: OcrWorkerRequestPayload
  resolve: (value: { text: string }) => void
  reject: (reason: unknown) => void
  timeout: NodeJS.Timeout
  attempts: number
}

type OcrWorkerSlot = {
  id: number
  process: ChildProcess
  output: {
    stdout: string
    stderr: string
  }
  currentRequestId: number | null
  stopping: boolean
}

let configuredWorkerCount: number | null = null
let nextWorkerSlotId = 1
let workers: OcrWorkerSlot[] = []
const pendingRequests = new Map<number, PendingOcrRequest>()
const queuedRequestIds: number[] = []

function defaultOcrWorkerCount(): number {
  const envValue = Number(process.env.OCR_WORKER_COUNT)
  if (Number.isFinite(envValue) && envValue > 0) {
    return Math.max(1, Math.min(OCR_WORKER_POOL_MAX, Math.round(envValue)))
  }
  const usableCores = Math.max(1, availableParallelism() - 1)
  return Math.max(1, Math.min(OCR_WORKER_POOL_MAX, usableCores))
}

function getOcrWorkerCount(): number {
  return configuredWorkerCount ?? defaultOcrWorkerCount()
}

export function setOcrWorkerPoolSize(count: number): void {
  const normalized = Math.max(1, Math.min(OCR_WORKER_POOL_MAX, Math.round(count)))
  if (configuredWorkerCount === normalized) return
  configuredWorkerCount = normalized
  console.log(`[ocr] worker pool size set: ${normalized}`)
  trimWorkerPool()
  scheduleOcrRequests()
}

export function setDefaultOcrRuntime(options: OcrRuntimeOptions) {
  defaultRuntime = options
}

export function setOcrNodeConfig(config: OcrNodeConfig): void {
  const normalized = normalizeOcrNodeConfig(config)
  const changed = normalized.mode !== nodeConfig.mode || normalized.customPath !== nodeConfig.customPath
  nodeConfig = normalized
  if (changed && workers.length > 0) {
    console.log('[ocr] node config changed, restarting worker pool')
    restartWorkerPool(new Error('OCR Node 配置已变化，请重新发起 OCR 请求'))
  }
}

export function normalizeOcrNodeMode(value: unknown): OcrNodeMode {
  if (value === 'custom') return 'custom'
  return 'builtin'
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

function isValidSystemNodePath(nodePath: string | undefined): nodePath is string {
  return Boolean(
    nodePath
    && nodePath !== process.execPath
    && !isElectronExecPath(nodePath)
    && existsSync(nodePath),
  )
}

function listSystemNodeCandidates(): Array<{ path?: string; source: OcrNodeRuntimeInfo['source'] }> {
  const nodeExecutable = process.platform === 'win32' ? 'node.exe' : 'node'
  return [
    { path: process.env.OCR_NODE_EXEC_PATH, source: 'env' },
    { path: process.env.NODE_BINARY, source: 'env' },
    { path: process.env.npm_node_execpath, source: 'env' },
    { path: process.env.NVM_BIN ? join(process.env.NVM_BIN, nodeExecutable) : undefined, source: 'nvm' },
    ...((process.env.PATH ?? '').split(delimiter).map((entry) => ({
      path: entry ? join(entry, nodeExecutable) : undefined,
      source: 'path' as const,
    }))),
  ]
}

function detectSystemNodePathFromShell(): string | null {
  try {
    const result = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'where node'], {
          encoding: 'utf8',
          timeout: 5000,
        })
      : spawnSync(process.env.SHELL ?? 'sh', ['-lc', 'command -v node'], {
          encoding: 'utf8',
          timeout: 5000,
        })
    const nodePath = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => isValidSystemNodePath(line))
    return nodePath ?? null
  } catch (error) {
    console.warn('[ocr] 通过 shell 查找 Node 失败:', error)
    return null
  }
}

export function detectSystemNodePath(): string | null {
  for (const candidate of listSystemNodeCandidates()) {
    if (isValidSystemNodePath(candidate.path)) {
      return candidate.path
    }
  }
  return detectSystemNodePathFromShell()
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
      nodeVersion: null,
    }
  }

  return {
    mode: normalized.mode,
    customPath: normalized.customPath,
    resolvedPath: process.execPath,
    usingElectronAsNode: Boolean(process.versions.electron),
    source: 'electron',
    nodeVersion: process.versions.node ?? null,
  }
}

const WORKER_OUTPUT_MAX_CHARS = 8_192

function trimWorkerOutput(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized.length <= WORKER_OUTPUT_MAX_CHARS) return normalized
  return `...(truncated)\n${normalized.slice(-WORKER_OUTPUT_MAX_CHARS)}`
}

function isOnnxDlopenFailure(output: string | undefined): boolean {
  if (!output) return false
  return (
    /ERR_DLOPEN_FAILED/i.test(output)
    || /onnxruntime_binding\.node/i.test(output)
    || /The specified module could not be found/i.test(output)
  )
}

function formatWorkerFailure(
  prefix: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  output?: string,
): Error {
  const reason = signal ? `signal=${signal}` : `code=${code ?? 'unknown'}`
  const detail = output ? `\n${output}` : ''
  if (isOnnxDlopenFailure(output)) {
    return new Error(
      `${prefix}（${reason}）\n`
      + '无法加载 onnxruntime-node 原生模块（ERR_DLOPEN_FAILED）。\n'
      + '常见原因：1) 安装包未正确解出 onnxruntime.dll；2) 目标电脑缺少 VC++ 运行库。\n'
      + '请安装 Microsoft Visual C++ Redistributable（x64）：https://aka.ms/vs/17/release/vc_redist.x64.exe\n'
      + '然后重启应用再试。'
      + detail,
    )
  }
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

/** 打包后始终映射到 unpacked 路径（不回退 asar），用于校验原生 DLL 是否真在磁盘上 */
function toAsarUnpackedPath(filePath: string): string {
  return filePath.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1')
}

function isPackagedApp(): boolean {
  return __dirname.includes('app.asar')
}

function resolveWorkerScriptPath(nodeInfo: OcrNodeRuntimeInfo): string {
  const scriptInAsar = join(__dirname, 'ocr-worker.js')
  const scriptPath = nodeInfo.usingElectronAsNode
    ? scriptInAsar
    : resolveAsarUnpackedPath(scriptInAsar)
  if (!existsSync(scriptPath)) {
    throw new Error(`OCR worker 脚本不存在: ${scriptPath}`)
  }
  return scriptPath
}

const OCR_WORKER_MODULE_NAMES = [
  'onnxruntime-node',
  'onnxruntime-common',
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
    const packageRoot = isPackagedApp()
      ? dirname(toAsarUnpackedPath(packageJsonPath))
      : dirname(packageJsonPath)
    const nativeDir = join(packageRoot, 'bin', 'napi-v6', process.platform, process.arch)
    return existsSync(nativeDir) ? nativeDir : null
  } catch (error) {
    console.warn('[ocr] resolve onnxruntime-node native dir failed:', error)
    return null
  }
}

function assertOnnxRuntimeNativeReady(): void {
  const nativeDir = resolveOnnxRuntimeNativeDir()
  if (!nativeDir) {
    throw new Error(
      '未找到 onnxruntime-node 原生目录（bin/napi-v6/...）。'
      + (isPackagedApp()
        ? '请确认安装包已正确解出 app.asar.unpacked/node_modules/onnxruntime-node。'
        : '请重新安装依赖（pnpm install）。'),
    )
  }

  if (isPackagedApp() && !nativeDir.includes('app.asar.unpacked')) {
    throw new Error(
      `onnxruntime 原生目录仍在 asar 内，无法被 Windows 加载：${nativeDir}\n`
      + '请检查 electron-builder asarUnpack 是否包含 onnxruntime-node / *.dll。',
    )
  }

  const bindingPath = join(nativeDir, 'onnxruntime_binding.node')
  if (!existsSync(bindingPath)) {
    throw new Error(`未找到 onnxruntime_binding.node：${bindingPath}`)
  }

  if (process.platform === 'win32') {
    const requiredDlls = ['onnxruntime.dll']
    const missing = requiredDlls.filter((name) => !existsSync(join(nativeDir, name)))
    if (missing.length > 0) {
      let listing = ''
      try {
        listing = readdirSync(nativeDir).join(', ')
      } catch {
        listing = '(无法读取目录)'
      }
      throw new Error(
        `onnxruntime 原生目录缺少 DLL：${missing.join(', ')}\n`
        + `目录：${nativeDir}\n`
        + `现有文件：${listing}\n`
        + '这通常是打包时 asarUnpack 未解出 DLL。请用最新安装包重装。',
      )
    }
  }

  console.log('[ocr] onnxruntime native ready:', nativeDir)
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

function createWorkerSlot(slotId: number): OcrWorkerSlot {
  const nodeInfo = resolveOcrNodeRuntimeInfo()
  if (nodeInfo.mode === 'custom') {
    if (!nodeInfo.resolvedPath) {
      throw new Error('请填写自定义 Node.js 路径')
    }
    validateCustomNodePath(nodeInfo.resolvedPath)
  }
  const workerScriptPath = resolveWorkerScriptPath(nodeInfo)
  assertOnnxRuntimeNativeReady()
  console.log('[ocr] starting worker process:', { ...nodeInfo, workerScriptPath, slotId })
  const workerOutput = { stdout: '', stderr: '' }
  const child = fork(workerScriptPath, [], {
    execPath: nodeInfo.resolvedPath,
    env: createWorkerEnv(nodeInfo),
    execArgv: process.execArgv.filter((arg) => !arg.startsWith('--inspect')),
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })

  const slot: OcrWorkerSlot = {
    id: slotId,
    process: child,
    output: workerOutput,
    currentRequestId: null,
    stopping: false,
  }

  child.stdout?.on('data', (chunk) => {
    appendWorkerOutput(workerOutput, 'stdout', chunk)
    process.stdout.write(`[ocr-worker:${child.pid ?? 'unknown'}#${slotId}] ${chunk}`)
  })
  child.stderr?.on('data', (chunk) => {
    appendWorkerOutput(workerOutput, 'stderr', chunk)
    process.stderr.write(`[ocr-worker:${child.pid ?? 'unknown'}#${slotId}] ${chunk}`)
  })
  child.on('message', (message: OcrWorkerResponse) => {
    if ('type' in message && message.type === 'fatal') {
      const error = new Error(message.error.message)
      error.stack = message.error.stack
      console.error(`[ocr] worker fatal error: slot=${slotId}`, error)
      failCurrentRequest(slot, error, true)
      slot.stopping = true
      child.kill()
      return
    }

    const response = message as OcrWorkerSuccess | OcrWorkerFailure
    const pending = pendingRequests.get(response.id)
    if (!pending) return
    pendingRequests.delete(response.id)
    slot.currentRequestId = null
    clearTimeout(pending.timeout)
    if (response.ok) {
      pending.resolve(response.result)
      scheduleOcrRequests()
      return
    }
    const error = new Error(response.error.message)
    error.stack = response.error.stack
    pending.reject(error)
    scheduleOcrRequests()
  })
  child.on('error', (error) => {
    console.error(`[ocr] worker process error: slot=${slotId}`, error)
    failCurrentRequest(slot, error instanceof Error ? error : new Error(String(error)), true)
    slot.stopping = true
    child.kill()
  })
  child.on('exit', (code, signal) => {
    const output = trimWorkerOutput(
      [workerOutput.stderr, workerOutput.stdout].filter(Boolean).join('\n'),
    )
    console.error('[ocr] worker process exited:', { slotId, code, signal, output: output || undefined })
    removeWorkerSlot(slot)
    const abnormalExit = !slot.stopping && code !== 0
    if (abnormalExit || slot.currentRequestId != null) {
      failCurrentRequest(
        slot,
        formatWorkerFailure('OCR 子进程异常退出', code, signal, output || undefined),
        true,
      )
    }
    scheduleOcrRequests()
  })
  return slot
}

function removeWorkerSlot(slot: OcrWorkerSlot): void {
  workers = workers.filter((workerSlot) => workerSlot !== slot)
}

function stopWorkerSlot(slot: OcrWorkerSlot): void {
  slot.stopping = true
  slot.process.kill()
}

function restartWorkerPool(error: Error): void {
  rejectAllPending(error)
  for (const slot of workers) {
    stopWorkerSlot(slot)
  }
  workers = []
}

function trimWorkerPool(): void {
  const targetCount = getOcrWorkerCount()
  const extraWorkers = workers.slice(targetCount)
  for (const slot of extraWorkers) {
    if (slot.currentRequestId == null) {
      stopWorkerSlot(slot)
      removeWorkerSlot(slot)
    }
  }
}

function ensureWorkerPool(): void {
  const targetCount = getOcrWorkerCount()
  while (workers.length < targetCount) {
    workers.push(createWorkerSlot(nextWorkerSlotId))
    nextWorkerSlotId += 1
  }
}

function getIdleWorker(): OcrWorkerSlot | null {
  return workers.find((slot) => slot.currentRequestId == null && slot.process.connected && !slot.stopping) ?? null
}

function requeueRequest(pending: PendingOcrRequest): void {
  queuedRequestIds.unshift(pending.id)
}

function failCurrentRequest(slot: OcrWorkerSlot, error: Error, retryable: boolean): void {
  const requestId = slot.currentRequestId
  if (requestId == null) return
  slot.currentRequestId = null
  const pending = pendingRequests.get(requestId)
  if (!pending) return
  if (retryable && pending.attempts <= OCR_WORKER_RETRY_LIMIT) {
    console.warn(`[ocr] retry request after worker failure: id=${requestId}, attempts=${pending.attempts}`)
    requeueRequest(pending)
    scheduleOcrRequests()
    return
  }
  pendingRequests.delete(requestId)
  clearTimeout(pending.timeout)
  pending.reject(error)
}

function rejectAllPending(error: Error): void {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timeout)
    pending.reject(error)
  }
  pendingRequests.clear()
  queuedRequestIds.length = 0
}

function scheduleOcrRequests(): void {
  if (queuedRequestIds.length === 0) return
  ensureWorkerPool()
  while (queuedRequestIds.length > 0) {
    const slot = getIdleWorker()
    if (!slot) return
    const requestId = queuedRequestIds.shift()!
    const pending = pendingRequests.get(requestId)
    if (!pending) continue
    pending.attempts += 1
    slot.currentRequestId = requestId
    slot.process.send({ ...pending.request, id: pending.id }, (error) => {
      if (!error) return
      if (slot.currentRequestId === requestId) slot.currentRequestId = null
      const activePending = pendingRequests.get(requestId)
      if (!activePending) return
      if (activePending.attempts <= OCR_WORKER_RETRY_LIMIT) {
        requeueRequest(activePending)
        scheduleOcrRequests()
        return
      }
      pendingRequests.delete(requestId)
      clearTimeout(activePending.timeout)
      activePending.reject(error)
    })
  }
}

function callWorker(request: OcrWorkerRequestPayload): Promise<{ text: string }> {
  const id = nextRequestId
  nextRequestId += 1
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = pendingRequests.get(id)
      pendingRequests.delete(id)
      const queuedIndex = queuedRequestIds.indexOf(id)
      if (queuedIndex >= 0) queuedRequestIds.splice(queuedIndex, 1)
      reject(new Error(`OCR 识别超时：${Math.round(OCR_REQUEST_TIMEOUT_MS / 1000)} 秒内未返回`))
      const activeSlot = workers.find((slot) => slot.currentRequestId === id)
      if (activeSlot) stopWorkerSlot(activeSlot)
      if (pending) scheduleOcrRequests()
    }, OCR_REQUEST_TIMEOUT_MS)
    pendingRequests.set(id, { id, request, resolve, reject, timeout, attempts: 0 })
    queuedRequestIds.push(id)
    scheduleOcrRequests()
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
