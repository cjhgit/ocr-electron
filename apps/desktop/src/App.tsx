import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import appPackage from '../package.json'
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bug,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Cpu,
  Download,
  Eye,
  FileSpreadsheet,
  FolderOpen,
  Info as InfoIcon,
  MoreHorizontal,
  RefreshCw,
  ScanSearch,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react'
import Lightbox from 'yet-another-react-lightbox'
import Zoom from 'yet-another-react-lightbox/plugins/zoom'
import 'yet-another-react-lightbox/styles.css'
import { Alert, AlertAction, AlertDescription, AlertTitle } from './components/ui/alert'
import { Badge } from './components/ui/badge'
import { Button, buttonVariants } from './components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card'
import { Checkbox } from './components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu'
import { Input } from './components/ui/input'
import { Label } from './components/ui/label'
import { NativeSelect, NativeSelectOption } from './components/ui/native-select'
import { Progress } from './components/ui/progress'
import { RadioGroup, RadioGroupItem } from './components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'
import { Switch } from './components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs'
import { Textarea } from './components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip'
import {
  detectSystemNode,
  downloadServerModel,
  fetchServerModelInfo,
  fetchAppConfig,
  loadImagePixels,
  clearErrorLogs,
  openConfigFolder,
  openLogFolder,
  recognizeImage,
  saveAppConfig,
  type AppConfig,
  type OcrNodeMode,
  type OcrModelVariant,
  type OcrServerModelInfo,
} from './lib/ocr-api'
import {
  archiveFinanceCheckTask,
  cancelFinanceCheckTask,
  deleteFinanceCheckTask,
  fetchFinanceCheckTask,
  fetchFinanceCheckTaskItems,
  fetchFinanceCheckTasks,
  financeCheckImageUrl,
  openFinanceCheckSourceFile,
  unarchiveFinanceCheckTask,
  updateFinanceCheckTaskItem,
  uploadFinanceCheckTask,
  type FinanceCheckItemReviewUpdate,
  type FinanceCheckResultStatus,
  type FinanceCheckReviewStatus,
  type FinanceCheckTask,
  type FinanceCheckTaskItem,
  type FinanceCheckTaskStatus,
} from './lib/finance-check-api'
import { cn } from './lib/utils'

const TASK_STATUS_LABEL: Record<FinanceCheckTaskStatus, string> = {
  pending: '排队中',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const TASK_DISPLAY_STATUS_LABEL: Record<FinanceCheckTaskStatus | 'cancelling', string> = {
  ...TASK_STATUS_LABEL,
  cancelling: '取消中',
}

const RESULT_STATUS_LABEL: Record<FinanceCheckResultStatus, string> = {
  pass: '通过',
  fail: '不通过',
  skip: '跳过',
  error: '不通过',
}

const STATUS_OPTIONS: Array<{ value: FinanceCheckTaskStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '排队中' },
  { value: 'running', label: '执行中' },
  { value: 'succeeded', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
]

const FINANCE_CHECK_EXAMPLE_XLSX_URL =
  'https://ai-html.obs.cn-south-1.myhuaweicloud.com:443/finance-checker/example.xlsx'

const ITEM_STATUS_OPTIONS: Array<{ value: FinanceCheckResultStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部结果' },
  { value: 'pass', label: '通过' },
  { value: 'fail', label: '不通过' },
  { value: 'skip', label: '跳过' },
]

const OCR_MODEL_LABEL: Record<OcrModelVariant, string> = {
  v5_server: 'v5_server',
  v6_tiny: 'v6_tiny',
  v6_small: 'v6_small',
  v6_medium: 'v6_medium',
}

const OCR_MODEL_OPTIONS: Array<{ value: OcrModelVariant; label: string; badge?: string; description: string }> = [
  {
    value: 'v5_server',
    label: 'v5_server',
    badge: '高精度',
    description: '旧版高精度模型，准确率较高，但占用资源较多',
  },
  {
    value: 'v6_small',
    label: 'v6_small',
    badge: '轻量',
    description: '轻量、速度快，占用资源少',
  },
  {
    value: 'v6_medium',
    label: 'v6_medium',
    badge: '均衡',
    description: '准确率较高，但比较耗资源',
  },
  {
    value: 'v6_tiny',
    label: 'v6_tiny',
    badge: '极轻量',
    description: '体积最小、速度最快，占用资源最少',
  },
]

type SettingsTab = 'model' | 'debug' | 'about'

const pageShellClass = 'mx-auto flex min-h-screen w-full max-w-[1600px] flex-col gap-5 p-6 max-sm:p-4'
const bottomRightInfoClass = 'pointer-events-none fixed right-4 bottom-4 flex items-center gap-1.5 text-xs text-muted-foreground select-none'
const pageStackClass = 'flex flex-col gap-4'
const cardStackClass = 'flex flex-col gap-4'
const actionsClass = 'flex flex-wrap items-center justify-end gap-2 max-lg:justify-start'
const rowActionsClass = 'flex flex-nowrap items-center gap-2'
const fieldClass = 'flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground'
const mutedClass = 'text-sm text-muted-foreground'
const errorTextClass = 'text-sm text-destructive'
const tableWrapClass = 'overflow-hidden rounded-lg border [&_[data-slot=table-container]]:max-h-[calc(100vh-320px)] [&_[data-slot=table-head]]:bg-muted [&_[data-slot=table-head]]:text-xs [&_[data-slot=table-head]]:text-muted-foreground [&_[data-slot=table]]:text-xs'
const emptyCellClass = 'h-24 text-center text-muted-foreground'
const dangerClass = 'text-destructive hover:text-destructive'
const detailValueClass = 'text-sm font-medium text-foreground'

function formatTime(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString()
}

function formatAppVersion(version: string | undefined): string {
  return version ? `v${version}` : '-'
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} 秒`
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`
}

function formatTaskDuration(task: FinanceCheckTask, nowMs: number): string {
  if (task.taskStatus === 'pending' || task.taskStatus === 'running') {
    return formatDuration(nowMs - new Date(task.createdAt).getTime())
  }
  return formatDuration(task.durationMs)
}

function formatOcrModelVariant(variant: OcrModelVariant | null): string {
  return variant ? OCR_MODEL_LABEL[variant] : '-'
}

