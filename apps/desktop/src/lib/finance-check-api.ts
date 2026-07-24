import type { OcrModelVariant } from './ocr-api'

const API_BASE = 'http://localhost:38765'

export type FinanceCheckTaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type FinanceCheckResultStatus = 'pass' | 'fail' | 'skip' | 'error'

export type FinanceCheckSummary = {
  pass: number
  fail: number
  skip: number
  error: number
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
  rowConcurrency: number
  summary: FinanceCheckSummary | null
  totalRows: number | null
  processedRows: number | null
  progressPercent: number | null
  errorMessage: string | null
  resultDownloadUrl: string | null
  archived: boolean
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
}

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
  overallStatus: FinanceCheckResultStatus
  paymentCheckStatus: FinanceCheckResultStatus | null
  paymentExpected: string | null
  paymentActual: string | null
  paymentMessage: string | null
  paymentCheckDetails: Record<string, unknown> | null
  merchantCheckStatus: FinanceCheckResultStatus | null
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

type ApiResponse<T> = {
  code: number
  message?: string
  data?: T
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init)
  const result = (await response.json()) as ApiResponse<T>
  if (!response.ok || result.code !== 0 || result.data == null) {
    throw new Error(result.message ?? '请求失败')
  }
  return result.data
}

export async function uploadFinanceCheckTask(payload: {
  file: File
  modelRoot: string
  variant: OcrModelVariant
  rowConcurrency: number
}) {
  const formData = new FormData()
  formData.set('file', payload.file, payload.file.name)
  formData.set('modelRoot', payload.modelRoot)
  formData.set('variant', payload.variant)
  formData.set('rowConcurrency', String(payload.rowConcurrency))

  return request<{ taskId: string; taskStatus: FinanceCheckTaskStatus }>(
    '/api/finance-check/tasks',
    {
      method: 'POST',
      body: formData,
    },
  )
}

export function fetchFinanceCheckTasks(params: {
  page: number
  pageSize: number
  taskStatus?: FinanceCheckTaskStatus
  includeArchived?: boolean
}) {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  })
  if (params.taskStatus) query.set('taskStatus', params.taskStatus)
  if (params.includeArchived) query.set('includeArchived', '1')
  return request<{ items: FinanceCheckTask[]; total: number }>(
    `/api/finance-check/tasks?${query}`,
  )
}

export function fetchFinanceCheckTask(taskId: string) {
  return request<FinanceCheckTask>(`/api/finance-check/tasks/${taskId}`)
}

export function fetchFinanceCheckTaskItems(
  taskId: string,
  params: { page: number; pageSize: number; overallStatus?: FinanceCheckResultStatus },
) {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  })
  if (params.overallStatus) query.set('overallStatus', params.overallStatus)
  return request<{ items: FinanceCheckTaskItem[]; total: number }>(
    `/api/finance-check/tasks/${taskId}/items?${query}`,
  )
}

export function updateFinanceCheckTaskItem(
  taskId: string,
  itemId: string,
  update: FinanceCheckItemReviewUpdate,
) {
  return request<FinanceCheckTaskItem>(`/api/finance-check/tasks/${taskId}/items/${itemId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  })
}

export function cancelFinanceCheckTask(taskId: string) {
  return request<{ ok: boolean }>(`/api/finance-check/tasks/${taskId}/cancel`, {
    method: 'POST',
  })
}

export function deleteFinanceCheckTask(taskId: string) {
  return request<{ ok: boolean }>(`/api/finance-check/tasks/${taskId}`, {
    method: 'DELETE',
  })
}

export function archiveFinanceCheckTask(taskId: string) {
  return request<{ ok: boolean }>(`/api/finance-check/tasks/${taskId}/archive`, {
    method: 'POST',
  })
}

export function unarchiveFinanceCheckTask(taskId: string) {
  return request<{ ok: boolean }>(`/api/finance-check/tasks/${taskId}/unarchive`, {
    method: 'POST',
  })
}

export function openFinanceCheckSourceFile(taskId: string) {
  return request<{ ok: boolean }>(`/api/finance-check/tasks/${taskId}/open-source`, {
    method: 'POST',
  })
}

export function financeCheckImageUrl(taskId: string, imagePath: string) {
  return `${API_BASE}/api/finance-check/tasks/${taskId}/image?path=${encodeURIComponent(imagePath)}`
}
