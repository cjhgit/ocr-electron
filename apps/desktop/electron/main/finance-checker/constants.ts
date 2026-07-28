export const FINANCE_CHECK_ALLOWED_EXTENSIONS = ['.xlsx'] as const
export const FINANCE_CHECK_AMOUNT_TOLERANCE = 0.05
export const FINANCE_CHECK_OCR_WORKER_COUNT = 2
/** 对账时按批处理行数，控制峰值内存 */
export const FINANCE_CHECK_ROW_BATCH_SIZE = 100
