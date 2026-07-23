import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import appPackage from '../package.json'
import {
  ArrowLeft,
  Bug,
  Cpu,
  Download,
  Eye,
  FileSpreadsheet,
  FolderOpen,
  Info as InfoIcon,
  RefreshCw,
  ScanSearch,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react'
import Lightbox from 'yet-another-react-lightbox'
import Zoom from 'yet-another-react-lightbox/plugins/zoom'
import 'yet-another-react-lightbox/styles.css'
import { Alert, AlertAction, AlertDescription, AlertTitle } from './components/ui/alert'
import { Badge } from './components/ui/badge'
import { Button, buttonVariants } from './components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './components/ui/dialog'
import { Input } from './components/ui/input'
import { NativeSelect, NativeSelectOption } from './components/ui/native-select'
import { Progress } from './components/ui/progress'
import { RadioGroup, RadioGroupItem } from './components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs'
import { Textarea } from './components/ui/textarea'
import {
  downloadServerModel,
  fetchServerModelInfo,
  fetchAppConfig,
  loadImagePixels,
  openConfigFolder,
  recognizeImage,
  saveAppConfig,
  type AppConfig,
  type OcrNodeMode,
  type OcrModelVariant,
  type OcrServerModelInfo,
} from './lib/ocr-api'
import {
  cancelFinanceCheckTask,
  deleteFinanceCheckTask,
  fetchFinanceCheckTask,
  fetchFinanceCheckTaskItems,
  fetchFinanceCheckTasks,
  financeCheckImageUrl,
  openFinanceCheckSourceFile,
  uploadFinanceCheckTask,
  type FinanceCheckResultStatus,
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
  ocrNodeInfo,
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
  ocrNodeInfo: AppConfig['ocrNodeInfo'] | null
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
                当前使用：{ocrNodeInfo?.resolvedPath || '未检测'}
              </CardDescription>
            </CardHeader>
            <CardContent className={cardStackClass}>
              <RadioGroup
                value={ocrNodeMode}
                onValueChange={(value) => onOcrNodeModeChange(value as OcrNodeMode)}
                className="grid gap-3 sm:grid-cols-2"
              >
                <label className="flex min-h-16 cursor-pointer items-start gap-3 rounded-lg border p-3">
                  <RadioGroupItem value="auto" />
                  <span className="grid gap-1">
                    <strong className="text-sm font-medium">自动</strong>
                    <span className="text-xs text-muted-foreground">按环境变量、NVM、PATH 自动查找系统 Node</span>
                  </span>
                </label>
                <label className="flex min-h-16 cursor-pointer items-start gap-3 rounded-lg border p-3">
                  <RadioGroupItem value="custom" />
                  <span className="grid gap-1">
                    <strong className="text-sm font-medium">自定义</strong>
                    <span className="text-xs text-muted-foreground">使用下面填写的 Node 可执行文件路径</span>
                  </span>
                </label>
              </RadioGroup>
              <label className={fieldClass}>
                <span>Node.js 路径</span>
                <Input
                  value={ocrNodePath}
                  onChange={(event) => onOcrNodePathChange(event.target.value)}
                  placeholder="/path/to/node"
                  disabled={ocrNodeMode !== 'custom'}
                />
              </label>
              {ocrNodeInfo && (
                <div className="grid gap-2 rounded-lg border bg-muted p-3 text-xs">
                  <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
                    <span className="text-muted-foreground">运行方式</span>
                    <strong className="font-semibold text-foreground">{ocrNodeInfo.source === 'custom' ? '自定义 Node.js' : ocrNodeInfo.usingElectronAsNode ? 'Electron 自带 Node.js' : '系统 Node.js'}</strong>
                  </div>
                  <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
                    <span className="text-muted-foreground">来源</span>
                    <strong className="font-semibold text-foreground">{ocrNodeInfo.source}</strong>
                  </div>
                  <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
                    <span className="text-muted-foreground">解析路径</span>
                    <strong className="font-semibold text-foreground [overflow-wrap:anywhere]">{ocrNodeInfo.resolvedPath}</strong>
                  </div>
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
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [error, setError] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [cancellingTaskIds, setCancellingTaskIds] = useState<Set<string>>(() => new Set())
  const [nowMs, setNowMs] = useState(() => Date.now())
  const dragCountRef = useRef(0)
  const pageSize = 10
  const shouldPromptForModel =
    !modelRoot.trim() || (variant === 'v5_server' && modelInfo?.modelRoot === modelRoot.trim() && !modelInfo.ready)

  async function refresh() {
    setLoading(true)
    setError('')
    try {
      const data = await fetchFinanceCheckTasks({
        page,
        pageSize,
        taskStatus: statusFilter === 'all' ? undefined : statusFilter,
      })
      setTasks(data.items)
      setTotal(data.total)
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
    void refresh()
  }, [page, statusFilter])

  useEffect(() => {
    const hasActive = tasks.some((task) => task.taskStatus === 'pending' || task.taskStatus === 'running')
      || cancellingTaskIds.size > 0
    if (!hasActive) return
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [tasks, page, statusFilter, cancellingTaskIds])

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
        <div className={tableWrapClass}>
          <Table>
            <TableHeader>
              <TableRow>
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
                return (
                <TableRow key={task.id}>
                  <TableCell><Button type="button" variant="link" className="h-auto min-h-0 max-w-80 justify-start truncate p-0" onClick={() => setSelectedTaskId(task.id)}>{task.sourceFileName}</Button></TableCell>
                  <TableCell><StatusBadge status={isCancelling ? 'cancelling' : task.taskStatus} /></TableCell>
                  <TableCell className="w-55 max-w-55"><ErrorMessageCell message={task.errorMessage} /></TableCell>
                  <TableCell><TaskProgress task={task} cancelling={isCancelling} />{task.taskStatus === 'succeeded' && <SummaryText task={task} />}</TableCell>
                  <TableCell>{formatTaskDuration(task, nowMs)}</TableCell>
                  <TableCell>{formatOcrModelVariant(task.modelVariant)}</TableCell>
                  <TableCell>{formatTime(task.createdAt)}</TableCell>
                  <TableCell>
                    <div className={rowActionsClass}>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => void handleOpenSourceFile(task.id)}><FolderOpen size={14} />原文件</Button>
                      {task.taskStatus === 'succeeded' && task.resultDownloadUrl && <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={task.resultDownloadUrl}><Download size={14} />下载</a>}
                      {(task.taskStatus === 'pending' || task.taskStatus === 'running') && !isCancelling
                        ? (
                            <Button type="button" variant="ghost" size="sm" className={dangerClass} onClick={() => void handleCancelTask(task.id)}>
                              <XCircle size={14} />取消
                            </Button>
                          )
                        : (task.taskStatus !== 'pending' && task.taskStatus !== 'running')
                          ? <Button type="button" variant="ghost" size="sm" className={dangerClass} onClick={async () => { if (window.confirm(`确定删除「${task.sourceFileName}」吗？`)) { await deleteFinanceCheckTask(task.id); await refresh() } }}><Trash2 size={14} />删除</Button>
                          : null}
                    </div>
                  </TableCell>
                </TableRow>
                )
              })}
              {!loading && tasks.length === 0 && <TableRow><TableCell colSpan={8} className={emptyCellClass}>暂无对账任务，点击“上传表格”开始</TableCell></TableRow>}
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

function FinanceCheckDetail({ taskId, onBack, onCancel, onCancellingResolved, cancelling }: { taskId: string; onBack: () => void; onCancel: () => void; onCancellingResolved: () => void; cancelling: boolean }) {
  const [task, setTask] = useState<FinanceCheckTask | null>(null)
  const [items, setItems] = useState<FinanceCheckTaskItem[]>([])
  const [itemTotal, setItemTotal] = useState(0)
  const [itemPage, setItemPage] = useState(1)
  const [itemStatusFilter, setItemStatusFilter] = useState<FinanceCheckResultStatus | 'all'>('all')
  const [jsonTarget, setJsonTarget] = useState<{ title: string; details: Record<string, unknown> | null } | null>(null)
  const [imageTarget, setImageTarget] = useState<{ title: string; url: string } | null>(null)
  const [error, setError] = useState('')
  const [nowMs, setNowMs] = useState(() => Date.now())
  const itemPageSize = 50

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

  return (
    <div className={pageStackClass}>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="icon" onClick={onBack} aria-label="返回"><ArrowLeft size={18} /></Button>
            <div>
              <CardTitle>{task?.sourceFileName ?? '对账任务详情'}</CardTitle>
              {task && <div className="mt-2 flex items-center gap-2"><StatusBadge status={cancelling ? 'cancelling' : task.taskStatus} /></div>}
            </div>
          </div>
          <CardAction>
          <div className={actionsClass}>
            {task && <Button type="button" variant="outline" onClick={() => void handleOpenSourceFile()}><FolderOpen size={16} />查看原文件</Button>}
            {task?.resultDownloadUrl && <a className={buttonVariants({ variant: 'outline' })} href={task.resultDownloadUrl}><Download size={16} />下载结果</a>}
            {task && (task.taskStatus === 'pending' || task.taskStatus === 'running') && !cancelling && (
              <Button type="button" variant="outline" className={dangerClass} onClick={onCancel}>
                <XCircle size={16} />取消任务
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
                <TableHead>商家实收</TableHead>
                <TableHead>商家实收图</TableHead>
                <TableHead>城市</TableHead>
                <TableHead>商户</TableHead>
                <TableHead>结果</TableHead>
                <TableHead>支付对账</TableHead>
                <TableHead>商户对账</TableHead>
                <TableHead>调试 JSON</TableHead>
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
                    <TableCell>{item.expectedPaidAmount ?? '-'}</TableCell>
                    <TableCell>
                      <ImageViewButton
                        title={`第 ${item.rowNumber} 行 · 实付券码`}
                        imageUrl={paymentImageUrl}
                        onOpen={setImageTarget}
                      />
                    </TableCell>
                    <TableCell>{item.expectedMerchantAmount ?? '-'}</TableCell>
                    <TableCell>
                      <ImageViewButton
                        title={`第 ${item.rowNumber} 行 · 商家实收图`}
                        imageUrl={merchantImageUrl}
                        onOpen={setImageTarget}
                      />
                    </TableCell>
                    <TableCell>{item.city ?? '-'}</TableCell>
                    <TableCell className="max-w-45 truncate" title={item.merchantName ?? undefined}>{item.merchantName ?? '-'}</TableCell>
                    <TableCell><StatusBadge status={item.overallStatus} /></TableCell>
                    <TableCell className="max-w-55 text-xs text-muted-foreground whitespace-normal">{item.paymentMessage ?? '-'}</TableCell>
                    <TableCell className="max-w-55 text-xs text-muted-foreground whitespace-normal">{item.merchantMessage ?? '-'}</TableCell>
                    <TableCell>
                      <div className={rowActionsClass}>
                        <Button type="button" variant="ghost" size="sm" disabled={!item.paymentCheckDetails} onClick={() => setJsonTarget({ title: `第 ${item.rowNumber} 行 · 支付截图`, details: item.paymentCheckDetails })}><ScanSearch size={14} />支付</Button>
                        <Button type="button" variant="ghost" size="sm" disabled={!item.merchantCheckDetails} onClick={() => setJsonTarget({ title: `第 ${item.rowNumber} 行 · 商户截图`, details: item.merchantCheckDetails })}><ScanSearch size={14} />商户</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
              {items.length === 0 && <TableRow><TableCell colSpan={12} className={emptyCellClass}>{task?.taskStatus === 'pending' || task?.taskStatus === 'running' ? '任务执行中，明细将陆续写入...' : '暂无明细数据'}</TableCell></TableRow>}
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
  const [ocrNodeMode, setOcrNodeMode] = useState<OcrNodeMode>('auto')
  const [ocrNodePath, setOcrNodePath] = useState('')
  const [ocrNodeInfo, setOcrNodeInfo] = useState<AppConfig['ocrNodeInfo'] | null>(null)
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
        setOcrNodeInfo(config.ocrNodeInfo)
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
      setOcrNodeInfo(config.ocrNodeInfo)
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
        : <OcrSettings modelRoot={modelRoot} variant={variant} financeCheckRowConcurrency={financeCheckRowConcurrency} ocrNodeMode={ocrNodeMode} ocrNodePath={ocrNodePath} ocrNodeInfo={ocrNodeInfo} configPath={configPath} onModelRootChange={handleModelRootChange} onVariantChange={handleVariantChange} onFinanceCheckRowConcurrencyChange={handleFinanceCheckRowConcurrencyChange} onOcrNodeModeChange={handleOcrNodeModeChange} onOcrNodePathChange={handleOcrNodePathChange} onConfigChange={handleConfigChange} onModelInfoChange={setModelInfo} />}
      <div className={bottomRightInfoClass}>
        <span>{formatOcrModelVariant(variant)}</span>
        <span aria-hidden="true">·</span>
        <span>{formatAppVersion(appPackage.version)}</span>
      </div>
    </div>
  )
}

export default App
