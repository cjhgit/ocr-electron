import { app, BrowserWindow, screen, shell } from 'electron'
import { existsSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { homedir } from 'node:os'
import { buffer as readStreamBuffer } from 'node:stream/consumers'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import path from 'node:path'
import Koa from 'koa'
import type { Context } from 'koa'
import Router from '@koa/router'
import bodyParser from 'koa-bodyparser'
import { recognizeText, setDefaultOcrRuntime } from './ocr/service'
import { getModelAsset, isOcrModelVariant, type OcrModelVariant } from './ocr/config'
import { FINANCE_CHECK_ROW_CONCURRENCY } from './finance-checker/constants'
import {
  cancelFinanceCheckTask,
  createFinanceCheckTask,
  deleteFinanceCheckTask,
  getFinanceCheckTask,
  listFinanceCheckItems,
  listFinanceCheckTasks,
  openFinanceCheckSourceFile,
  sendFinanceCheckDownload,
  sendFinanceCheckImage,
  type FinanceCheckTaskStatus,
} from './finance-checker/service'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '../..')

export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'out/renderer')

const isDev =
  process.env.NODE_ENV_ELECTRON_VITE === 'development' || !app.isPackaged

function resolveDevServerUrl(): string | undefined {
  const url =
    process.env.ELECTRON_RENDERER_URL?.trim() ||
    process.env.VITE_DEV_SERVER_URL?.trim()

  if (url) return url.replace(/\/$/, '')
  if (isDev) return 'http://127.0.0.1:7777'
  return undefined
}

function configureWindowsGpu(): void {
  app.setAppUserModelId(app.getName())

  const gpuMode = process.env.ELECTRON_GPU_MODE ?? 'disable'

  switch (gpuMode) {
    case 'native':
      break
    case 'swiftshader':
      app.commandLine.appendSwitch('disable-gpu-sandbox')
      app.commandLine.appendSwitch('use-angle', 'swiftshader')
      app.commandLine.appendSwitch('use-gl', 'angle')
      break
    case 'disable':
    default:
      // Electron 38+ / Chromium 139+：须同时禁用 GPU 与 DirectComposition，否则 Windows 白屏
      app.disableHardwareAcceleration()
      app.commandLine.appendSwitch('disable-gpu')
      app.commandLine.appendSwitch('disable-direct-composition')
      app.commandLine.appendSwitch('disable-gpu-sandbox')
      break
  }

  try {
    execSync('chcp 65001 >nul', { stdio: 'ignore', windowsHide: true })
  } catch {
    // ignore
  }
}

if (process.platform === 'win32') {
  configureWindowsGpu()
}

if (isDev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

process.env.VITE_PUBLIC = resolveDevServerUrl()
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win: BrowserWindow | null = null

const preloadPath = path.join(__dirname, '../preload/index.js')
const indexHtml = path.join(RENDERER_DIST, 'index.html')
const CONFIG_DIR = path.join(homedir(), '.finance-checker')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')
const DEFAULT_MODEL_ROOT = path.join(CONFIG_DIR, 'paddleocr-js-onnx')
const MODEL_BASE_URL = 'https://ai-html.obs.cn-south-1.myhuaweicloud.com:443/paddleocr-js-onnx'

type AppConfig = {
  modelRoot: string
  variant: OcrModelVariant
  financeCheckRowConcurrency: number
}

function normalizeFinanceCheckRowConcurrency(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return FINANCE_CHECK_ROW_CONCURRENCY
  return Math.max(1, Math.min(20, Math.round(numeric)))
}

type MultipartUpload = {
  fields: Record<string, string>
  file: {
    fileName: string
    content: Buffer
  } | null
}

function parseContentDisposition(value: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const part of value.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=')
    if (!rawKey || rawValue.length === 0) continue
    result[rawKey] = rawValue.join('=').replace(/^"|"$/g, '')
  }
  return result
}