function formatOcrNodeModeLabel(mode: OcrNodeMode, nodeVersion: string | null = null): string {
  if (mode === 'custom') return '自定义 Node.js'
  return nodeVersion ? `内置 Node.js v${nodeVersion}` : '内置 Node.js'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function StatusBadge({ status }: { status: FinanceCheckTaskStatus | FinanceCheckResultStatus | 'cancelling' }) {
  const toneClass = {
    pending: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300',
    running: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300',
    succeeded: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
    failed: 'text-destructive',
    cancelled: 'border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-900/60 dark:bg-yellow-950/40 dark:text-yellow-300',
    cancelling: 'border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-900/60 dark:bg-yellow-950/40 dark:text-yellow-300',
    pass: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
    fail: 'text-destructive',
    skip: 'border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-900/60 dark:bg-yellow-950/40 dark:text-yellow-300',
    error: 'text-destructive',
  }[status]

  return (
    <Badge variant={status === 'failed' || status === 'fail' || status === 'error' ? 'destructive' : 'outline'} className={toneClass}>
      {status in TASK_DISPLAY_STATUS_LABEL
        ? TASK_DISPLAY_STATUS_LABEL[status as FinanceCheckTaskStatus | 'cancelling']
        : RESULT_STATUS_LABEL[status as FinanceCheckResultStatus]}
    </Badge>
  )
}

function failSummaryCount(summary: NonNullable<FinanceCheckTask['summary']>): number {
  return summary.fail + summary.error
}

function formatCheckSummary(summary: NonNullable<FinanceCheckTask['summary']>): string {
  return `通过 ${summary.pass} / 不通过 ${failSummaryCount(summary)} / 跳过 ${summary.skip}`
}

function SummaryCount({ value, tone }: { value: number; tone: 'pass' | 'fail' }) {
  if (value <= 0) return <>{value}</>
  return <span className={cn('font-semibold', tone === 'pass' ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive')}>{value}</span>
}

function SummaryText({ task }: { task: FinanceCheckTask }) {
  if (!task.summary) return <span className={mutedClass}>-</span>
  return (
    <span className="text-xs text-muted-foreground">
      通过 <SummaryCount value={task.summary.pass} tone="pass" />
      {' / '}
      不通过 <SummaryCount value={failSummaryCount(task.summary)} tone="fail" />
      {' / '}
      跳过 <SummaryCount value={task.summary.skip} tone="fail" />
    </span>
  )
}

function TaskProgress({ task, cancelling = false }: { task: FinanceCheckTask; cancelling?: boolean }) {
  if (!cancelling && task.taskStatus !== 'pending' && task.taskStatus !== 'running') return null
  const percent = task.progressPercent ?? 0
  return (
    <div className="min-w-45">
      <Progress value={Math.max(0, Math.min(100, percent))} className="mb-1" />
      <span className={mutedClass}>
        {cancelling
          ? '正在取消，请稍候...'
          : task.taskStatus === 'pending'
            ? '排队中，等待执行...'
            : task.totalRows
              ? `对账中 ${percent}%（${task.processedRows ?? 0} / ${task.totalRows} 行）`
              : '对账中，正在读取 Excel...'}
      </span>
    </div>
  )
}

function ErrorMessageCell({ message }: { message: string | null }) {
  if (!message) return <span className={mutedClass}>-</span>
  return (
    <span className="block max-w-50 truncate text-xs leading-snug text-destructive" title={message}>
      {message}
    </span>
  )
}

function stringDetail(details: Record<string, unknown> | null, key: string): string | null {
  const value = details?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function detailImageUrl(taskId: string, details: Record<string, unknown> | null): string | null {
  const imagePath = stringDetail(details, 'imagePath') ?? stringDetail(details, 'image')
  return imagePath ? financeCheckImageUrl(taskId, imagePath) : null
}

function ImageViewButton({
  title,
  imageUrl,
  onOpen,
}: {
  title: string
  imageUrl: string | null
  onOpen: (target: { title: string; url: string }) => void
}) {
  if (!imageUrl) return <span className={mutedClass}>-</span>
  return (
    <Button type="button" variant="ghost" size="sm" onClick={() => onOpen({ title, url: imageUrl })}>
      <Eye size={14} />查看
    </Button>
  )
}

function normalizeAmountInput(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' || trimmed === '-' ? null : trimmed
}

function buildAdjustedAmount(input: string, original: string | null): string | null {
  const normalized = normalizeAmountInput(input)
  const originalNormalized = original?.trim() ?? null
  if (normalized === originalNormalized) return null
  return normalized
}

function displayAmount(item: FinanceCheckTaskItem, field: 'paid' | 'merchant'): {
  display: string
  original: string | null
  modified: boolean
} {
  const original = field === 'paid' ? item.expectedPaidAmount : item.expectedMerchantAmount
  const adjusted = field === 'paid' ? item.adjustedPaidAmount : item.adjustedMerchantAmount
  if (adjusted != null && adjusted !== original) {
    return { display: adjusted, original, modified: true }
  }
  return { display: original ?? '-', original: null, modified: false }
}

function aiReviewStatusLabel(status: FinanceCheckResultStatus): string {
  if (status === 'pass') return 'AI 通过'
  if (status === 'skip') return 'AI 跳过'
  if (status === 'fail' || status === 'error') return 'AI 不通过'
  return 'AI -'
}

function aiReviewStatusClass(status: FinanceCheckResultStatus): string {
  if (status === 'pass') return 'text-emerald-600 dark:text-emerald-400'
  if (status === 'skip') return 'text-amber-600 dark:text-amber-400'
  if (status === 'fail' || status === 'error') return 'text-destructive'
  return 'text-muted-foreground'
}

function manualReviewStatusLabel(status: FinanceCheckReviewStatus): string {
  return status === 'pass' ? '人工通过' : '人工不通过'
}

function ManualReviewTag({ status }: { status: FinanceCheckReviewStatus }) {
  const toneClass = status === 'pass'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
    : undefined

  return (
    <Badge variant={status === 'fail' ? 'destructive' : 'outline'} className={toneClass}>
      {manualReviewStatusLabel(status)}
    </Badge>
  )
}

function ModifiedAmountCell({ display, original }: { display: string; original: string | null }) {
  if (!original) return <span>{display}</span>
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-default text-destructive" />}>
        {display}
      </TooltipTrigger>
      <TooltipContent>原始值：{original}</TooltipContent>
    </Tooltip>
  )
}

function displayRemark(item: FinanceCheckTaskItem): {
  display: string
  original: string | null
  modified: boolean
  editValue: string
} {
  const original = item.remark
  const review = item.reviewRemark
  const editValue = review ?? original ?? ''
  if (review != null && review !== original) {
    return { display: review, original, modified: true, editValue }
  }
  return { display: review ?? original ?? '-', original: null, modified: false, editValue }
}

function buildReviewRemark(input: string, original: string | null): string | null {
  const normalized = input.trim() || null
  const originalNormalized = original?.trim() || null
  if (normalized === originalNormalized) return null
  return normalized
}

function EditableAmountCell({
  item,
  field,
  disabled,
  onUpdate,
}: {
  item: FinanceCheckTaskItem
  field: 'paid' | 'merchant'
  disabled?: boolean
  onUpdate: (update: FinanceCheckItemReviewUpdate) => Promise<FinanceCheckTaskItem>
}) {
  const amount = displayAmount(item, field)
  const editValue = field === 'paid'
    ? (item.adjustedPaidAmount ?? item.expectedPaidAmount ?? '')
    : (item.adjustedMerchantAmount ?? item.expectedMerchantAmount ?? '')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(editValue)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    setDraft(editValue)
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing, editValue])

  async function commit() {
    if (saving || disabled) return
    const original = field === 'paid' ? item.expectedPaidAmount : item.expectedMerchantAmount
    const adjusted = buildAdjustedAmount(draft, original)
    const currentAdjusted = field === 'paid' ? item.adjustedPaidAmount : item.adjustedMerchantAmount
    if (adjusted === currentAdjusted) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      await onUpdate(field === 'paid' ? { adjustedPaidAmount: adjusted } : { adjustedMerchantAmount: adjusted })
      setEditing(false)
    } catch {
      // 错误由父组件处理
    } finally {
      setSaving(false)
    }
  }

  if (editing && !disabled) {
    return (
      <Input
        ref={inputRef}
        className="h-7 min-w-20 px-2"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void commit()
          if (event.key === 'Escape') setEditing(false)
        }}
        disabled={saving}
      />
    )
  }

  const content = amount.modified
    ? <ModifiedAmountCell display={amount.display} original={amount.original} />
    : <span>{amount.display}</span>

  return (
    <button
      type="button"
      className={cn(
        'w-full min-w-16 rounded px-1 py-0.5 text-left hover:bg-muted/60',
        !disabled && 'cursor-pointer',
      )}
      disabled={disabled}
      onClick={() => setEditing(true)}
    >
      {content}
    </button>
  )
}

function EditableRemarkCell({
  item,
  disabled,
  onUpdate,
}: {
  item: FinanceCheckTaskItem
  disabled?: boolean
  onUpdate: (update: FinanceCheckItemReviewUpdate) => Promise<FinanceCheckTaskItem>
}) {
  const remark = displayRemark(item)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(remark.editValue)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    setDraft(remark.editValue)
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing, remark.editValue])

  async function commit() {
    if (saving || disabled) return
    const nextRemark = buildReviewRemark(draft, item.remark)
    if (nextRemark === item.reviewRemark) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      await onUpdate({ reviewRemark: nextRemark })
      setEditing(false)
    } catch {
      // 错误由父组件处理
    } finally {
      setSaving(false)
    }
  }

  if (editing && !disabled) {
    return (
      <Input
        ref={inputRef}
        className="h-7 min-w-24 px-2"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void commit()
          if (event.key === 'Escape') setEditing(false)
        }}
        disabled={saving}
      />
    )
  }

  const content = remark.modified
    ? <ModifiedAmountCell display={remark.display} original={remark.original} />
    : <span className="truncate">{remark.display}</span>

  return (
    <button
      type="button"
      className={cn(
        'w-full max-w-45 truncate rounded px-1 py-0.5 text-left hover:bg-muted/60',
        !disabled && 'cursor-pointer',
      )}
      disabled={disabled}
      title={remark.modified ? undefined : (item.remark ?? undefined)}
      onClick={() => setEditing(true)}
    >
      {content}
    </button>
  )
}

