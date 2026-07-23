export const CheckStatusKey = {
  PASS: 'pass',
  FAIL: 'fail',
  SKIP: 'skip',
  ERROR: 'error',
} as const

export type CheckStatus = (typeof CheckStatusKey)[keyof typeof CheckStatusKey]

export type RowRecord = {
  rowNumber: number
  pushDate: unknown
  city: string | null
  merchantName: string | null
  pusher: string | null
  couponCode: string | null
  expectedPaidAmount: number | null
  expectedMerchantAmount: number | null
  paymentImageId: string | null
  merchantImageId: string | null
  remark: string | null
  isSummaryRow: boolean
}

export type FieldCheck = {
  fieldName: string
  status: CheckStatus
  expected: number | null
  actual: number | null
  message: string
  details: Record<string, unknown>
}

export type RowCheckResult = {
  row: RowRecord
  paymentCheck: FieldCheck | null
  merchantCheck: FieldCheck | null
}

export type WorkbookCheckResult = {
  source: string
  sheetName: string
  rows: RowCheckResult[]
  imageCacheDir?: string
}

export function overallStatus(result: RowCheckResult): CheckStatus {
  const checks = [result.paymentCheck, result.merchantCheck].filter(
    Boolean,
  ) as FieldCheck[]
  if (checks.length === 0) return CheckStatusKey.SKIP
  if (checks.some((check) => check.status === CheckStatusKey.ERROR)) {
    return CheckStatusKey.FAIL
  }
  if (checks.some((check) => check.status === CheckStatusKey.FAIL)) {
    return CheckStatusKey.FAIL
  }
  if (checks.every((check) => check.status === CheckStatusKey.PASS)) {
    return CheckStatusKey.PASS
  }
  return CheckStatusKey.SKIP
}

export function summarizeRows(rows: RowCheckResult[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = {
    pass: 0,
    fail: 0,
    skip: 0,
    error: 0,
  }
  for (const row of rows) {
    counts[overallStatus(row)] += 1
  }
  return counts
}