async function parseMultipartUpload(ctx: Context): Promise<MultipartUpload> {
  const contentType = ctx.get('content-type')
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
  if (!boundary) throw new Error('上传表单缺少 boundary')

  const body = await readStreamBuffer(ctx.req)
  const boundaryBuffer = Buffer.from(`--${boundary}`)
  const headerSeparator = Buffer.from('\r\n\r\n')
  const fields: Record<string, string> = {}
  let file: MultipartUpload['file'] = null
  let cursor = 0

  while (true) {
    const boundaryStart = body.indexOf(boundaryBuffer, cursor)
    if (boundaryStart < 0) break
    let partStart = boundaryStart + boundaryBuffer.length
    if (body.subarray(partStart, partStart + 2).toString('latin1') === '--') break
    if (body.subarray(partStart, partStart + 2).toString('latin1') === '\r\n') partStart += 2

    const nextBoundary = body.indexOf(boundaryBuffer, partStart)
    if (nextBoundary < 0) break
    let partEnd = nextBoundary
    if (body.subarray(partEnd - 2, partEnd).toString('latin1') === '\r\n') partEnd -= 2

    const part = body.subarray(partStart, partEnd)
    const headerEnd = part.indexOf(headerSeparator)
    if (headerEnd >= 0) {
      const rawHeaders = part.subarray(0, headerEnd).toString('utf8')
      const content = part.subarray(headerEnd + headerSeparator.length)
      const dispositionLine = rawHeaders
        .split(/\r\n/)
        .find((line) => line.toLowerCase().startsWith('content-disposition:'))
      const disposition = dispositionLine
        ? parseContentDisposition(dispositionLine.slice(dispositionLine.indexOf(':') + 1))
        : {}
      const name = disposition.name
      if (name === 'file') {
        file = {
          fileName: disposition.filename || 'upload.xlsx',
          content: Buffer.from(content),
        }
      } else if (name) {
        fields[name] = content.toString('utf8')
      }
    }

    cursor = nextBoundary
  }

  return { fields, file }
}

async function logRendererState(label: string) {
  if (!win || win.webContents.isDestroyed()) return

  try {
    const state = await win.webContents.executeJavaScript(`({
      url: location.href,
      title: document.title,
      rootLen: document.getElementById('root')?.innerHTML?.length ?? 0,
      bodyLen: document.body?.innerText?.length ?? 0,
    })`)
    console.log(`[renderer] ${label}:`, state)
  } catch (error) {
    console.error(`[renderer] ${label} inspect failed:`, error)
  }
}

function normalizeAppConfig(value: unknown): AppConfig {
  const config = value as Partial<AppConfig> | null
  return {
    modelRoot: typeof config?.modelRoot === 'string' ? config.modelRoot : '',
    variant: isOcrModelVariant(config?.variant) ? config.variant : 'server',
    financeCheckRowConcurrency: normalizeFinanceCheckRowConcurrency(config?.financeCheckRowConcurrency),
  }
}

async function readAppConfig(): Promise<AppConfig> {
  try {
    return normalizeAppConfig(JSON.parse(await readFile(CONFIG_PATH, 'utf-8')))
  } catch {
    return {
      modelRoot: '',
      variant: 'server',
      financeCheckRowConcurrency: FINANCE_CHECK_ROW_CONCURRENCY,
    }
  }
}

async function saveAppConfig(config: AppConfig): Promise<AppConfig> {
  const normalized = normalizeAppConfig(config)
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8')
  return normalized
}

async function openConfigFolder(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  const error = await shell.openPath(CONFIG_DIR)
  if (error) {
    throw new Error(error)
  }
}

async function getServerModelFileStatus(variant: OcrModelVariant) {
  const asset = getModelAsset(variant)
  const modelDir = path.join(DEFAULT_MODEL_ROOT, asset.dir)
  const modelFiles = [asset.dict, asset.det, asset.rec]
  const files = await Promise.all(
    modelFiles.map(async (fileName) => {
      try {
        const fileStat = await stat(path.join(modelDir, fileName))
        return {
          fileName,
          exists: fileStat.isFile() && fileStat.size > 0,
          size: fileStat.isFile() ? fileStat.size : 0,
        }
      } catch {
        return {
          fileName,
          exists: false,
          size: 0,
        }
      }
    }),
  )

  return {
    modelRoot: DEFAULT_MODEL_ROOT,
    modelDir,
    files,
    ready: files.every((file) => file.exists),
  }
}

