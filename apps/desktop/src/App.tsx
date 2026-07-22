import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Download,
  Eye,
  FileSpreadsheet,
  FolderOpen,
  RefreshCw,
  ScanSearch,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react'
import './App.css'
import {
  downloadServerModel,
  fetchServerModelInfo,
  fetchAppConfig,
  loadImagePixels,
  openConfigFolder,
  recognizeImage,
  saveAppConfig,
  type OcrModelVariant,
  type OcrServerModelInfo,
} from './lib/ocr-api'
import {
  cancelFinanceCheckTask,
  deleteFinanceCheckTask,
  fetchFinanceCheckTask,
  fetchFinanceCheckTaskItems,
  fetchFinanceCheckTasks,
  openFinanceCheckSourceFile,
  uploadFinanceCheckTask,
  type FinanceCheckResultStatus,
  type FinanceCheckTask,
  type FinanceCheckTaskItem,
  type FinanceCheckTaskStatus,
} from './lib/finance-check-api'

const TASK_STATUS_LABEL: Record<FinanceCheckTaskStatus, string> = {
  pending: '排队中',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const RESULT_STATUS_LABEL: Record<FinanceCheckResultStatus, string> = {
  pass: '通过',
  fail: '不通过',
  skip: '跳过',
  error: '异常',
}

const STATUS_OPTIONS: Array<{ value: FinanceCheckTaskStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '排队中' },
  { value: 'running', label: '执行中' },
  { value: 'succeeded', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
]

const ITEM_STATUS_OPTIONS: Array<{ value: FinanceCheckResultStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部结果' },
  { value: 'pass', label: '通过' },
  { value: 'fail', label: '不通过' },
  { value: 'skip', label: '跳过' },
  { value: 'error', label: '异常' },
]

function formatTime(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString()
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function StatusBadge({ status }: { status: FinanceCheckTaskStatus | FinanceCheckResultStatus }) {
  return <span className={`badge badge-${status}`}>{status in TASK_STATUS_LABEL ? TASK_STATUS_LABEL[status as FinanceCheckTaskStatus] : RESULT_STATUS_LABEL[status as FinanceCheckResultStatus]}</span>
}

function SummaryText({ task }: { task: FinanceCheckTask }) {
  if (!task.summary) return <span className="muted">-</span>
  return (
    <span className="summary-text">
      通过 {task.summary.pass} / 不通过 {task.summary.fail} / 跳过 {task.summary.skip} / 异常 {task.summary.error}
    </span>
  )
}

function TaskProgress({ task }: { task: FinanceCheckTask }) {
  if (task.taskStatus !== 'pending' && task.taskStatus !== 'running') return null
  const percent = task.progressPercent ?? 0
  return (
    <div className="progress-wrap">
      <div className="progress-bar">
        <div style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </div>
      <span className="muted">
        {task.taskStatus === 'pending'
          ? '排队中，等待执行...'
          : task.totalRows
            ? `对账中 ${percent}%（${task.processedRows ?? 0} / ${task.totalRows} 行）`
            : '对账中，正在读取 Excel...'}
      </span>
    </div>
  )
}

function ErrorMessageCell({ message }: { message: string | null }) {
  if (!message) return <span className="muted">-</span>
  return (
    <span className="hover-full-text" data-full-text={message}>
      {message}
    </span>
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
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <pre className="json-block">{JSON.stringify(details ?? {}, null, 2)}</pre>
      </div>
    </div>
  )
}

function OcrSettings({
  modelRoot,
  variant,
  financeCheckRowConcurrency,
  configPath,
  onModelRootChange,
  onVariantChange,
  onFinanceCheckRowConcurrencyChange,
  onConfigChange,
  onModelInfoChange,
}: {
  modelRoot: string
  variant: OcrModelVariant
  financeCheckRowConcurrency: number
  configPath: string
  onModelRootChange: (value: string) => void
  onVariantChange: (value: OcrModelVariant) => void
  onFinanceCheckRowConcurrencyChange: (value: number) => void
  onConfigChange: (modelRoot: string, variant: OcrModelVariant, financeCheckRowConcurrency: number) => void
  onModelInfoChange: (value: OcrServerModelInfo) => void
}) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [resultText, setResultText] = useState('')
  const [loading, setLoading] = useState(false)
  const [modelInfo, setModelInfo] = useState<OcrServerModelInfo | null>(null)
  const [modelStatusLoading, setModelStatusLoading] = useState(false)
  const [modelDownloading, setModelDownloading] = useState(false)
  const [openingConfigFolder, setOpeningConfigFolder] = useState(false)
  const [error, setError] = useState('')

  async function refreshModelInfo() {
    setModelStatusLoading(true)
    try {
      const info = await fetchServerModelInfo()
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
  }, [])

  async function handleDownloadModel() {
    setModelDownloading(true)
    setError('')
    try {
      const info = await downloadServerModel()
      setModelInfo(info)
      onModelInfoChange(info)
      onConfigChange(info.modelRoot, 'server', financeCheckRowConcurrency)
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
    <div className="tab-page">
      <section className="panel">
        <div className="toolbar">
          <div>
            <h2>模型配置</h2>
            {modelInfo && <p className="muted">server 模型目录：{modelInfo.modelDir}</p>}
          </div>
          <button type="button" className="secondary-button icon-text" onClick={() => void handleDownloadModel()} disabled={modelDownloading}>
            <Download size={16} />{modelDownloading ? '下载中...' : modelInfo?.ready ? '重新下载 server 模型' : '下载 server 模型'}
          </button>
        </div>
        <label className="field">
          <span>paddleocr-js-onnx 路径</span>
          <input value={modelRoot} onChange={(event) => onModelRootChange(event.target.value)} placeholder="/path/to/paddleocr-js-onnx" />
        </label>
        <label className="field">
          <span>模型类型</span>
          <select value={variant} onChange={(event) => onVariantChange(event.target.value as OcrModelVariant)} disabled>
            <option value="server">server（高精度）</option>
            <option value="mobile">mobile（轻量）</option>
          </select>
        </label>
        <label className="field">
          <span>对账行并发数</span>
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            value={financeCheckRowConcurrency}
            onChange={(event) => onFinanceCheckRowConcurrencyChange(Number(event.target.value))}
          />
        </label>
        {modelInfo && (
          <div className="model-files">
            {modelInfo.files.map((file) => (
              <div key={file.fileName} className="model-file-row">
                <span>{file.fileName}</span>
                <strong>{file.exists ? formatBytes(file.size) : '未下载'}</strong>
              </div>
            ))}
          </div>
        )}
        {!modelInfo && modelStatusLoading && <p className="muted">正在检测模型文件...</p>}
      </section>

      <section className="panel">
        <h2>上传图片</h2>
        <label className="upload-button">
          选择图片
          <input type="file" accept="image/*" onChange={(event) => {
            setSelectedFile(event.target.files?.[0] ?? null)
            setResultText('')
            setError('')
          }} />
        </label>
        {selectedFile && <p className="file-name">{selectedFile.name}</p>}
        {previewUrl && <img src={previewUrl} alt="预览" className="preview-image" />}
        <button type="button" className="primary-button" onClick={handleRecognize} disabled={loading || !selectedFile}>
          {loading ? '识别中...' : '开始识别'}
        </button>
      </section>

      <section className="panel">
        <h2>识别结果</h2>
        {error && <p className="error-text">{error}</p>}
        <textarea className="result-text" value={resultText} readOnly placeholder="识别结果会显示在这里" />
      </section>

      <section className="panel">
        <div className="toolbar">
          <div>
            <h2>配置文件</h2>
            <p className="muted">{configPath || '~/.finance-checker/config.json'}</p>
          </div>
          <button type="button" className="secondary-button icon-text" onClick={() => void handleOpenConfigFolder()} disabled={openingConfigFolder}>
            <FolderOpen size={16} />{openingConfigFolder ? '打开中...' : '打开配置文件夹'}
          </button>
        </div>
      </section>
    </div>
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
  const [nowMs, setNowMs] = useState(() => Date.now())
  const dragCountRef = useRef(0)
  const pageSize = 10
  const shouldPromptForModel =
    !modelRoot.trim() || (variant === 'server' && modelInfo?.modelRoot === modelRoot.trim() && !modelInfo.ready)

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
    if (!hasActive) return
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [tasks, page, statusFilter])

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
    return <FinanceCheckDetail taskId={selectedTaskId} onBack={() => {
      setSelectedTaskId(null)
      void refresh()
    }} />
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="tab-page">
      <section className="panel">
        <div className="toolbar">
          <div>
            <h2>对账任务</h2>
            <p className="muted">共 {loading ? '-' : total} 条{tasks.some((task) => task.taskStatus === 'pending' || task.taskStatus === 'running') ? ' · 执行中任务将自动刷新' : ''}</p>
          </div>
          <div className="actions">
            <input ref={fileInputRef} type="file" accept=".xlsx" hidden disabled={shouldPromptForModel} onChange={(event) => void uploadFile(event.target.files?.[0] ?? null)} />
            <button type="button" className="primary-button icon-text" disabled={uploading || shouldPromptForModel} onClick={() => fileInputRef.current?.click()}>
              <Upload size={16} /> {uploading ? '提交中...' : '上传表格'}
            </button>
            <select value={statusFilter} onChange={(event) => {
              setStatusFilter(event.target.value as FinanceCheckTaskStatus | 'all')
              setPage(1)
            }}>
              {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <button type="button" className="secondary-button icon-text" onClick={() => void refresh()}><RefreshCw size={16} />刷新</button>
          </div>
        </div>
        {shouldPromptForModel && (
          <div className="setup-notice">
            <div>
              <strong>请先下载 OCR 模型</strong>
              <p>对账需要本地 server 模型文件。请前往设置下载模型，下载完成后会自动保存配置。</p>
            </div>
            <button type="button" className="primary-button" onClick={onOpenSettings}>去设置</button>
          </div>
        )}
        <div
          role="button"
          tabIndex={0}
          className={`finance-upload-zone${isDragOver ? ' drag-over' : ''}${uploading ? ' uploading' : ''}${shouldPromptForModel ? ' disabled' : ''}`}
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
          <div className="upload-icon"><FileSpreadsheet size={22} /></div>
          <div>
            <p>{uploading ? '正在提交并校验文件...' : '点击选择 Excel，或拖拽文件到此处'}</p>
            <span>仅支持 .xlsx，任务会在后台执行并自动刷新</span>
          </div>
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>文件名</th>
                <th>状态</th>
                <th>错误信息</th>
                <th>进度 / 汇总</th>
                <th>耗时</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td><button type="button" className="link-button" onClick={() => setSelectedTaskId(task.id)}>{task.sourceFileName}</button></td>
                  <td><StatusBadge status={task.taskStatus} /></td>
                  <td className="error-cell"><ErrorMessageCell message={task.errorMessage} /></td>
                  <td><TaskProgress task={task} />{task.taskStatus === 'succeeded' && <SummaryText task={task} />}</td>
                  <td>{formatTaskDuration(task, nowMs)}</td>
                  <td>{formatTime(task.createdAt)}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="ghost-button" onClick={() => setSelectedTaskId(task.id)}><Eye size={14} />查看</button>
                      <button type="button" className="ghost-button" onClick={() => void handleOpenSourceFile(task.id)}><FolderOpen size={14} />原文件</button>
                      {task.taskStatus === 'succeeded' && task.resultDownloadUrl && <a className="ghost-button" href={task.resultDownloadUrl}><Download size={14} />下载</a>}
                      {(task.taskStatus === 'pending' || task.taskStatus === 'running')
                        ? <button type="button" className="ghost-button danger" onClick={async () => { await cancelFinanceCheckTask(task.id); await refresh() }}><XCircle size={14} />取消</button>
                        : <button type="button" className="ghost-button danger" onClick={async () => { if (window.confirm(`确定删除「${task.sourceFileName}」吗？`)) { await deleteFinanceCheckTask(task.id); await refresh() } }}><Trash2 size={14} />删除</button>}
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && tasks.length === 0 && <tr><td colSpan={7} className="empty-cell">暂无对账任务，点击“上传表格”开始</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <span className="muted">第 {page}/{pageCount} 页</span>
          <button type="button" className="secondary-button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
          <button type="button" className="secondary-button" disabled={page >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>下一页</button>
        </div>
      </section>
    </div>
  )
}

function FinanceCheckDetail({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const [task, setTask] = useState<FinanceCheckTask | null>(null)
  const [items, setItems] = useState<FinanceCheckTaskItem[]>([])
  const [itemTotal, setItemTotal] = useState(0)
  const [itemPage, setItemPage] = useState(1)
  const [itemStatusFilter, setItemStatusFilter] = useState<FinanceCheckResultStatus | 'all'>('all')
  const [jsonTarget, setJsonTarget] = useState<{ title: string; details: Record<string, unknown> | null } | null>(null)
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
    if (task?.taskStatus !== 'pending' && task?.taskStatus !== 'running') return
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [task?.taskStatus, taskId, itemPage, itemStatusFilter])

  useEffect(() => {
    if (task?.taskStatus !== 'pending' && task?.taskStatus !== 'running') return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [task?.taskStatus])

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
    <div className="tab-page">
      <section className="panel">
        <div className="toolbar">
          <div className="heading-row">
            <button type="button" className="icon-button" onClick={onBack} aria-label="返回"><ArrowLeft size={18} /></button>
            <div>
              <h2>{task?.sourceFileName ?? '对账任务详情'}</h2>
              {task && <div className="detail-badges"><StatusBadge status={task.taskStatus} /></div>}
            </div>
          </div>
          <div className="actions">
            {task && <button type="button" className="secondary-button icon-text" onClick={() => void handleOpenSourceFile()}><FolderOpen size={16} />查看原文件</button>}
            {task?.resultDownloadUrl && <a className="secondary-button icon-text" href={task.resultDownloadUrl}><Download size={16} />下载结果</a>}
            {task && (task.taskStatus === 'pending' || task.taskStatus === 'running') && <button type="button" className="secondary-button danger icon-text" onClick={async () => { await cancelFinanceCheckTask(taskId); await refresh() }}><XCircle size={16} />取消任务</button>}
            {task && task.taskStatus !== 'pending' && task.taskStatus !== 'running' && <button type="button" className="secondary-button danger icon-text" onClick={async () => { if (window.confirm(`确定删除「${task.sourceFileName}」吗？`)) { await deleteFinanceCheckTask(taskId); onBack() } }}><Trash2 size={16} />删除任务</button>}
            <button type="button" className="secondary-button icon-text" onClick={() => void refresh()}><RefreshCw size={16} />刷新</button>
          </div>
        </div>
        {error && <p className="error-text">{error}</p>}
        {task && (
          <div className="info-grid">
            <Info label="原始文件" value={task.sourceFileName} />
            <Info label="原始文件路径" value={task.sourcePath} />
            <Info label="结果文件" value={task.resultFileName ?? '-'} />
            <Info label="创建时间" value={formatTime(task.createdAt)} />
            <Info label="完成时间" value={formatTime(task.finishedAt)} />
            <Info label="耗时" value={formatTaskDuration(task, nowMs)} />
            <Info label="行并发数" value={String(task.rowConcurrency)} />
            <Info label="对账汇总" value={task.summary ? `通过 ${task.summary.pass} / 不通过 ${task.summary.fail} / 跳过 ${task.summary.skip} / 异常 ${task.summary.error}` : '-'} />
          </div>
        )}
        {task && <TaskProgress task={task} />}
        {task?.errorMessage && <p className="error-text">{task.errorMessage}</p>}
      </section>

      <section className="panel">
        <div className="toolbar">
          <div>
            <h2>明细</h2>
            <p className="muted">共 {itemTotal} 条{pageCount > 1 ? ` · 第 ${itemPage}/${pageCount} 页` : ''}</p>
          </div>
          <select value={itemStatusFilter} onChange={(event) => {
            setItemStatusFilter(event.target.value as FinanceCheckResultStatus | 'all')
            setItemPage(1)
          }}>
            {ITEM_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>行号</th>
                <th>券码</th>
                <th>城市</th>
                <th>商户</th>
                <th>应付金额</th>
                <th>应结商户金额</th>
                <th>结果</th>
                <th>支付对账</th>
                <th>商户对账</th>
                <th>调试 JSON</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.rowNumber}</td>
                  <td>{item.couponCode ?? '-'}</td>
                  <td>{item.city ?? '-'}</td>
                  <td className="ellipsis" title={item.merchantName ?? undefined}>{item.merchantName ?? '-'}</td>
                  <td>{item.expectedPaidAmount ?? '-'}</td>
                  <td>{item.expectedMerchantAmount ?? '-'}</td>
                  <td><StatusBadge status={item.overallStatus} /></td>
                  <td className="small-text">{item.paymentMessage ?? '-'}</td>
                  <td className="small-text">{item.merchantMessage ?? '-'}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="ghost-button" disabled={!item.paymentCheckDetails} onClick={() => setJsonTarget({ title: `第 ${item.rowNumber} 行 · 支付截图`, details: item.paymentCheckDetails })}><ScanSearch size={14} />支付</button>
                      <button type="button" className="ghost-button" disabled={!item.merchantCheckDetails} onClick={() => setJsonTarget({ title: `第 ${item.rowNumber} 行 · 商户截图`, details: item.merchantCheckDetails })}><ScanSearch size={14} />商户</button>
                    </div>
                  </td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={10} className="empty-cell">{task?.taskStatus === 'pending' || task?.taskStatus === 'running' ? '任务执行中，明细将陆续写入...' : '暂无明细数据'}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <button type="button" className="secondary-button" disabled={itemPage <= 1} onClick={() => setItemPage((value) => Math.max(1, value - 1))}>上一页</button>
          <button type="button" className="secondary-button" disabled={itemPage >= pageCount} onClick={() => setItemPage((value) => Math.min(pageCount, value + 1))}>下一页</button>
        </div>
      </section>

      {jsonTarget && <JsonModal title={jsonTarget.title} details={jsonTarget.details} onClose={() => setJsonTarget(null)} />}
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function App() {
  const [activeTab, setActiveTab] = useState<'finance' | 'settings'>('finance')
  const [modelRoot, setModelRoot] = useState('')
  const [variant, setVariant] = useState<OcrModelVariant>('server')
  const [financeCheckRowConcurrency, setFinanceCheckRowConcurrency] = useState(5)
  const [configPath, setConfigPath] = useState('')
  const [modelInfo, setModelInfo] = useState<OcrServerModelInfo | null>(null)
  const [configError, setConfigError] = useState('')

  useEffect(() => {
    async function loadConfig() {
      try {
        const [config, info] = await Promise.all([
          fetchAppConfig(),
          fetchServerModelInfo(),
        ])
        setModelRoot(config.modelRoot)
        setVariant(config.variant)
        setFinanceCheckRowConcurrency(config.financeCheckRowConcurrency)
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

  async function persistConfig(nextModelRoot: string, nextVariant: OcrModelVariant, nextFinanceCheckRowConcurrency: number) {
    try {
      const config = await saveAppConfig({
        modelRoot: nextModelRoot,
        variant: nextVariant,
        financeCheckRowConcurrency: nextFinanceCheckRowConcurrency,
      })
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

  function handleConfigChange(nextModelRoot: string, nextVariant: OcrModelVariant, nextFinanceCheckRowConcurrency: number) {
    const normalized = normalizeFinanceCheckRowConcurrency(nextFinanceCheckRowConcurrency)
    setModelRoot(nextModelRoot)
    setVariant(nextVariant)
    setFinanceCheckRowConcurrency(normalized)
    void persistConfig(nextModelRoot, nextVariant, normalized)
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>财务对账</h1>
        <nav className="tabs" aria-label="功能切换">
          {tabs.map((tab) => (
            <button key={tab.key} type="button" className={activeTab === tab.key ? 'active' : ''} onClick={() => setActiveTab(tab.key)}>
              {tab.label}
            </button>
          ))}
        </nav>
      </header>
      {configError && <p className="error-text">{configError}</p>}

      {activeTab === 'finance'
        ? <FinanceCheckPage modelRoot={modelRoot} variant={variant} financeCheckRowConcurrency={financeCheckRowConcurrency} modelInfo={modelInfo} onOpenSettings={() => setActiveTab('settings')} />
        : <OcrSettings modelRoot={modelRoot} variant={variant} financeCheckRowConcurrency={financeCheckRowConcurrency} configPath={configPath} onModelRootChange={handleModelRootChange} onVariantChange={handleVariantChange} onFinanceCheckRowConcurrencyChange={handleFinanceCheckRowConcurrencyChange} onConfigChange={handleConfigChange} onModelInfoChange={setModelInfo} />}
    </div>
  )
}

export default App
