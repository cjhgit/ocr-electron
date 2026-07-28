import { mkdir, readFile, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { shell } from 'electron'
import { nanoid } from 'nanoid'
import type { Context } from 'koa'
import type { OcrModelVariant } from '../ocr/config'
import { recognizeImageFromPath, setDefaultOcrRuntime, setOcrWorkerPoolSize } from '../ocr/service'
import { FINANCE_CHECK_AMOUNT_TOLERANCE, FINANCE_CHECK_OCR_WORKER_COUNT } from './constants'
import {
  auditOutputFilename,
  writeAuditWorkbook,
  writeWorkbookWithReviewOverrides,
  type ReviewCellOverride,
} from './excel-writer'
import {
  FinanceChecker,
  FinanceCheckCancelledError,
  renderJsonReport,
  type FinanceCheckJsonReport,
} from './validator'
import { CheckStatusKey, overallStatus, type CheckStatus, type RowCheckResult } from './types'

export type FinanceCheckTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type FinanceCheckSummary = Record<CheckStatus, number>

export type FinanceCheckReviewStatus = 'pass' | 'fail'

export type FinanceCheckTaskItem = {
  id: string
  rowNumber: number
  pushDate: string | null
  city: string | null
  merchantName: string | null
  pusher: string | null
  couponCode: string | null
  expectedPaidAmount: string | null
  expectedMerchantAmount: string | null
  remark: string | null
  adjustedPaidAmount: string | null
  adjustedMerchantAmount: string | null
  reviewRemark: string | null
  reviewStatus: FinanceCheckReviewStatus | null
  overallStatus: CheckStatus
  paymentCheckStatus: CheckStatus | null
  paymentExpected: string | null
  paymentActual: string | null
  paymentMessage: string | null
  paymentCheckDetails: Record<string, unknown> | null
  merchantCheckStatus: CheckStatus | null
  merchantExpected: string | null
  merchantActual: string | null
  merchantMessage: string | null
  merchantCheckDetails: Record<string, unknown> | null
}

export type FinanceCheckItemReviewUpdate = {
  adjustedPaidAmount?: string | null
  adjustedMerchantAmount?: string | null
  reviewRemark?: string | null
  reviewStatus?: FinanceCheckReviewStatus | null
}

export type FinanceCheckTask = {
  id: string
  taskStatus: FinanceCheckTaskStatus
  sourceFileName: string
  sourcePath: string
  resultFileName: string | null
  sheetName: string | null
  modelVariant: OcrModelVariant | null
  tolerance: number
  ocrWorkerCount: number
  summary: FinanceCheckSummary | null
  totalRows: number | null
  processedRows: number | null
  reviewedRows: number | null
  progressPercent: number | null
  errorMessage: string | null
  resultDownloadUrl: string | null
  archived: boolean
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
}

type StoredTask = FinanceCheckTask & {
  sourcePath: string
  modelRoot?: string | null
  resultPath: string | null
  cancelledRequested?: boolean
  rowConcurrency?: number
}

type StoreData = {
  tasks: StoredTask[]
}

const DATA_DIR = join(homedir(), '.finance-checker')
const TASKS_FILE = join(DATA_DIR, 'tasks.json')
const FILES_DIR = join(DATA_DIR, 'files')
const PROGRESS_FLUSH_INTERVAL_MS = 1000

let processing = false
let storeQueue = Promise.resolve()
let deleting = Promise.resolve()
const forceDeletedTaskIds = new Set<string>()
const cancelRequestedTaskIds = new Set<string>()

function nowIso(): string {
  return new Date().toISOString()
}

function publicTask(task: StoredTask): FinanceCheckTask {
  return {
    id: task.id,
    taskStatus: task.taskStatus,
    sourceFileName: task.sourceFileName,
    sourcePath: task.sourcePath,
    resultFileName: task.resultFileName,
    sheetName: task.sheetName,
    modelVariant: task.modelVariant ?? null,
    tolerance: task.tolerance,
    ocrWorkerCount: task.ocrWorkerCount ?? task.rowConcurrency ?? FINANCE_CHECK_OCR_WORKER_COUNT,
    summary: task.summary,
    totalRows: task.totalRows,
    processedRows: task.processedRows,
    reviewedRows: task.reviewedRows ?? null,
    progressPercent: task.progressPercent,
    errorMessage: task.errorMessage,
    resultDownloadUrl: task.resultDownloadUrl,
    archived: Boolean(task.archived),
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    durationMs: task.durationMs,
  }
}

async function ensureStore(): Promise<void> {
  await mkdir(FILES_DIR, { recursive: true })
  try {
    await stat(TASKS_FILE)
  } catch {
    await writeJson(TASKS_FILE, { tasks: [] })
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await rename(tempPath, path)
  } catch {
    // Windows 上目标文件存在时 rename 可能失败，先删再替换
    await rm(path, { force: true })
    await rename(tempPath, path)
  }
}

async function readStore(): Promise<StoreData> {
  await ensureStore()
  return readJson<StoreData>(TASKS_FILE, { tasks: [] })
}

async function writeStore(store: StoreData): Promise<void> {
  await writeJson(TASKS_FILE, store)
}

async function withStore<T>(fn: (store: StoreData) => Promise<T> | T): Promise<T> {
  const run = storeQueue.then(async () => {
    const store = await readStore()
    return await fn(store)
  })
  storeQueue = run.then(() => undefined, () => undefined)
  return run
}

async function updateTask(taskId: string, updater: (task: StoredTask) => void): Promise<StoredTask | null> {
  return withStore(async (store) => {
    const task = store.tasks.find((item) => item.id === taskId) ?? null
    if (!task) return null
    updater(task)
    await writeStore(store)
    return task
  })
}

function itemPath(taskId: string): string {
  return join(FILES_DIR, taskId, 'items.json')
}

function reportPath(taskId: string): string {
  return join(FILES_DIR, taskId, 'debug-report.json')
}

function taskDir(taskId: string): string {
  return join(FILES_DIR, taskId)
}

function stringifyAmount(value: number | null): string | null {
  return value == null ? null : String(value)
}

function itemFromRowResult(taskId: string, rowResult: RowCheckResult): FinanceCheckTaskItem {
  const payment = rowResult.paymentCheck
  const merchant = rowResult.merchantCheck
  return {
    id: `${taskId}-${rowResult.row.rowNumber}`,
    rowNumber: rowResult.row.rowNumber,
    pushDate: rowResult.row.pushDate == null ? null : String(rowResult.row.pushDate),
    city: rowResult.row.city,
    merchantName: rowResult.row.merchantName,
    pusher: rowResult.row.pusher,
    couponCode: rowResult.row.couponCode,
    expectedPaidAmount: stringifyAmount(rowResult.row.expectedPaidAmount),
    expectedMerchantAmount: stringifyAmount(rowResult.row.expectedMerchantAmount),
    remark: rowResult.row.remark,
    adjustedPaidAmount: null,
    adjustedMerchantAmount: null,
    reviewRemark: null,
    reviewStatus: null,
    overallStatus: overallStatus(rowResult),
    paymentCheckStatus: payment?.status ?? null,
    paymentExpected: stringifyAmount(payment?.expected ?? null),
    paymentActual: stringifyAmount(payment?.actual ?? null),
    paymentMessage: payment?.message ?? null,
    paymentCheckDetails: payment?.details ?? null,
    merchantCheckStatus: merchant?.status ?? null,
    merchantExpected: stringifyAmount(merchant?.expected ?? null),
    merchantActual: stringifyAmount(merchant?.actual ?? null),
    merchantMessage: merchant?.message ?? null,
    merchantCheckDetails: merchant?.details ?? null,
  }
}

async function readItems(taskId: string): Promise<FinanceCheckTaskItem[]> {
  return readJson<FinanceCheckTaskItem[]>(itemPath(taskId), [])
}

async function writeItems(taskId: string, items: FinanceCheckTaskItem[]): Promise<void> {
  await writeJson(itemPath(taskId), items)
}

function countReviewedRows(items: FinanceCheckTaskItem[]): number {
  return items.filter((item) => item.reviewStatus != null).length
}

async function enrichPublicTask(task: StoredTask): Promise<FinanceCheckTask> {
  const publicTaskValue = publicTask(task)
  if (publicTaskValue.reviewedRows != null) return publicTaskValue
  if (task.taskStatus === 'pending' || task.taskStatus === 'running') return publicTaskValue
  const items = await readItems(task.id)
  if (items.length === 0) {
    if (task.taskStatus === 'succeeded') publicTaskValue.reviewedRows = 0
    return publicTaskValue
  }
  publicTaskValue.reviewedRows = countReviewedRows(items)
  if (publicTaskValue.totalRows == null) publicTaskValue.totalRows = items.length
  return publicTaskValue
}

function upsertItem(items: FinanceCheckTaskItem[], item: FinanceCheckTaskItem): void {
  const existingIndex = items.findIndex((entry) => entry.id === item.id)
  if (existingIndex >= 0) items[existingIndex] = item
  else items.push(item)
}

async function runTask(task: StoredTask): Promise<void> {
  const started = Date.now()
  const ocrWorkerCount = task.ocrWorkerCount ?? task.rowConcurrency ?? FINANCE_CHECK_OCR_WORKER_COUNT
  if (task.modelRoot && task.modelVariant) {
    setDefaultOcrRuntime({ modelRoot: task.modelRoot, variant: task.modelVariant })
  }
  setOcrWorkerPoolSize(ocrWorkerCount)
  console.log(`[finance-check] 任务开始: taskId=${task.id}, file=${task.sourcePath}, model=${task.modelVariant ?? '-'}, ocrWorkerCount=${ocrWorkerCount}`)
  await updateTask(task.id, (current) => {
    current.taskStatus = 'running'
    current.startedAt = nowIso()
    current.errorMessage = null
  })

  try {
    const checker = new FinanceChecker({
      tolerance: task.tolerance,
      ocrRecognizeProvider: recognizeImageFromPath,
    })
    const taskItems: FinanceCheckTaskItem[] = []
    let lastFlushAt = 0
    let flushQueue = Promise.resolve()
    function ensureTaskNotForceDeleted(): void {
      if (forceDeletedTaskIds.has(task.id)) throw new FinanceCheckCancelledError()
    }

    async function flushProgress(processedRows: number, totalRows: number): Promise<void> {
      ensureTaskNotForceDeleted()
      const currentTime = Date.now()
      if (processedRows < totalRows && currentTime - lastFlushAt < PROGRESS_FLUSH_INTERVAL_MS) return
      lastFlushAt = currentTime
      flushQueue = flushQueue.then(async () => {
        ensureTaskNotForceDeleted()
        taskItems.sort((a, b) => a.rowNumber - b.rowNumber)
        await writeItems(task.id, taskItems)
        await updateTask(task.id, (current) => {
          current.processedRows = processedRows
          current.totalRows = totalRows
          current.progressPercent = totalRows > 0 ? Math.round((processedRows / totalRows) * 100) : 0
        })
      })
      await flushQueue
    }

    const result = await checker.checkWorkbookConcurrent(task.sourcePath, {
      cacheDir: join(taskDir(task.id), '.cache'),
      concurrency: ocrWorkerCount,
      shouldCancel: async () => {
        if (forceDeletedTaskIds.has(task.id)) return true
        if (cancelRequestedTaskIds.has(task.id)) return true
        const store = await readStore()
        const current = store.tasks.find((item) => item.id === task.id)
        // 仅认显式取消标记；不要把「读 store 失败 / 短暂找不到任务」当成取消
        return current?.cancelledRequested === true
      },
      onRowProcessed: async (processedRows, totalRows, rowResult) => {
        ensureTaskNotForceDeleted()
        upsertItem(taskItems, itemFromRowResult(task.id, rowResult))
        await flushProgress(processedRows, totalRows)
      },
    })

    ensureTaskNotForceDeleted()
    await flushQueue
    const finalItems = result.rows.map((rowResult) => itemFromRowResult(task.id, rowResult))
    finalItems.sort((a, b) => a.rowNumber - b.rowNumber)
    await writeItems(task.id, finalItems)

    const report: FinanceCheckJsonReport = renderJsonReport(result)
    await writeJson(reportPath(task.id), report)
    const resultFileName = auditOutputFilename(task.sourceFileName)
    const resultPath = join(taskDir(task.id), resultFileName)
    await writeAuditWorkbook(task.sourcePath, result, resultPath, result.sheetName)

    await updateTask(task.id, (current) => {
      current.taskStatus = 'succeeded'
      current.resultFileName = resultFileName
      current.resultPath = resultPath
      current.sheetName = result.sheetName
      current.resultDownloadUrl = `http://localhost:38765/api/finance-check/tasks/${task.id}/download`
      current.summary = report.summary
      current.totalRows = result.rows.length
      current.processedRows = result.rows.length
      current.reviewedRows = 0
      current.progressPercent = 100
      current.finishedAt = nowIso()
      current.durationMs = Date.now() - started
      current.cancelledRequested = false
    })
    cancelRequestedTaskIds.delete(task.id)
    console.log(`[finance-check] 任务完成: taskId=${task.id}, duration=${Date.now() - started}ms`)
  } catch (error) {
    const isCancelled = error instanceof FinanceCheckCancelledError
    if (isCancelled) {
      console.warn(`[finance-check] 任务取消: taskId=${task.id}`)
    } else {
      console.error(`[finance-check] 任务失败: taskId=${task.id}`, error)
    }
    if (forceDeletedTaskIds.has(task.id)) {
      forceDeletedTaskIds.delete(task.id)
      cancelRequestedTaskIds.delete(task.id)
      return
    }
    await updateTask(task.id, (current) => {
      current.taskStatus = isCancelled ? 'cancelled' : 'failed'
      current.errorMessage = isCancelled ? null : error instanceof Error ? error.message : '对账失败'
      current.finishedAt = nowIso()
      current.durationMs = Date.now() - started
      current.cancelledRequested = false
    })
    cancelRequestedTaskIds.delete(task.id)
  }
}

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true
  try {
    while (true) {
      const store = await readStore()
      const nextTask = store.tasks.find((task) => task.taskStatus === 'pending')
      if (!nextTask) break
      await runTask(nextTask)
    }
  } catch (error) {
    console.error('[finance-check] 队列处理失败:', error)
  } finally {
    processing = false
  }
}

