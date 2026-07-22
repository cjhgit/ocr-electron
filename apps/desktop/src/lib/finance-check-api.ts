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
  resultFileName: string | null
  sheetName: string | null
  tolerance: number
  summary: FinanceCheckSummary | null
  totalRows: number | null
  processedRows: number | null
  progressPercent: number | null
  errorMessage: string | null
  resultDownloadUrl: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
}

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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = String(reader.result ?? '')
      resolve(value.includes(',') ? value.slice(value.indexOf(',') + 1) : value)
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

export async function uploadFinanceCheckTask(payload: {
  file: File
  modelRoot: string
  variant: 'mobile' | 'server'
}) {
  return request<{ taskId: string; taskStatus: FinanceCheckTaskStatus }>(
    '/api/finance-check/tasks',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: payload.file.name,
        contentBase64: await fileToBase64(payload.file),
        modelRoot: payload.modelRoot,
        variant: payload.variant,
      }),
    },
  )
}

export function fetchFinanceCheckTasks(params: {
  page: number
  pageSize: number
  taskStatus?: FinanceCheckTaskStatus
}) {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  })
  if (params.taskStatus) query.set('taskStatus', params.taskStatus)
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