async function downloadFile(url: string, destination: string, redirectCount = 0): Promise<void> {
  if (redirectCount > 5) {
    throw new Error(`下载重定向次数过多：${url}`)
  }

  await mkdir(path.dirname(destination), { recursive: true })
  const tempDestination = `${destination}.download`
  let redirected = false

  await new Promise<void>((resolve, reject) => {
    const client = url.startsWith('https:') ? httpsGet : httpGet
    const request = client(url, (response) => {
      const statusCode = response.statusCode ?? 0
      const location = response.headers.location

      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume()
        redirected = true
        const nextUrl = new URL(location, url).toString()
        downloadFile(nextUrl, destination, redirectCount + 1).then(resolve, reject)
        return
      }

      if (statusCode !== 200) {
        response.resume()
        reject(new Error(`下载失败（HTTP ${statusCode}）：${path.basename(destination)}`))
        return
      }

      const fileStream = createWriteStream(tempDestination)
      response.pipe(fileStream)
      fileStream.on('finish', () => fileStream.close((error) => error ? reject(error) : resolve()))
      fileStream.on('error', reject)
    })

    request.on('error', reject)
    request.setTimeout(120_000, () => {
      request.destroy(new Error(`下载超时：${path.basename(destination)}`))
    })
  }).catch(async (error) => {
    await rm(tempDestination, { force: true })
    throw error
  })

  if (redirected) return

  await rm(destination, { force: true })
  await rename(tempDestination, destination)
}

async function downloadServerModel(variant: OcrModelVariant) {
  const asset = getModelAsset(variant)
  const modelDir = path.join(DEFAULT_MODEL_ROOT, asset.dir)
  const modelFiles = [asset.dict, asset.det, asset.rec]
  await mkdir(modelDir, { recursive: true })

  for (const fileName of modelFiles) {
    await downloadFile(`${MODEL_BASE_URL}/${asset.dir}/${fileName}`, path.join(modelDir, fileName))
  }

  const config = await readAppConfig()
  await saveAppConfig({
    ...config,
    modelRoot: DEFAULT_MODEL_ROOT,
    variant,
  })
  return getServerModelFileStatus(variant)
}