export async function createFinanceCheckTask(payload: {
  filePath: string
  modelRoot: string
  modelVariant: OcrModelVariant
  ocrWorkerCount: number
}): Promise<{ taskId: string; taskStatus: FinanceCheckTaskStatus }> {
  await ensureStore()
  const sourceFilePath = resolve(payload.filePath)
  const sourceStat = await stat(sourceFilePath)
  if (!sourceStat.isFile()) throw new Error('源文件不存在')
  const originalName = basename(sourceFilePath)
  if (extname(originalName).toLowerCase() !== '.xlsx') throw new Error('仅支持 .xlsx 文件')

  const id = nanoid()
  const dir = taskDir(id)
  await mkdir(dir, { recursive: true })
  const safeName = originalName.replace(/[\\/:*?"<>|]/g, '_')
  const sourcePath = join(dir, safeName)
  await copyFile(sourceFilePath, sourcePath)
  await writeJson(itemPath(id), [])

  const task: StoredTask = {
    id,
    taskStatus: 'pending',
    sourceFileName: safeName,
    resultFileName: null,
    resultPath: null,
    sourcePath,
    sheetName: null,
    modelRoot: payload.modelRoot,
    modelVariant: payload.modelVariant,
    tolerance: FINANCE_CHECK_AMOUNT_TOLERANCE,
    ocrWorkerCount: payload.ocrWorkerCount,
    summary: null,
    totalRows: null,
    processedRows: null,
    reviewedRows: null,
    progressPercent: 0,
    errorMessage: null,
    resultDownloadUrl: null,
    archived: false,
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    durationMs: null,
  }

  await withStore(async (currentStore) => {
    currentStore.tasks.unshift(task)
    await writeStore(currentStore)
  })
  void processQueue().catch((error) => {
    console.error('[finance-check] 启动队列失败:', error)
  })
  return { taskId: id, taskStatus: task.taskStatus }
}

export async function listFinanceCheckTasks(params: {
  page?: number
  pageSize?: number
  taskStatus?: FinanceCheckTaskStatus
  includeArchived?: boolean
}): Promise<{ items: FinanceCheckTask[]; total: number }> {
  const store = await readStore()
  let filtered = store.tasks
  if (!params.includeArchived) {
    filtered = filtered.filter((task) => !task.archived)
  }
  if (params.taskStatus) {
    filtered = filtered.filter((task) => task.taskStatus === params.taskStatus)
  }
  const page = Math.max(1, params.page ?? 1)
  const pageSize = Math.max(1, params.pageSize ?? 10)
  const pageTasks = filtered.slice((page - 1) * pageSize, page * pageSize)
  return {
    items: await Promise.all(pageTasks.map((task) => enrichPublicTask(task))),
    total: filtered.length,
  }
}

export async function getFinanceCheckTask(taskId: string): Promise<FinanceCheckTask | null> {
  const store = await readStore()
  const task = store.tasks.find((item) => item.id === taskId)
  return task ? enrichPublicTask(task) : null
}

export async function updateFinanceCheckItem(
  taskId: string,
  itemId: string,
  update: FinanceCheckItemReviewUpdate,
): Promise<FinanceCheckTaskItem | null> {
  const items = await readItems(taskId)
  const index = items.findIndex((item) => item.id === itemId)
  if (index < 0) return null

  const item = items[index]
  if (update.adjustedPaidAmount !== undefined) item.adjustedPaidAmount = update.adjustedPaidAmount
  if (update.adjustedMerchantAmount !== undefined) item.adjustedMerchantAmount = update.adjustedMerchantAmount
  if (update.reviewRemark !== undefined) item.reviewRemark = update.reviewRemark
  if (update.reviewStatus !== undefined) item.reviewStatus = update.reviewStatus
  items[index] = item
  await writeItems(taskId, items)
  if (update.reviewStatus !== undefined) {
    await updateTask(taskId, (current) => {
      current.reviewedRows = countReviewedRows(items)
      if (current.totalRows == null) current.totalRows = items.length
    })
  }
  return item
}

export async function listFinanceCheckItems(params: {
  taskId: string
  page?: number
  pageSize?: number
  overallStatus?: CheckStatus
}): Promise<{ items: FinanceCheckTaskItem[]; total: number }> {
  const items = await readItems(params.taskId)
  const filtered = params.overallStatus
    ? items.filter((item) =>
        params.overallStatus === CheckStatusKey.FAIL
          ? item.overallStatus === CheckStatusKey.FAIL || item.overallStatus === CheckStatusKey.ERROR
          : item.overallStatus === params.overallStatus,
      )
    : items
  const page = Math.max(1, params.page ?? 1)
  const pageSize = Math.max(1, params.pageSize ?? 50)
  return {
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
  }
}

export async function cancelFinanceCheckTask(taskId: string): Promise<boolean> {
  const task = await updateTask(taskId, (current) => {
    if (current.taskStatus === 'pending') {
      current.taskStatus = 'cancelled'
      current.finishedAt = nowIso()
      current.cancelledRequested = false
    } else if (current.taskStatus === 'running') {
      current.cancelledRequested = true
      cancelRequestedTaskIds.add(taskId)
    }
  })
  return Boolean(task)
}

export async function setFinanceCheckTaskArchived(taskId: string, archived: boolean): Promise<boolean> {
  return withStore(async (store) => {
    const task = store.tasks.find((item) => item.id === taskId)
    if (!task) return false
    if (task.taskStatus === 'pending' || task.taskStatus === 'running') return false
    task.archived = archived
    await writeStore(store)
    return true
  })
}

export async function deleteFinanceCheckTask(taskId: string): Promise<boolean> {
  const result = deleting.then(async () => {
    return withStore(async (store) => {
      const task = store.tasks.find((item) => item.id === taskId)
      if (!task) return false
      if (task.taskStatus === 'pending' || task.taskStatus === 'running') forceDeletedTaskIds.add(taskId)
      cancelRequestedTaskIds.delete(taskId)
      store.tasks = store.tasks.filter((item) => item.id !== taskId)
      await writeStore(store)
      await rm(taskDir(taskId), { recursive: true, force: true })
      return true
    })
  })
  deleting = result.then(() => undefined, () => undefined)
  return result
}

export async function sendFinanceCheckDownload(ctx: Context, taskId: string): Promise<boolean> {
  const store = await readStore()
  const task = store.tasks.find((item) => item.id === taskId)
  if (!task?.resultPath || !task.resultFileName) return false

  const items = await readItems(taskId)
  const overrides: ReviewCellOverride[] = items.flatMap((item) => {
    if (
      item.adjustedPaidAmount == null
      && item.adjustedMerchantAmount == null
      && item.reviewRemark == null
    ) {
      return []
    }
    return [{
      rowNumber: item.rowNumber,
      paidAmount: item.adjustedPaidAmount,
      merchantAmount: item.adjustedMerchantAmount,
      remark: item.reviewRemark,
    }]
  })

  let filePath = task.resultPath
  if (overrides.length > 0) {
    const downloadPath = join(taskDir(taskId), `download-${task.resultFileName}`)
    await writeWorkbookWithReviewOverrides(
      task.resultPath,
      downloadPath,
      overrides,
      task.sheetName ?? undefined,
    )
    filePath = downloadPath
  }

  const downloadFileName = auditOutputFilename(task.sourceFileName)
  ctx.attachment(downloadFileName)
  ctx.type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ctx.body = createReadStream(filePath)
  return true
}

function isInsideDir(filePath: string, dirPath: string): boolean {
  const resolvedFile = resolve(filePath)
  const resolvedDir = resolve(dirPath)
  return resolvedFile === resolvedDir || resolvedFile.startsWith(`${resolvedDir}${sep}`)
}

function imageContentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.bmp':
      return 'image/bmp'
    case '.png':
    default:
      return 'image/png'
  }
}

export async function sendFinanceCheckImage(ctx: Context, taskId: string, imagePath: string): Promise<boolean> {
  if (!imagePath) return false
  const resolvedImagePath = basename(imagePath) === imagePath
    ? join(taskDir(taskId), '.cache', imagePath)
    : imagePath
  if (!isInsideDir(resolvedImagePath, taskDir(taskId))) return false
  try {
    const imageStat = await stat(resolvedImagePath)
    if (!imageStat.isFile()) return false
  } catch {
    return false
  }
  ctx.type = imageContentType(resolvedImagePath)
  ctx.body = createReadStream(resolvedImagePath)
  return true
}

export async function openFinanceCheckSourceFile(taskId: string): Promise<boolean> {
  const store = await readStore()
  const task = store.tasks.find((item) => item.id === taskId)
  if (!task?.sourcePath) return false
  try {
    const sourceStat = await stat(task.sourcePath)
    if (!sourceStat.isFile()) return false
  } catch {
    return false
  }

  const error = await shell.openPath(task.sourcePath)
  if (error) throw new Error(error)
  return true
}