function RejectRemarkDialog({
  item,
  onClose,
  onConfirm,
}: {
  item: FinanceCheckTaskItem | null
  onClose: () => void
  onConfirm: (remark: string) => Promise<void>
}) {
  const [remark, setRemark] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (item) setRemark(item.reviewRemark ?? item.remark ?? '')
  }, [item?.id])

  async function handleConfirm() {
    setSubmitting(true)
    try {
      await onConfirm(remark)
      onClose()
    } catch {
      // 错误由父组件处理
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => {
      if (!open) onClose()
    }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>审核不通过</DialogTitle>
          <DialogDescription>
            {item ? `第 ${item.rowNumber} 行 · ${item.couponCode ?? '无券码'}` : ''}
          </DialogDescription>
        </DialogHeader>
        <label className={fieldClass}>
          <span>备注</span>
          <Textarea
            value={remark}
            onChange={(event) => setRemark(event.target.value)}
            rows={3}
            placeholder="请输入不通过原因或备注"
          />
        </label>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>取消</Button>
          <Button type="button" variant="destructive" disabled={submitting} onClick={() => void handleConfirm()}>
            确认不通过
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FinanceCheckItemActions({
  item,
  disabled,
  onPass,
  onReject,
  onOpenJson,
}: {
  item: FinanceCheckTaskItem
  disabled?: boolean
  onPass: () => void
  onReject: () => void
  onOpenJson: (target: { title: string; details: Record<string, unknown> | null }) => void
}) {
  return (
    <div className={rowActionsClass}>
      <Button
        type="button"
        variant={item.reviewStatus === 'pass' ? 'default' : 'outline'}
        size="sm"
        disabled={disabled}
        onClick={onPass}
      >
        <Check size={14} />通过
      </Button>
      <Button
        type="button"
        variant={item.reviewStatus === 'fail' ? 'destructive' : 'outline'}
        size="sm"
        disabled={disabled}
        onClick={onReject}
      >
        <X size={14} />不通过
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(
            <Button type="button" variant="ghost" size="sm" disabled={disabled}>
              <MoreHorizontal size={14} />更多
            </Button>
          )}
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={!item.paymentCheckDetails}
            onClick={() => onOpenJson({ title: `第 ${item.rowNumber} 行 · 支付截图`, details: item.paymentCheckDetails })}
          >
            <ScanSearch size={14} />支付 JSON
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!item.merchantCheckDetails}
            onClick={() => onOpenJson({ title: `第 ${item.rowNumber} 行 · 商户截图`, details: item.merchantCheckDetails })}
          >
            <ScanSearch size={14} />商户 JSON
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function JsonModal({
  title,
  details,
  onClose,
}: {
  title: string
  details: Record<string, unknown> | null
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => {
      if (!open) onClose()
    }}>
      <DialogContent className="grid max-h-[min(88vh,820px)] w-[min(100%,980px)] max-w-[min(100%,980px)] grid-rows-[auto_minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <pre className="m-0 min-h-0 overflow-auto rounded-lg bg-neutral-950 p-4 font-mono text-xs leading-relaxed text-neutral-100">
          {JSON.stringify(details ?? {}, null, 2)}
        </pre>
      </DialogContent>
    </Dialog>
  )
}

function OcrSettings({
  modelRoot,
  variant,
  financeCheckRowConcurrency,
  ocrNodeMode,
  ocrNodePath,
  configPath,
  onModelRootChange,
  onVariantChange,
  onFinanceCheckRowConcurrencyChange,
  onOcrNodeModeChange,
  onOcrNodePathChange,
  onConfigChange,
  onModelInfoChange,
}: {
  modelRoot: string
  variant: OcrModelVariant
  financeCheckRowConcurrency: number
  ocrNodeMode: OcrNodeMode
  ocrNodePath: string
  configPath: string
  onModelRootChange: (value: string) => void
  onVariantChange: (value: OcrModelVariant) => void
  onFinanceCheckRowConcurrencyChange: (value: number) => void
  onOcrNodeModeChange: (value: OcrNodeMode) => void
  onOcrNodePathChange: (value: string) => void
  onConfigChange: (modelRoot: string, variant: OcrModelVariant, financeCheckRowConcurrency: number) => void
  onModelInfoChange: (value: OcrServerModelInfo) => void
}) {
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>('model')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [resultText, setResultText] = useState('')
  const [loading, setLoading] = useState(false)
  const [modelInfo, setModelInfo] = useState<OcrServerModelInfo | null>(null)
  const [modelStatusLoading, setModelStatusLoading] = useState(false)
  const [modelDownloading, setModelDownloading] = useState(false)
  const [openingConfigFolder, setOpeningConfigFolder] = useState(false)
  const [openingLogFolder, setOpeningLogFolder] = useState(false)
  const [clearingLogs, setClearingLogs] = useState(false)
  const [detectingSystemNode, setDetectingSystemNode] = useState(false)
  const [detectSystemNodeError, setDetectSystemNodeError] = useState('')
  const [error, setError] = useState('')
  const selectedModelOption = OCR_MODEL_OPTIONS.find((option) => option.value === variant) ?? OCR_MODEL_OPTIONS[0]
  const settingsTabs = useMemo(
    () => [
      { key: 'model' as const, label: '模型', icon: Cpu },
      { key: 'debug' as const, label: '调试', icon: Bug },
      { key: 'about' as const, label: '关于', icon: InfoIcon },
    ],
    [],
  )

  async function refreshModelInfo() {
    setModelStatusLoading(true)
    try {
      const info = await fetchServerModelInfo(variant)
      setModelInfo(info)
      onModelInfoChange(info)
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取模型状态失败')
    } finally {
      setModelStatusLoading(false)
    }
  }

  useEffect(() => {
    if (!selectedFile) {
      setPreviewUrl(null)
      return
    }
    const objectUrl = URL.createObjectURL(selectedFile)
    setPreviewUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [selectedFile])

  useEffect(() => {
    void refreshModelInfo()
  }, [variant])

  async function handleDownloadModel() {
    setModelDownloading(true)
    setError('')
    try {
      const info = await downloadServerModel(variant)
      setModelInfo(info)
      onModelInfoChange(info)
      onConfigChange(info.modelRoot, variant, financeCheckRowConcurrency)
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载模型失败')
    } finally {
      setModelDownloading(false)
    }
  }

  async function handleOpenConfigFolder() {
    setOpeningConfigFolder(true)
    setError('')
    try {
      await openConfigFolder()
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开配置文件夹失败')
    } finally {
      setOpeningConfigFolder(false)
    }
  }

  async function handleOpenLogFolder() {
    setOpeningLogFolder(true)
    setError('')
    try {
      await openLogFolder()
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开日志文件夹失败')
    } finally {
      setOpeningLogFolder(false)
    }
  }

  async function handleClearLogs() {
    if (!window.confirm('确定清空所有日志文件吗？')) {
      return
    }
    setClearingLogs(true)
    setError('')
    try {
      await clearErrorLogs()
    } catch (err) {
      setError(err instanceof Error ? err.message : '清空日志失败')
    } finally {
      setClearingLogs(false)
    }
  }

  async function handleRecognize() {
    if (!modelRoot.trim()) {
      setError('请先配置 paddleocr-js-onnx 路径')
      return
    }
    if (!selectedFile) {
      setError('请先选择图片')
      return
    }
    setLoading(true)
    setError('')
    setResultText('')
    try {
      const image = await loadImagePixels(selectedFile)
      const text = await recognizeImage({ modelRoot: modelRoot.trim(), variant, image })
      setResultText(text)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OCR 识别失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Tabs
      value={activeSettingsTab}
      onValueChange={(value) => setActiveSettingsTab(value as SettingsTab)}
      orientation="vertical"
      className="grid grid-cols-[180px_minmax(0,1fr)] items-start gap-5 max-lg:grid-cols-1"
    >
      <TabsList variant="line" className="w-full items-stretch max-lg:w-fit max-lg:max-w-full max-lg:overflow-x-auto" aria-label="设置分类">
        {settingsTabs.map((tab) => {
          const Icon = tab.icon
          return (
            <TabsTrigger key={tab.key} value={tab.key} className="min-h-9 px-2.5 max-lg:flex-1 max-lg:basis-24">
              <Icon size={16} />
              <span>{tab.label}</span>
            </TabsTrigger>
          )
        })}
      </TabsList>

      <div className="min-w-0">
        <TabsContent value="model" className={pageStackClass}>
          <Card>
            <CardHeader>
              <CardTitle>模型配置</CardTitle>
              {modelInfo && <CardDescription>模型目录：{modelInfo.modelDir}</CardDescription>}
              <CardAction>
                <Button type="button" variant="outline" onClick={() => void handleDownloadModel()} disabled={modelDownloading}>
                  <Download size={16} />{modelDownloading ? '下载中...' : modelInfo?.ready ? '重新下载当前模型' : '下载当前模型'}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className={cardStackClass}>
            <label className={fieldClass}>
              <span>paddleocr-js-onnx 路径</span>
              <Input value={modelRoot} onChange={(event) => onModelRootChange(event.target.value)} placeholder="/path/to/paddleocr-js-onnx" />
            </label>
            <div className={fieldClass}>
              <span>模型类型</span>
              <Select value={variant} onValueChange={(value) => onVariantChange(value as OcrModelVariant)}>
                <SelectTrigger className="h-auto min-h-10 w-full">
                  <SelectValue>
                    {(value: OcrModelVariant | null) => {
                      const option = OCR_MODEL_OPTIONS.find((item) => item.value === value) ?? selectedModelOption
                      return (
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium text-foreground">{option.label}</span>
                          {option.badge && <Badge variant="secondary" className="shrink-0">{option.badge}</Badge>}
                        </span>
                      )
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="start" className="min-w-80">
                  {OCR_MODEL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value} label={`${option.label} ${option.badge ?? ''}`} className="items-start py-2">
                      <span className="grid min-w-0 gap-1 whitespace-normal">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="font-medium text-foreground">{option.label}</span>
                          {option.badge && <Badge variant="secondary" className="shrink-0">{option.badge}</Badge>}
                        </span>
                        <span className="text-xs leading-snug text-muted-foreground">{option.description}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs leading-relaxed text-muted-foreground">{selectedModelOption.description}</span>
            </div>
            <label className={fieldClass}>
              <span>对账行并发数</span>
              <Input
                type="number"
                min={1}
                max={20}
                step={1}
                value={financeCheckRowConcurrency}
                onChange={(event) => onFinanceCheckRowConcurrencyChange(Number(event.target.value))}
              />
            </label>
            {modelInfo && (
              <div className="grid gap-2 rounded-lg border bg-muted p-3">
                {modelInfo.files.map((file) => (
                  <div key={file.fileName} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-xs">
                    <span className="truncate text-muted-foreground">{file.fileName}</span>
                    <strong className="font-semibold text-foreground">{file.exists ? formatBytes(file.size) : '未下载'}</strong>
                  </div>
                ))}
              </div>
            )}
            {!modelInfo && modelStatusLoading && <p className={mutedClass}>正在检测模型文件...</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Node.js 配置</CardTitle>
              <CardDescription>
                OCR 识别进程使用的 Node.js 运行时
              </CardDescription>
            </CardHeader>
            <CardContent className={cardStackClass}>
              <RadioGroup
                value={ocrNodeMode}
                onValueChange={(value) => onOcrNodeModeChange(value as OcrNodeMode)}
                className="grid gap-3 sm:grid-cols-2"
              >
                <label className="flex min-h-16 cursor-pointer items-start gap-3 rounded-lg border p-3">
                  <RadioGroupItem value="builtin" />
                  <span className="grid gap-1">
                    <strong className="text-sm font-medium">内置</strong>
                    <span className="text-xs text-muted-foreground">使用应用自带的 Node.js，无需额外安装</span>
                  </span>
                </label>
                <label className="flex min-h-16 cursor-pointer items-start gap-3 rounded-lg border p-3">
                  <RadioGroupItem value="custom" />
                  <span className="grid gap-1">
                    <strong className="text-sm font-medium">自定义</strong>
                    <span className="text-xs text-muted-foreground">指定系统已安装的 Node.js 可执行文件路径</span>
                  </span>
                </label>
              </RadioGroup>
              {ocrNodeMode === 'custom' && (
                <div className={cardStackClass}>
                  <label className={fieldClass}>
                    <span>Node.js 路径</span>
                    <Input
                      value={ocrNodePath}
                      onChange={(event) => {
                        setDetectSystemNodeError('')
                        onOcrNodePathChange(event.target.value)
                      }}
                      placeholder="/path/to/node"
                    />
                  </label>
                  <div className={actionsClass}>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={detectingSystemNode}
                      onClick={() => {
                        void (async () => {
                          setDetectingSystemNode(true)
                          setDetectSystemNodeError('')
                          try {
                            const result = await detectSystemNode()
                            if (result.found && result.nodePath) {
                              onOcrNodePathChange(result.nodePath)
                              return
                            }
                            setDetectSystemNodeError('未识别到系统安装的 Node.js')
                          } catch (err) {
                            setDetectSystemNodeError(err instanceof Error ? err.message : '识别系统 Node.js 失败')
                          } finally {
                            setDetectingSystemNode(false)
                          }
                        })()
                      }}
                    >
                      {detectingSystemNode ? '识别中...' : '识别系统 Node.js'}
                    </Button>
                  </div>
                  {detectSystemNodeError && <p className={errorTextClass}>{detectSystemNodeError}</p>}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="debug">
          <div className={pageStackClass}>
            <Card>
              <CardHeader>
                <CardTitle>上传图片识别</CardTitle>
              </CardHeader>
              <CardContent className={cardStackClass}>
              <label className={cn(buttonVariants({ variant: 'secondary' }), 'w-fit cursor-pointer')}>
                选择图片
                <input className="hidden" type="file" accept="image/*" onChange={(event) => {
                  setSelectedFile(event.target.files?.[0] ?? null)
                  setResultText('')
                  setError('')
              }} />
              </label>
              {selectedFile && <p className={mutedClass}>{selectedFile.name}</p>}
              {previewUrl && <img src={previewUrl} alt="预览" className="max-h-80 max-w-full rounded-lg border" />}
              <Button type="button" onClick={handleRecognize} disabled={loading || !selectedFile}>
                {loading ? '识别中...' : '开始识别'}
              </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>识别结果</CardTitle>
              </CardHeader>
              <CardContent className={cardStackClass}>
              {error && <p className={errorTextClass}>{error}</p>}
              <Textarea className="min-h-45 resize-y leading-relaxed" value={resultText} readOnly placeholder="识别结果会显示在这里" />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>配置文件</CardTitle>
                <CardDescription>{configPath || '~/.finance-checker/config.json'}</CardDescription>
                <CardAction>
                <Button type="button" variant="outline" onClick={() => void handleOpenConfigFolder()} disabled={openingConfigFolder}>
                  <FolderOpen size={16} />{openingConfigFolder ? '打开中...' : '打开配置文件夹'}
                </Button>
                </CardAction>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>日志文件</CardTitle>
                <CardDescription>~/.finance-checker/log/error.log</CardDescription>
                <CardAction>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" onClick={() => void handleOpenLogFolder()} disabled={openingLogFolder}>
                      <FolderOpen size={16} />{openingLogFolder ? '打开中...' : '显示日志文件'}
                    </Button>
                    <Button type="button" variant="outline" className="text-destructive hover:text-destructive" onClick={() => void handleClearLogs()} disabled={clearingLogs}>
                      <Trash2 size={16} />{clearingLogs ? '清空中...' : '清空日志'}
                    </Button>
                  </div>
                </CardAction>
              </CardHeader>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="about">
          <Card>
            <CardHeader>
              <CardTitle>关于</CardTitle>
            </CardHeader>
            <CardContent>
            <div className="grid max-w-md grid-cols-[120px_minmax(0,1fr)] items-center gap-3 py-3">
              <span className="text-xs text-muted-foreground">版本号</span>
              <strong className="text-sm font-semibold text-foreground">{formatAppVersion(appPackage.version)}</strong>
            </div>
            </CardContent>
          </Card>
        </TabsContent>
      </div>
    </Tabs>
  )
}

function FinanceCheckPage({
  modelRoot,
  variant,
  financeCheckRowConcurrency,
  modelInfo,
  onOpenSettings,
}: {
  modelRoot: string
  variant: OcrModelVariant
  financeCheckRowConcurrency: number
  modelInfo: OcrServerModelInfo | null
  onOpenSettings: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [tasks, setTasks] = useState<FinanceCheckTask[]>([])
  const [total, setTotal] = useState(0)
  const [statusFilter, setStatusFilter] = useState<FinanceCheckTaskStatus | 'all'>('all')
  const [showArchived, setShowArchived] = useState(false)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [error, setError] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [batchArchiving, setBatchArchiving] = useState(false)
  const [cancellingTaskIds, setCancellingTaskIds] = useState<Set<string>>(() => new Set())
  const [nowMs, setNowMs] = useState(() => Date.now())
  const dragCountRef = useRef(0)
  const pageSize = 10
  const shouldPromptForModel =
    !modelRoot.trim() || (variant === 'v5_server' && modelInfo?.modelRoot === modelRoot.trim() && !modelInfo.ready)

  function canSelectTask(task: FinanceCheckTask) {
    return task.taskStatus !== 'pending' && task.taskStatus !== 'running'
  }

  function canArchiveTask(task: FinanceCheckTask) {
    return canSelectTask(task) && !task.archived
  }

  async function refresh() {
    setLoading(true)
    setError('')
    try {
      const data = await fetchFinanceCheckTasks({
        page,
        pageSize,
        taskStatus: statusFilter === 'all' ? undefined : statusFilter,
        includeArchived: showArchived,
      })
      setTasks(data.items)
      setTotal(data.total)
      setSelectedIds((prev) => {
        if (prev.size === 0) return prev
        const nextIds = new Set(data.items.filter((task) => prev.has(task.id) && canSelectTask(task)).map((task) => task.id))
        return nextIds.size === prev.size && [...nextIds].every((id) => prev.has(id)) ? prev : nextIds
      })
      setCancellingTaskIds((prev) => {
        if (prev.size === 0) return prev
        const next = new Set(prev)
        for (const task of data.items) {
          if (next.has(task.id) && task.taskStatus !== 'pending' && task.taskStatus !== 'running') {
            next.delete(task.id)
          }
        }
        return next.size === prev.size ? prev : next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载任务失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setSelectedIds(new Set())
    void refresh()
  }, [page, statusFilter, showArchived])

  useEffect(() => {
    const hasActive = tasks.some((task) => task.taskStatus === 'pending' || task.taskStatus === 'running')
      || cancellingTaskIds.size > 0
    if (!hasActive) return
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [tasks, page, statusFilter, showArchived, cancellingTaskIds])

  useEffect(() => {
    const hasActive = tasks.some((task) => task.taskStatus === 'pending' || task.taskStatus === 'running')
    if (!hasActive) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [tasks])

  async function uploadFile(file: File | null) {
    if (!file) return
    if (shouldPromptForModel) {
      setError('请先到设置下载 OCR 模型')
      return
    }
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setError('仅支持 .xlsx 文件')
      return
    }
    setUploading(true)
    setError('')
    try {
      await uploadFinanceCheckTask({
        file,
        modelRoot: modelRoot.trim(),
        variant,
        rowConcurrency: financeCheckRowConcurrency,
      })
      setPage(1)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建任务失败')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleOpenSourceFile(taskId: string) {
    setError('')
    try {
      await openFinanceCheckSourceFile(taskId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开原文件失败')
    }
  }

  async function handleCancelTask(taskId: string) {
    setCancellingTaskIds((prev) => new Set(prev).add(taskId))
    setError('')
    try {
      await cancelFinanceCheckTask(taskId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '取消任务失败')
      setCancellingTaskIds((prev) => {
        const next = new Set(prev)
        next.delete(taskId)
        return next
      })
    }
  }

  async function handleToggleArchive(task: FinanceCheckTask) {
    setError('')
    try {
      if (task.archived) {
        await unarchiveFinanceCheckTask(task.id)
      } else {
        await archiveFinanceCheckTask(task.id)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : task.archived ? '取消归档失败' : '归档失败')
    }
  }

  async function handleBatchArchive() {
    const targets = tasks.filter((task) => selectedIds.has(task.id) && canArchiveTask(task))
    if (targets.length === 0) return
    setBatchArchiving(true)
    setError('')
    try {
      const results = await Promise.allSettled(targets.map((task) => archiveFinanceCheckTask(task.id)))
      const failed = results.filter((result) => result.status === 'rejected').length
      setSelectedIds(new Set())
      await refresh()
      if (failed > 0) {
        setError(`有 ${failed} 条任务归档失败`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量归档失败')
    } finally {
      setBatchArchiving(false)
    }
  }

  function toggleTaskSelected(taskId: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(taskId)
      else next.delete(taskId)
      return next
    })
  }

  function toggleSelectAll(checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const task of tasks) {
        if (!canSelectTask(task)) continue
        if (checked) next.add(task.id)
        else next.delete(task.id)
      }
      return next
    })
  }

  function clearCancellingTask(taskId: string) {
    setCancellingTaskIds((prev) => {
      if (!prev.has(taskId)) return prev
      const next = new Set(prev)
      next.delete(taskId)
      return next
    })
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (shouldPromptForModel) return
    if (!event.dataTransfer.types.includes('Files')) return
    dragCountRef.current += 1
    setIsDragOver(true)
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    dragCountRef.current -= 1
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0
      setIsDragOver(false)
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (shouldPromptForModel) return
    dragCountRef.current = 0
    setIsDragOver(false)
    void uploadFile(event.dataTransfer.files?.[0] ?? null)
  }

  if (selectedTaskId) {
    return <FinanceCheckDetail
      taskId={selectedTaskId}
      cancelling={cancellingTaskIds.has(selectedTaskId)}
      onCancel={() => void handleCancelTask(selectedTaskId)}
      onCancellingResolved={() => clearCancellingTask(selectedTaskId)}
      onBack={() => {
        setSelectedTaskId(null)
        void refresh()
      }}
    />
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const selectableTasks = tasks.filter(canSelectTask)
  const selectedCount = selectableTasks.filter((task) => selectedIds.has(task.id)).length
  const allSelectableSelected = selectableTasks.length > 0 && selectedCount === selectableTasks.length
  const someSelectableSelected = selectedCount > 0 && !allSelectableSelected
  const batchArchiveTargets = tasks.filter((task) => selectedIds.has(task.id) && canArchiveTask(task))

  return (
    <div className={pageStackClass}>
      <Card>
        <CardHeader>
          <CardTitle>对账任务</CardTitle>
          <CardDescription>共 {loading ? '-' : total} 条{(tasks.some((task) => task.taskStatus === 'pending' || task.taskStatus === 'running') || cancellingTaskIds.size > 0) ? ' · 执行中任务将自动刷新' : ''}</CardDescription>
          <CardAction>
          <div className={actionsClass}>
            <input ref={fileInputRef} type="file" accept=".xlsx" hidden disabled={shouldPromptForModel} onChange={(event) => void uploadFile(event.target.files?.[0] ?? null)} />
            <Button type="button" disabled={uploading || shouldPromptForModel} onClick={() => fileInputRef.current?.click()}>
              <Upload size={16} /> {uploading ? '提交中...' : '上传表格'}
            </Button>
            <NativeSelect value={statusFilter} onChange={(event) => {
              setStatusFilter(event.target.value as FinanceCheckTaskStatus | 'all')
              setPage(1)
            }}>
              {STATUS_OPTIONS.map((option) => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}
            </NativeSelect>
            <Label className="flex items-center gap-2 font-normal text-muted-foreground">
              <Switch
                checked={showArchived}
                onCheckedChange={(checked) => {
                  setShowArchived(checked)
                  setPage(1)
                }}
              />
              显示归档
            </Label>
            <Button type="button" variant="outline" onClick={() => void refresh()}><RefreshCw size={16} />刷新</Button>
            <a className={buttonVariants({ variant: 'outline' })} href={FINANCE_CHECK_EXAMPLE_XLSX_URL} download="example.xlsx"><Download size={16} />下载示例表格</a>
          </div>
          </CardAction>
        </CardHeader>
        <CardContent className={cardStackClass}>
        {shouldPromptForModel && (
          <Alert className="min-h-14 items-center max-sm:items-start">
            <InfoIcon size={16} />
            <AlertTitle>请先下载 OCR 模型</AlertTitle>
            <AlertDescription>对账需要本地 v5_server 模型文件。请前往设置下载模型，下载完成后会自动保存配置。</AlertDescription>
            <AlertAction>
              <Button type="button" size="sm" onClick={onOpenSettings}>去设置</Button>
            </AlertAction>
          </Alert>
        )}
        <div
          role="button"
          tabIndex={0}
          className={cn(
            'flex min-h-23 cursor-pointer items-center gap-3.5 rounded-lg border border-dashed bg-muted p-4 transition-[background,border-color,box-shadow,opacity]',
            'hover:border-ring hover:bg-accent hover:shadow-[0_0_0_3px_color-mix(in_oklch,var(--ring),transparent_78%)] max-sm:items-start',
            isDragOver && 'border-ring bg-accent shadow-[0_0_0_3px_color-mix(in_oklch,var(--ring),transparent_78%)]',
            uploading && 'cursor-wait opacity-80',
            shouldPromptForModel && 'cursor-not-allowed opacity-60 hover:border-border hover:bg-muted hover:shadow-none',
          )}
          onClick={() => {
            if (shouldPromptForModel) return
            fileInputRef.current?.click()
          }}
          onKeyDown={(event) => {
            if (shouldPromptForModel) return
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              fileInputRef.current?.click()
            }
          }}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          <div className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg bg-background text-primary shadow-[inset_0_0_0_1px_var(--border)]"><FileSpreadsheet size={22} /></div>
          <div>
            <p className="mb-1 text-sm font-semibold text-foreground">{uploading ? '正在提交并校验文件...' : '点击选择 Excel，或拖拽文件到此处'}</p>
            <span className="text-xs text-muted-foreground">仅支持 .xlsx，任务会在后台执行并自动刷新</span>
          </div>
        </div>
        {error && <p className={errorTextClass}>{error}</p>}
        {selectedCount > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2">
            <span className={mutedClass}>已选 {selectedCount} 条</span>
            <Button
              type="button"
              size="sm"
              disabled={batchArchiving || batchArchiveTargets.length === 0}
              onClick={() => void handleBatchArchive()}
            >
              <Archive size={14} />
              {batchArchiving ? '归档中...' : `归档${batchArchiveTargets.length > 0 ? ` (${batchArchiveTargets.length})` : ''}`}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={batchArchiving} onClick={() => setSelectedIds(new Set())}>
              取消选择
            </Button>
          </div>
        )}
        <div className={tableWrapClass}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelectableSelected}
                    indeterminate={someSelectableSelected}
                    disabled={selectableTasks.length === 0}
                    onCheckedChange={(checked) => toggleSelectAll(checked)}
                    aria-label="全选当前页"
                  />
                </TableHead>
                <TableHead>文件名</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>错误信息</TableHead>
                <TableHead>进度 / 汇总</TableHead>
                <TableHead>耗时</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => {
                const isCancelling = cancellingTaskIds.has(task.id)
                const selectable = canSelectTask(task)
                return (
                <TableRow key={task.id} data-state={selectedIds.has(task.id) ? 'selected' : undefined}>
                  <TableCell>
                    <Checkbox
                      checked={selectedIds.has(task.id)}
                      disabled={!selectable}
                      onCheckedChange={(checked) => toggleTaskSelected(task.id, checked)}
                      aria-label={`选择 ${task.sourceFileName}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex max-w-80 items-center gap-2">
                      <Button type="button" variant="link" className="h-auto min-h-0 flex-1 justify-start truncate p-0" onClick={() => setSelectedTaskId(task.id)}>{task.sourceFileName}</Button>
                      {task.archived && <Badge variant="secondary">已归档</Badge>}
                    </div>
                  </TableCell>
                  <TableCell><StatusBadge status={isCancelling ? 'cancelling' : task.taskStatus} /></TableCell>
                  <TableCell className="w-55 max-w-55"><ErrorMessageCell message={task.errorMessage} /></TableCell>
                  <TableCell><TaskProgress task={task} cancelling={isCancelling} />{task.taskStatus === 'succeeded' && <SummaryText task={task} />}</TableCell>
                  <TableCell>{formatTaskDuration(task, nowMs)}</TableCell>
                  <TableCell>{formatOcrModelVariant(task.modelVariant)}</TableCell>
                  <TableCell>{formatTime(task.createdAt)}</TableCell>
                  <TableCell>
                    <div className={rowActionsClass}>
                      {/* <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button> */}
                      <Button type="button" variant="ghost" size="sm" onClick={() => void handleOpenSourceFile(task.id)}><FolderOpen size={14} />原文件</Button>
                      {task.taskStatus === 'succeeded' && task.resultDownloadUrl && <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={task.resultDownloadUrl}><Download size={14} />下载</a>}
                      {(task.taskStatus === 'pending' || task.taskStatus === 'running') && !isCancelling
                        ? (
                            <Button type="button" variant="ghost" size="sm" className={dangerClass} onClick={() => void handleCancelTask(task.id)}>
                              <XCircle size={14} />取消
                            </Button>
                          )
                        : (task.taskStatus !== 'pending' && task.taskStatus !== 'running')
                          ? (
                              <>
                                <Button type="button" variant="ghost" size="sm" onClick={() => void handleToggleArchive(task)}>
                                  {task.archived ? <><ArchiveRestore size={14} />取消归档</> : <><Archive size={14} />归档</>}
                                </Button>
                                <Button type="button" variant="ghost" size="sm" className={dangerClass} onClick={async () => { if (window.confirm(`确定删除「${task.sourceFileName}」吗？`)) { await deleteFinanceCheckTask(task.id); await refresh() } }}><Trash2 size={14} />删除</Button>
                              </>
                            )
                          : null}
                    </div>
                  </TableCell>
                </TableRow>
                )
              })}
              {!loading && tasks.length === 0 && <TableRow><TableCell colSpan={9} className={emptyCellClass}>暂无对账任务，点击“上传表格”开始</TableCell></TableRow>}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-end gap-2">
          <span className={mutedClass}>第 {page}/{pageCount} 页</span>
          <Button type="button" variant="outline" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</Button>
          <Button type="button" variant="outline" disabled={page >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>下一页</Button>
        </div>
        </CardContent>
      </Card>
    </div>
  )
}

function FinanceCheckReconcileView({
  taskId,
  task,
  onBack,
  onItemsUpdated,
}: {
  taskId: string
  task: FinanceCheckTask
  onBack: () => void
  onItemsUpdated: () => void
}) {
  const [items, setItems] = useState<FinanceCheckTaskItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [draftPaid, setDraftPaid] = useState('')
  const [draftMerchant, setDraftMerchant] = useState('')
  const [draftRemark, setDraftRemark] = useState('')
  const [saving, setSaving] = useState(false)
  const [bulkApproving, setBulkApproving] = useState(false)
  const [error, setError] = useState('')
  const [imageTarget, setImageTarget] = useState<{ title: string; url: string } | null>(null)

  const selectedItem = items[selectedIndex] ?? null
  const aiPassPendingCount = items.filter((item) => item.overallStatus === 'pass' && item.reviewStatus !== 'pass').length

  useEffect(() => {
    let cancelled = false
    async function loadItems() {
      setLoading(true)
      setError('')
      try {
        const first = await fetchFinanceCheckTaskItems(taskId, { page: 1, pageSize: 1 })
        const all = await fetchFinanceCheckTaskItems(taskId, {
          page: 1,
          pageSize: Math.max(first.total, 1),
        })
        if (cancelled) return
        setItems([...all.items].sort((a, b) => a.rowNumber - b.rowNumber))
        setSelectedIndex(0)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载明细失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void loadItems()
    return () => {
      cancelled = true
    }
  }, [taskId])

  useEffect(() => {
    if (!selectedItem) return
    setDraftPaid(selectedItem.adjustedPaidAmount ?? selectedItem.expectedPaidAmount ?? '')
    setDraftMerchant(selectedItem.adjustedMerchantAmount ?? selectedItem.expectedMerchantAmount ?? '')
    setDraftRemark(selectedItem.reviewRemark ?? '')
  }, [selectedItem?.id])

  function buildReviewUpdate(reviewStatus?: FinanceCheckReviewStatus | null): FinanceCheckItemReviewUpdate {
    if (!selectedItem) return {}
    return {
      adjustedPaidAmount: buildAdjustedAmount(draftPaid, selectedItem.expectedPaidAmount),
      adjustedMerchantAmount: buildAdjustedAmount(draftMerchant, selectedItem.expectedMerchantAmount),
      reviewRemark: draftRemark.trim() || null,
      ...(reviewStatus !== undefined ? { reviewStatus } : {}),
    }
  }

  async function saveCurrentItem(reviewStatus?: FinanceCheckReviewStatus | null): Promise<boolean> {
    if (!selectedItem) return false
    setSaving(true)
    setError('')
    try {
      const updated = await updateFinanceCheckTaskItem(taskId, selectedItem.id, buildReviewUpdate(reviewStatus))
      setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
      onItemsUpdated()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
      return false
    } finally {
      setSaving(false)
    }
  }

  async function navigateTo(index: number) {
    if (index === selectedIndex || index < 0 || index >= items.length) return
    const saved = await saveCurrentItem()
    if (!saved) return
    setSelectedIndex(index)
  }

  async function handleReview(status: FinanceCheckReviewStatus) {
    const saved = await saveCurrentItem(status)
    if (!saved) return
    if (selectedIndex < items.length - 1) {
      setSelectedIndex((value) => value + 1)
    }
  }

  async function approveAllAiPassed() {
    if (aiPassPendingCount <= 0) return
    if (!window.confirm(`确定将 ${aiPassPendingCount} 条 AI 审核通过的记录标记为人工通过吗？`)) return
    const saved = await saveCurrentItem()
    if (!saved) return
    setBulkApproving(true)
    setError('')
    try {
      const targets = items.filter((item) => item.overallStatus === 'pass' && item.reviewStatus !== 'pass')
      for (const item of targets) {
        const updated = await updateFinanceCheckTaskItem(taskId, item.id, { reviewStatus: 'pass' })
        setItems((prev) => prev.map((entry) => (entry.id === updated.id ? updated : entry)))
      }
      onItemsUpdated()
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量通过失败')
    } finally {
      setBulkApproving(false)
    }
  }

  const paymentImageUrl = selectedItem ? detailImageUrl(taskId, selectedItem.paymentCheckDetails) : null
  const merchantImageUrl = selectedItem ? detailImageUrl(taskId, selectedItem.merchantCheckDetails) : null

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" size="icon" onClick={onBack} aria-label="返回详情">
            <ArrowLeft size={18} />
          </Button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">{task.sourceFileName} · 人工对账</h2>
            <p className="text-xs text-muted-foreground">
              {items.length > 0 ? `第 ${selectedIndex + 1} / ${items.length} 条` : '暂无明细'}
            </p>
          </div>
          {!loading && items.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={bulkApproving || saving || aiPassPendingCount <= 0}
              onClick={() => void approveAllAiPassed()}
            >
              <Check size={14} />
              通过所有 AI 审核通过的记录
              {aiPassPendingCount > 0 ? `（${aiPassPendingCount}）` : ''}
            </Button>
          )}
        </div>

        {error && <p className={errorTextClass}>{error}</p>}

        {loading ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground">加载明细中...</CardContent></Card>
        ) : items.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground">暂无明细数据</CardContent></Card>
        ) : (
          <div className="flex min-h-[calc(100vh-140px)] gap-3 max-lg:flex-col">
            <Card className="w-80 shrink-0 max-lg:w-full">
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">明细列表</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="max-h-[calc(100vh-180px)] overflow-y-auto border-t">
                  {items.map((item, index) => {
                    const paid = displayAmount(item, 'paid')
                    const merchant = displayAmount(item, 'merchant')
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={cn(
                          'flex w-full flex-col gap-1 border-b px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted/50',
                          index === selectedIndex && 'bg-muted',
                        )}
                        onClick={() => void navigateTo(index)}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <span className="font-medium">第 {item.rowNumber} 行</span>
                          <div className="flex flex-col items-end gap-2.5">
                            {item.reviewStatus && <ManualReviewTag status={item.reviewStatus} />}
                            <span className={cn('text-[10px] leading-none', aiReviewStatusClass(item.overallStatus))}>
                              {aiReviewStatusLabel(item.overallStatus)}
                            </span>
                          </div>
                        </div>
                        <span className="truncate text-muted-foreground">{item.couponCode ?? '-'}</span>
                        <span className="text-xs text-muted-foreground">
                          实付 {paid.display} · 实收 {merchant.display}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </CardContent>
            </Card>

            <Card className="flex min-w-0 flex-1 flex-col">
              <CardContent className="flex flex-1 flex-col gap-3 p-4">
                {selectedItem && (
                  <>
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                      <label className={fieldClass}>
                        <span>核销券码</span>
                        <p className="truncate rounded-md border bg-muted/40 px-3 py-2 text-sm">{selectedItem.couponCode ?? '-'}</p>
                      </label>
                      <label className={fieldClass}>
                        <span>推单实付金额</span>
                        <Input
                          className="h-9"
                          value={draftPaid}
                          onChange={(event) => setDraftPaid(event.target.value)}
                          placeholder={selectedItem.expectedPaidAmount ?? ''}
                        />
                      </label>
                      <label className={fieldClass}>
                        <span>商家实收</span>
                        <Input
                          className="h-9"
                          value={draftMerchant}
                          onChange={(event) => setDraftMerchant(event.target.value)}
                          placeholder={selectedItem.expectedMerchantAmount ?? ''}
                        />
                      </label>
                      <label className={fieldClass}>
                        <span>备注</span>
                        <Input
                          className="h-9"
                          value={draftRemark}
                          onChange={(event) => setDraftRemark(event.target.value)}
                          placeholder="人工对账备注"
                        />
                      </label>
                    </div>

                    <div className="grid min-h-0 flex-1 grid-cols-2 gap-4 max-md:grid-cols-1">
                      <div className={fieldClass}>
                        <span>实付券码截图</span>
                        {paymentImageUrl ? (
                          <button
                            type="button"
                            className="flex min-h-48 items-center justify-center overflow-hidden rounded-lg border bg-muted/30 transition hover:bg-muted/50"
                            onClick={() => setImageTarget({ title: `第 ${selectedItem.rowNumber} 行 · 实付券码`, url: paymentImageUrl })}
                          >
                            <img src={paymentImageUrl} alt="实付券码截图" className="max-h-64 max-w-full object-contain" />
                          </button>
                        ) : (
                          <div className="flex min-h-48 items-center justify-center rounded-lg border bg-muted/20 text-muted-foreground">暂无图片</div>
                        )}
                      </div>
                      <div className={fieldClass}>
                        <span>商家实收截图</span>
                        {merchantImageUrl ? (
                          <button
                            type="button"
                            className="flex min-h-48 items-center justify-center overflow-hidden rounded-lg border bg-muted/30 transition hover:bg-muted/50"
                            onClick={() => setImageTarget({ title: `第 ${selectedItem.rowNumber} 行 · 商家实收`, url: merchantImageUrl })}
                          >
                            <img src={merchantImageUrl} alt="商家实收截图" className="max-h-64 max-w-full object-contain" />
                          </button>
                        ) : (
                          <div className="flex min-h-48 items-center justify-center rounded-lg border bg-muted/20 text-muted-foreground">暂无图片</div>
                        )}
                      </div>
                    </div>

                    <div className={actionsClass}>
                      <Button type="button" variant="outline" disabled={selectedIndex <= 0 || saving || bulkApproving} onClick={() => void navigateTo(selectedIndex - 1)}>
                        <ChevronLeft size={16} />上一条
                      </Button>
                      <Button type="button" variant="outline" disabled={selectedIndex >= items.length - 1 || saving || bulkApproving} onClick={() => void navigateTo(selectedIndex + 1)}>
                        下一条<ChevronRight size={16} />
                      </Button>
                      <Button type="button" disabled={saving || bulkApproving} onClick={() => void handleReview('pass')}>
                        <Check size={16} />审核通过
                      </Button>
                      <Button type="button" variant="destructive" disabled={saving || bulkApproving} onClick={() => void handleReview('fail')}>
                        <X size={16} />审核不通过
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        <Lightbox
          open={Boolean(imageTarget)}
          close={() => setImageTarget(null)}
          slides={imageTarget ? [{ src: imageTarget.url }] : []}
          plugins={[Zoom]}
          carousel={{ finite: true }}
          controller={{ closeOnBackdropClick: true }}
          styles={{ root: { '--yarl__color_backdrop': 'rgba(0, 0, 0, 0.45)' } }}
          zoom={{ maxZoomPixelRatio: 6, scrollToZoom: true }}
        />
      </div>
    </TooltipProvider>
  )
}

function FinanceCheckDetail({ taskId, onBack, onCancel, onCancellingResolved, cancelling }: { taskId: string; onBack: () => void; onCancel: () => void; onCancellingResolved: () => void; cancelling: boolean }) {
  const [reconcileMode, setReconcileMode] = useState(false)
  const [task, setTask] = useState<FinanceCheckTask | null>(null)
  const [items, setItems] = useState<FinanceCheckTaskItem[]>([])
  const [itemTotal, setItemTotal] = useState(0)
  const [itemPage, setItemPage] = useState(1)
  const [itemStatusFilter, setItemStatusFilter] = useState<FinanceCheckResultStatus | 'all'>('all')
  const [jsonTarget, setJsonTarget] = useState<{ title: string; details: Record<string, unknown> | null } | null>(null)
  const [rejectTarget, setRejectTarget] = useState<FinanceCheckTaskItem | null>(null)
  const [imageTarget, setImageTarget] = useState<{ title: string; url: string } | null>(null)
  const [error, setError] = useState('')
  const [nowMs, setNowMs] = useState(() => Date.now())
  const itemPageSize = 50
  const canEditItems = task != null && task.taskStatus !== 'pending' && task.taskStatus !== 'running'

  async function handleUpdateItem(itemId: string, update: FinanceCheckItemReviewUpdate): Promise<FinanceCheckTaskItem> {
    setError('')
    try {
      const updated = await updateFinanceCheckTaskItem(taskId, itemId, update)
      setItems((prev) => prev.map((entry) => (entry.id === itemId ? updated : entry)))
      return updated
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存失败'
      setError(message)
      throw err
    }
  }

  async function handlePassItem(item: FinanceCheckTaskItem) {
    await handleUpdateItem(item.id, { reviewStatus: 'pass' })
  }

  async function handleRejectItem(item: FinanceCheckTaskItem, remark: string) {
    await handleUpdateItem(item.id, {
      reviewStatus: 'fail',
      reviewRemark: buildReviewRemark(remark, item.remark),
    })
  }

  async function refresh() {
    try {
      const [nextTask, nextItems] = await Promise.all([
        fetchFinanceCheckTask(taskId),
        fetchFinanceCheckTaskItems(taskId, {
          page: itemPage,
          pageSize: itemPageSize,
          overallStatus: itemStatusFilter === 'all' ? undefined : itemStatusFilter,
        }),
      ])
      setTask(nextTask)
      setItems(nextItems.items)
      setItemTotal(nextItems.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载详情失败')
    }
  }

  useEffect(() => {
    void refresh()
  }, [taskId, itemPage, itemStatusFilter])

  useEffect(() => {
    if (!cancelling && task?.taskStatus !== 'pending' && task?.taskStatus !== 'running') return
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [task?.taskStatus, cancelling, taskId, itemPage, itemStatusFilter])

  useEffect(() => {
    if (!cancelling || !task) return
    if (task.taskStatus !== 'pending' && task.taskStatus !== 'running') {
      onCancellingResolved()
    }
  }, [cancelling, onCancellingResolved, task?.taskStatus])

  useEffect(() => {
    if (!cancelling && task?.taskStatus !== 'pending' && task?.taskStatus !== 'running') return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [cancelling, task?.taskStatus])

  const pageCount = Math.max(1, Math.ceil(itemTotal / itemPageSize))

  async function handleOpenSourceFile() {
    setError('')
    try {
      await openFinanceCheckSourceFile(taskId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开原文件失败')
    }
  }

  const canStartReconcile = task && task.taskStatus !== 'pending' && task.taskStatus !== 'running' && itemTotal > 0

  if (reconcileMode && task) {
    return (
      <FinanceCheckReconcileView
        taskId={taskId}
        task={task}
        onBack={() => {
          setReconcileMode(false)
          void refresh()
        }}
        onItemsUpdated={() => void refresh()}
      />
    )
  }

  return (
    <TooltipProvider>
    <div className={pageStackClass}>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="icon" onClick={onBack} aria-label="返回"><ArrowLeft size={18} /></Button>
            <div>
              <CardTitle>{task?.sourceFileName ?? '对账任务详情'}</CardTitle>
              {task && <div className="mt-2 flex items-center gap-2"><StatusBadge status={cancelling ? 'cancelling' : task.taskStatus} />{task.archived && <Badge variant="secondary">已归档</Badge>}</div>}
            </div>
          </div>
          <CardAction>
          <div className={actionsClass}>
            {canStartReconcile && (
              <Button type="button" onClick={() => setReconcileMode(true)}>
                <ClipboardCheck size={16} />开始对账
              </Button>
            )}
            {task && <Button type="button" variant="outline" onClick={() => void handleOpenSourceFile()}><FolderOpen size={16} />查看原文件</Button>}
            {task?.resultDownloadUrl && <a className={buttonVariants({ variant: 'outline' })} href={task.resultDownloadUrl}><Download size={16} />下载结果</a>}
            {task && (task.taskStatus === 'pending' || task.taskStatus === 'running') && !cancelling && (
              <Button type="button" variant="outline" className={dangerClass} onClick={onCancel}>
                <XCircle size={16} />取消任务
              </Button>
            )}
            {task && task.taskStatus !== 'pending' && task.taskStatus !== 'running' && (
              <Button
                type="button"
                variant="outline"
                onClick={async () => {
                  setError('')
                  try {
                    if (task.archived) {
                      await unarchiveFinanceCheckTask(taskId)
                    } else {
                      await archiveFinanceCheckTask(taskId)
                    }
                    await refresh()
                  } catch (err) {
                    setError(err instanceof Error ? err.message : task.archived ? '取消归档失败' : '归档失败')
                  }
                }}
              >
                {task.archived ? <><ArchiveRestore size={16} />取消归档</> : <><Archive size={16} />归档</>}
              </Button>
            )}
            {task && task.taskStatus !== 'pending' && task.taskStatus !== 'running' && <Button type="button" variant="outline" className={dangerClass} onClick={async () => { if (window.confirm(`确定删除「${task.sourceFileName}」吗？`)) { await deleteFinanceCheckTask(taskId); onBack() } }}><Trash2 size={16} />删除任务</Button>}
            <Button type="button" variant="outline" onClick={() => void refresh()}><RefreshCw size={16} />刷新</Button>
          </div>
          </CardAction>
        </CardHeader>
        <CardContent className={cardStackClass}>
        {error && <p className={errorTextClass}>{error}</p>}
        {task && (
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm max-lg:grid-cols-1">
            <Info label="原始文件" value={task.sourceFileName} />
            <Info label="原始文件路径" value={task.sourcePath} />
            <Info label="结果文件" value={task.resultFileName ?? '-'} />
            <Info label="模型" value={formatOcrModelVariant(task.modelVariant)} />
            <Info label="创建时间" value={formatTime(task.createdAt)} />
            <Info label="完成时间" value={formatTime(task.finishedAt)} />
            <Info label="耗时" value={formatTaskDuration(task, nowMs)} />
            <Info label="行并发数" value={String(task.rowConcurrency)} />
            <Info label="对账汇总" value={task.summary ? formatCheckSummary(task.summary) : '-'} />
          </div>
        )}
        {task && <TaskProgress task={task} cancelling={cancelling} />}
        {task?.errorMessage && <p className={errorTextClass}>{task.errorMessage}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>明细</CardTitle>
          <CardDescription>共 {itemTotal} 条{pageCount > 1 ? ` · 第 ${itemPage}/${pageCount} 页` : ''}</CardDescription>
          <CardAction>
          <NativeSelect value={itemStatusFilter} onChange={(event) => {
            setItemStatusFilter(event.target.value as FinanceCheckResultStatus | 'all')
            setItemPage(1)
          }}>
            {ITEM_STATUS_OPTIONS.map((option) => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}
          </NativeSelect>
          </CardAction>
        </CardHeader>
        <CardContent className={cardStackClass}>
        <div className={tableWrapClass}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>行号</TableHead>
                <TableHead>核销券码</TableHead>
                <TableHead>推单实付金额</TableHead>
                <TableHead>实付券码</TableHead>
                <TableHead>AI识别实付</TableHead>
                <TableHead>商家实收</TableHead>
                <TableHead>商家实收图</TableHead>
                <TableHead>AI识别实收</TableHead>
                <TableHead>城市</TableHead>
                <TableHead>商户</TableHead>
                <TableHead>备注</TableHead>
                <TableHead>结果</TableHead>
                <TableHead>AI审核</TableHead>
                <TableHead>支付对账</TableHead>
                <TableHead>商户对账</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const paymentImageUrl = detailImageUrl(taskId, item.paymentCheckDetails)
                const merchantImageUrl = detailImageUrl(taskId, item.merchantCheckDetails)
                return (
                  <TableRow key={item.id}>
                    <TableCell>{item.rowNumber}</TableCell>
                    <TableCell>{item.couponCode ?? '-'}</TableCell>
                    <TableCell>
                      <EditableAmountCell
                        item={item}
                        field="paid"
                        disabled={!canEditItems}
                        onUpdate={(update) => handleUpdateItem(item.id, update)}
                      />
                    </TableCell>
                    <TableCell>
                      <ImageViewButton
                        title={`第 ${item.rowNumber} 行 · 实付券码`}
                        imageUrl={paymentImageUrl}
                        onOpen={setImageTarget}
                      />
                    </TableCell>
                    <TableCell>{item.paymentActual ?? '-'}</TableCell>
                    <TableCell>
                      <EditableAmountCell
                        item={item}
                        field="merchant"
                        disabled={!canEditItems}
                        onUpdate={(update) => handleUpdateItem(item.id, update)}
                      />
                    </TableCell>
                    <TableCell>
                      <ImageViewButton
                        title={`第 ${item.rowNumber} 行 · 商家实收图`}
                        imageUrl={merchantImageUrl}
                        onOpen={setImageTarget}
                      />
                    </TableCell>
                    <TableCell>{item.merchantActual ?? '-'}</TableCell>
                    <TableCell>{item.city ?? '-'}</TableCell>
                    <TableCell className="max-w-45 truncate" title={item.merchantName ?? undefined}>{item.merchantName ?? '-'}</TableCell>
                    <TableCell>
                      <EditableRemarkCell
                        item={item}
                        disabled={!canEditItems}
                        onUpdate={(update) => handleUpdateItem(item.id, update)}
                      />
                    </TableCell>
                    <TableCell>
                      {item.reviewStatus
                        ? <StatusBadge status={item.reviewStatus} />
                        : <span className={mutedClass}>-</span>}
                    </TableCell>
                    <TableCell><StatusBadge status={item.overallStatus} /></TableCell>
                    <TableCell className="max-w-55 text-xs text-muted-foreground whitespace-normal">{item.paymentMessage ?? '-'}</TableCell>
                    <TableCell className="max-w-55 text-xs text-muted-foreground whitespace-normal">{item.merchantMessage ?? '-'}</TableCell>
                    <TableCell>
                      <FinanceCheckItemActions
                        item={item}
                        disabled={!canEditItems}
                        onPass={() => void handlePassItem(item)}
                        onReject={() => setRejectTarget(item)}
                        onOpenJson={setJsonTarget}
                      />
                    </TableCell>
                  </TableRow>
                )
              })}
              {items.length === 0 && <TableRow><TableCell colSpan={16} className={emptyCellClass}>{task?.taskStatus === 'pending' || task?.taskStatus === 'running' ? '任务执行中，明细将陆续写入...' : '暂无明细数据'}</TableCell></TableRow>}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" disabled={itemPage <= 1} onClick={() => setItemPage((value) => Math.max(1, value - 1))}>上一页</Button>
          <Button type="button" variant="outline" disabled={itemPage >= pageCount} onClick={() => setItemPage((value) => Math.min(pageCount, value + 1))}>下一页</Button>
        </div>
        </CardContent>
      </Card>

      {jsonTarget && <JsonModal title={jsonTarget.title} details={jsonTarget.details} onClose={() => setJsonTarget(null)} />}
      <RejectRemarkDialog
        item={rejectTarget}
        onClose={() => setRejectTarget(null)}
        onConfirm={async (remark) => {
          if (!rejectTarget) return
          await handleRejectItem(rejectTarget, remark)
        }}
      />
      <Lightbox
        open={Boolean(imageTarget)}
        close={() => setImageTarget(null)}
        slides={imageTarget ? [{ src: imageTarget.url }] : []}
        plugins={[Zoom]}
        carousel={{ finite: true }}
        controller={{ closeOnBackdropClick: true }}
        styles={{ root: { '--yarl__color_backdrop': 'rgba(0, 0, 0, 0.45)' } }}
        zoom={{ maxZoomPixelRatio: 6, scrollToZoom: true }}
      />
    </div>
    </TooltipProvider>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[88px_minmax(0,1fr)] gap-3">
      <span className="text-xs leading-6 text-muted-foreground">{label}</span>
      <strong className={cn(detailValueClass, 'leading-6 [overflow-wrap:anywhere]')}>{value}</strong>
    </div>
  )
}

function App() {
  const [activeTab, setActiveTab] = useState<'finance' | 'settings'>('finance')
  const [modelRoot, setModelRoot] = useState('')
  const [variant, setVariant] = useState<OcrModelVariant>('v5_server')
  const [financeCheckRowConcurrency, setFinanceCheckRowConcurrency] = useState(5)
  const [ocrNodeMode, setOcrNodeMode] = useState<OcrNodeMode>('builtin')
  const [ocrNodePath, setOcrNodePath] = useState('')
  const [ocrNodeVersion, setOcrNodeVersion] = useState<string | null>(null)
  const [configPath, setConfigPath] = useState('')
  const [modelInfo, setModelInfo] = useState<OcrServerModelInfo | null>(null)
  const [configError, setConfigError] = useState('')

  useEffect(() => {
    async function loadConfig() {
      try {
        const config = await fetchAppConfig()
        const info = await fetchServerModelInfo(config.variant)
        setModelRoot(config.modelRoot)
        setVariant(config.variant)
        setFinanceCheckRowConcurrency(config.financeCheckRowConcurrency)
        setOcrNodeMode(config.ocrNodeMode)
        setOcrNodePath(config.ocrNodePath)
        setOcrNodeVersion(config.ocrNodeInfo.nodeVersion)
        setConfigPath(config.configPath)
        setModelInfo(info)
      } catch (err) {
        setConfigError(err instanceof Error ? err.message : '读取配置失败')
      }
    }

    void loadConfig()
  }, [])

  const tabs = useMemo(
    () => [
      { key: 'finance' as const, label: '对账' },
      { key: 'settings' as const, label: '设置' },
    ],
    [],
  )

  function normalizeFinanceCheckRowConcurrency(value: number): number {
    if (!Number.isFinite(value)) return 5
    return Math.max(1, Math.min(20, Math.round(value)))
  }

  async function persistConfig(
    nextModelRoot: string,
    nextVariant: OcrModelVariant,
    nextFinanceCheckRowConcurrency: number,
    nextOcrNodeMode: OcrNodeMode = ocrNodeMode,
    nextOcrNodePath: string = ocrNodePath,
  ) {
    try {
      const config = await saveAppConfig({
        modelRoot: nextModelRoot,
        variant: nextVariant,
        financeCheckRowConcurrency: nextFinanceCheckRowConcurrency,
        ocrNodeMode: nextOcrNodeMode,
        ocrNodePath: nextOcrNodePath,
      })
      setOcrNodeVersion(config.ocrNodeInfo.nodeVersion)
      setConfigPath(config.configPath)
      setConfigError('')
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : '保存配置失败')
    }
  }

  function handleModelRootChange(value: string) {
    setModelRoot(value)
    void persistConfig(value, variant, financeCheckRowConcurrency)
  }

  function handleVariantChange(value: OcrModelVariant) {
    setVariant(value)
    void persistConfig(modelRoot, value, financeCheckRowConcurrency)
  }

  function handleFinanceCheckRowConcurrencyChange(value: number) {
    const normalized = normalizeFinanceCheckRowConcurrency(value)
    setFinanceCheckRowConcurrency(normalized)
    void persistConfig(modelRoot, variant, normalized)
  }

  function handleOcrNodeModeChange(value: OcrNodeMode) {
    setOcrNodeMode(value)
    void persistConfig(modelRoot, variant, financeCheckRowConcurrency, value, ocrNodePath)
  }

  function handleOcrNodePathChange(value: string) {
    setOcrNodePath(value)
    void persistConfig(modelRoot, variant, financeCheckRowConcurrency, ocrNodeMode, value)
  }

  function handleConfigChange(nextModelRoot: string, nextVariant: OcrModelVariant, nextFinanceCheckRowConcurrency: number) {
    const normalized = normalizeFinanceCheckRowConcurrency(nextFinanceCheckRowConcurrency)
    setModelRoot(nextModelRoot)
    setVariant(nextVariant)
    setFinanceCheckRowConcurrency(normalized)
    void persistConfig(nextModelRoot, nextVariant, normalized)
  }

  return (
    <div className={pageShellClass}>
      <header className="flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-start">
        <h1 className="text-3xl font-semibold">财务对账</h1>
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'finance' | 'settings')} className="items-end">
        <TabsList aria-label="功能切换">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key} className="min-w-18 px-3.5">
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        </Tabs>
      </header>
      {configError && <p className={errorTextClass}>{configError}</p>}

      {activeTab === 'finance'
        ? <FinanceCheckPage modelRoot={modelRoot} variant={variant} financeCheckRowConcurrency={financeCheckRowConcurrency} modelInfo={modelInfo} onOpenSettings={() => setActiveTab('settings')} />
        : <OcrSettings modelRoot={modelRoot} variant={variant} financeCheckRowConcurrency={financeCheckRowConcurrency} ocrNodeMode={ocrNodeMode} ocrNodePath={ocrNodePath} configPath={configPath} onModelRootChange={handleModelRootChange} onVariantChange={handleVariantChange} onFinanceCheckRowConcurrencyChange={handleFinanceCheckRowConcurrencyChange} onOcrNodeModeChange={handleOcrNodeModeChange} onOcrNodePathChange={handleOcrNodePathChange} onConfigChange={handleConfigChange} onModelInfoChange={setModelInfo} />}
      <div className={bottomRightInfoClass}>
        <span>{formatOcrNodeModeLabel(ocrNodeMode, ocrNodeVersion)}</span>
        {ocrNodeMode === 'custom' && ocrNodePath && (
          <>
            <span aria-hidden="true">·</span>
            <span className="max-w-[min(48vw,28rem)] truncate" title={ocrNodePath}>{ocrNodePath}</span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <span>{formatOcrModelVariant(variant)}</span>
        <span aria-hidden="true">·</span>
        <span>{formatAppVersion(appPackage.version)}</span>
      </div>
    </div>
  )
}

export default App