function createHttpServer() {
  const koaApp = new Koa()
  const router = new Router()

  koaApp.use(async (ctx, next) => {
    ctx.set('Access-Control-Allow-Origin', '*')
    ctx.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    ctx.set('Access-Control-Allow-Headers', 'Content-Type')

    if (ctx.method === 'OPTIONS') {
      ctx.status = 200
      return
    }

    try {
      await next()
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      ctx.set('Access-Control-Allow-Origin', '*')
      ctx.status = err?.status ?? 500
      ctx.body = {
        code: -1,
        message: err?.message ?? '服务器错误',
      }
    }
  })

  koaApp.use(
    bodyParser({
      jsonLimit: '2048mb',
      formLimit: '2048mb',
      textLimit: '2048mb',
    }),
  )

  router.get('/', (ctx) => {
    ctx.body = 'hello chat'
  })

  router.post('/api/ocr/recognize', async (ctx) => {
    const body = ctx.request.body as {
      modelRoot?: string
      variant?: OcrModelVariant
      image?: {
        width?: number
        height?: number
        dataBase64?: string
      }
    }

    const modelRoot = body.modelRoot?.trim()
    const variant = body.variant
    const image = body.image

    if (!modelRoot) {
      ctx.status = 400
      ctx.body = { code: -1, message: '请配置 paddleocr-js-onnx 路径' }
      return
    }

    if (!isOcrModelVariant(variant)) {
      ctx.status = 400
      ctx.body = { code: -1, message: '模型类型无效，请选择 server、v6_small 或 v6_medium' }
      return
    }

    if (
      !image?.width ||
      !image?.height ||
      !image?.dataBase64 ||
      image.width <= 0 ||
      image.height <= 0
    ) {
      ctx.status = 400
      ctx.body = { code: -1, message: '图片数据无效' }
      return
    }

    const pixelData = Buffer.from(image.dataBase64, 'base64')
    const expectedLength = image.width * image.height * 4

    if (pixelData.length !== expectedLength) {
      ctx.status = 400
      ctx.body = { code: -1, message: '图片像素数据长度不匹配' }
      return
    }

    const result = await recognizeText({
      modelRoot,
      variant,
      image: {
        width: image.width,
        height: image.height,
        data: new Uint8Array(pixelData),
      },
    })

    ctx.body = {
      code: 0,
      data: {
        text: result.text,
      },
    }
  })

  router.get('/api/ocr/server-model', async (ctx) => {
    const variant = isOcrModelVariant(ctx.query.variant) ? ctx.query.variant : 'server'
    ctx.body = {
      code: 0,
      data: await getServerModelFileStatus(variant),
    }
  })

  router.post('/api/ocr/server-model/download', async (ctx) => {
    const body = ctx.request.body as { variant?: OcrModelVariant }
    const variant = isOcrModelVariant(body.variant) ? body.variant : 'server'
    ctx.body = {
      code: 0,
      data: await downloadServerModel(variant),
    }
  })

  router.get('/api/settings/config', async (ctx) => {
    ctx.body = {
      code: 0,
      data: {
        ...(await readAppConfig()),
        configDir: CONFIG_DIR,
        configPath: CONFIG_PATH,
      },
    }
  })

  router.post('/api/settings/config', async (ctx) => {
    const body = ctx.request.body as Partial<AppConfig>
    const config = await saveAppConfig({
      modelRoot: typeof body.modelRoot === 'string' ? body.modelRoot.trim() : '',
      variant: isOcrModelVariant(body.variant) ? body.variant : 'server',
      financeCheckRowConcurrency: normalizeFinanceCheckRowConcurrency(body.financeCheckRowConcurrency),
    })
    ctx.body = {
      code: 0,
      data: {
        ...config,
        configDir: CONFIG_DIR,
        configPath: CONFIG_PATH,
      },
    }
  })

  router.post('/api/settings/config/open-folder', async (ctx) => {
    await openConfigFolder()
    ctx.body = {
      code: 0,
      data: { ok: true },
    }
  })

  router.get('/api/finance-check/tasks', async (ctx) => {
    const query = ctx.query as Record<string, string | undefined>
    const taskStatus = query.taskStatus as FinanceCheckTaskStatus | undefined
    ctx.body = {
      code: 0,
      data: await listFinanceCheckTasks({
        page: Number(query.page ?? 1),
        pageSize: Number(query.pageSize ?? 10),
        taskStatus,
      }),
    }
  })

  router.post('/api/finance-check/tasks', async (ctx) => {
    const upload = await parseMultipartUpload(ctx)
    const modelRoot = upload.fields.modelRoot?.trim()
    const variant = upload.fields.variant as OcrModelVariant | undefined
    const rowConcurrency = normalizeFinanceCheckRowConcurrency(upload.fields.rowConcurrency)

    if (!upload.file) {
      ctx.status = 400
      ctx.body = { code: -1, message: '请上传 Excel 文件' }
      return
    }
    if (!modelRoot) {
      ctx.status = 400
      ctx.body = { code: -1, message: '请先在设置中配置 paddleocr-js-onnx 路径' }
      return
    }
    if (!isOcrModelVariant(variant)) {
      ctx.status = 400
      ctx.body = { code: -1, message: '模型类型无效，请选择 server、v6_small 或 v6_medium' }
      return
    }
    setDefaultOcrRuntime({ modelRoot, variant })
    ctx.body = {
      code: 0,
      data: await createFinanceCheckTask({
        fileName: upload.file.fileName,
        content: upload.file.content,
        rowConcurrency,
      }),
    }
  })

  router.get('/api/finance-check/tasks/:taskId', async (ctx) => {
    const task = await getFinanceCheckTask(ctx.params.taskId)
    if (!task) {
      ctx.status = 404
      ctx.body = { code: -1, message: '任务不存在' }
      return
    }
    ctx.body = { code: 0, data: task }
  })

  router.get('/api/finance-check/tasks/:taskId/items', async (ctx) => {
    const query = ctx.query as Record<string, string | undefined>
    ctx.body = {
      code: 0,
      data: await listFinanceCheckItems({
        taskId: ctx.params.taskId,
        page: Number(query.page ?? 1),
        pageSize: Number(query.pageSize ?? 50),
        overallStatus: query.overallStatus as never,
      }),
    }
  })

  router.post('/api/finance-check/tasks/:taskId/cancel', async (ctx) => {
    const ok = await cancelFinanceCheckTask(ctx.params.taskId)
    if (!ok) {
      ctx.status = 404
      ctx.body = { code: -1, message: '任务不存在' }
      return
    }
    ctx.body = { code: 0, data: { ok: true } }
  })

  router.post('/api/finance-check/tasks/:taskId/open-source', async (ctx) => {
    const ok = await openFinanceCheckSourceFile(ctx.params.taskId)
    if (!ok) {
      ctx.status = 404
      ctx.body = { code: -1, message: '原始文件不存在' }
      return
    }
    ctx.body = { code: 0, data: { ok: true } }
  })

  router.delete('/api/finance-check/tasks/:taskId', async (ctx) => {
    const ok = await deleteFinanceCheckTask(ctx.params.taskId)
    if (!ok) {
      ctx.status = 400
      ctx.body = { code: -1, message: '任务不存在或正在执行中' }
      return
    }
    ctx.body = { code: 0, data: { ok: true } }
  })

  router.get('/api/finance-check/tasks/:taskId/download', async (ctx) => {
    const ok = await sendFinanceCheckDownload(ctx, ctx.params.taskId)
    if (!ok) {
      ctx.status = 404
      ctx.body = { code: -1, message: '结果文件不存在' }
    }
  })

  router.get('/api/finance-check/tasks/:taskId/image', async (ctx) => {
    const query = ctx.query as Record<string, string | undefined>
    const ok = await sendFinanceCheckImage(ctx, ctx.params.taskId, query.path ?? '')
    if (!ok) {
      ctx.status = 404
      ctx.body = { code: -1, message: '图片不存在' }
    }
  })

  koaApp.use(router.routes())
  koaApp.use(router.allowedMethods())

  koaApp.use(async (ctx) => {
    ctx.status = 404
    ctx.body = { error: 'Not Found' }
  })

  const PORT = 38765
  const server = koaApp.listen(PORT, () => {
    console.log(`HTTP 服务器运行在 http://localhost:${PORT}`)
  })

  return server
}

async function createWindow() {
  const devServerUrl = resolveDevServerUrl()
  console.log('[main] isDev:', isDev)
  console.log('[main] ELECTRON_RENDERER_URL:', process.env.ELECTRON_RENDERER_URL)
  console.log('[main] load target:', devServerUrl ?? indexHtml)

  const webPreferences: Electron.WebPreferences = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
  }

  if (existsSync(preloadPath)) {
    webPreferences.preload = preloadPath
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  win = new BrowserWindow({
    title: '财务助手',
    icon: path.join(process.env.VITE_PUBLIC, 'favicon.ico'),
    width,
    height,
    backgroundColor: '#ffffff',
    webPreferences,
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, url) => {
    console.error('[renderer] load failed:', errorCode, errorDescription, url)
  })

  win.webContents.on('did-finish-load', () => {
    console.log('[renderer] did-finish-load:', win?.webContents.getURL())
    void logRendererState('after load')
    setTimeout(() => {
      void logRendererState('after 2s')
    }, 2000)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] process gone:', details.reason)
  })

  win.webContents.on('console-message', (event) => {
    const { level, message, sourceId, lineNumber } = event
    if (level === 'warning' || level === 'error') {
      console.error(`[renderer] ${message} (${sourceId}:${lineNumber})`)
    }
  })

  if (devServerUrl) {
    await win.loadURL(devServerUrl)
  } else {
    await win.loadFile(indexHtml)
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(async () => {
  await createWindow()
  createHttpServer()
  if (isDev) {
    console.log('[main] DevTools: View -> Toggle Developer Tools, or chrome://inspect -> 127.0.0.1:9222')
  }
})

app.on('window-all-closed', () => {
  win = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow()
})

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})
