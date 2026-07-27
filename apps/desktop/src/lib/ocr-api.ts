const OCR_API_BASE = 'http://localhost:38765'

export type OcrModelVariant = 'v5_server' | 'v6_tiny' | 'v6_small' | 'v6_medium'
export type OcrNodeMode = 'builtin' | 'custom'

export type OcrRecognizeRequest = {
  modelRoot: string
  variant: OcrModelVariant
  image: {
    width: number
    height: number
    dataBase64: string
  }
}

export type OcrRecognizeResponse = {
  code: number
  message?: string
  data?: {
    text: string
  }
}

export type OcrServerModelFile = {
  fileName: string
  exists: boolean
  size: number
}

export type OcrServerModelInfo = {
  modelRoot: string
  modelDir: string
  files: OcrServerModelFile[]
  ready: boolean
}

export type AppConfig = {
  modelRoot: string
  variant: OcrModelVariant
  financeCheckRowConcurrency: number
  ocrNodeMode: OcrNodeMode
  ocrNodePath: string
  ocrNodeInfo: {
    mode: OcrNodeMode
    customPath: string
    resolvedPath: string
    usingElectronAsNode: boolean
    source: 'custom' | 'env' | 'nvm' | 'path' | 'shell' | 'electron'
    nodeVersion: string | null
  }
  configDir: string
  configPath: string
}

type ApiResponse<T> = {
  code: number
  message?: string
  data?: T
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

const OCR_INPUT_MAX_LONG_SIDE = 1920

export async function loadImagePixels(file: File): Promise<{
  width: number
  height: number
  dataBase64: string
}> {
  const objectUrl = URL.createObjectURL(file)

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('无法读取图片'))
      img.src = objectUrl
    })

    const longSide = Math.max(image.naturalWidth, image.naturalHeight)
    const scale = longSide > OCR_INPUT_MAX_LONG_SIDE
      ? OCR_INPUT_MAX_LONG_SIDE / longSide
      : 1
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('无法创建画布')
    }

    context.drawImage(image, 0, 0, width, height)
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height)

    return {
      width: canvas.width,
      height: canvas.height,
      dataBase64: uint8ArrayToBase64(new Uint8Array(imageData.data)),
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export async function recognizeImage(
  payload: OcrRecognizeRequest,
): Promise<string> {
  const response = await fetch(`${OCR_API_BASE}/api/ocr/recognize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const result = (await response.json()) as OcrRecognizeResponse

  if (!response.ok || result.code !== 0 || !result.data) {
    throw new Error(result.message ?? 'OCR 识别失败')
  }

  return result.data.text
}

async function parseApiResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  const result = (await response.json()) as ApiResponse<T>

  if (!response.ok || result.code !== 0 || !result.data) {
    throw new Error(result.message ?? fallbackMessage)
  }

  return result.data
}

export async function fetchServerModelInfo(variant: OcrModelVariant): Promise<OcrServerModelInfo> {
  const query = new URLSearchParams({ variant })
  const response = await fetch(`${OCR_API_BASE}/api/ocr/server-model?${query}`)
  return parseApiResponse<OcrServerModelInfo>(response, '获取模型状态失败')
}

export async function downloadServerModel(variant: OcrModelVariant): Promise<OcrServerModelInfo> {
  const response = await fetch(`${OCR_API_BASE}/api/ocr/server-model/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ variant }),
  })
  return parseApiResponse<OcrServerModelInfo>(response, '下载模型失败')
}

export async function fetchAppConfig(): Promise<AppConfig> {
  const response = await fetch(`${OCR_API_BASE}/api/settings/config`)
  return parseApiResponse<AppConfig>(response, '读取配置失败')
}

export async function detectSystemNode(): Promise<{ nodePath: string | null; found: boolean }> {
  const response = await fetch(`${OCR_API_BASE}/api/settings/node/detect-system`, {
    method: 'POST',
  })
  return parseApiResponse<{ nodePath: string | null; found: boolean }>(response, '识别系统 Node.js 失败')
}

export async function saveAppConfig(payload: {
  modelRoot: string
  variant: OcrModelVariant
  financeCheckRowConcurrency: number
  ocrNodeMode: OcrNodeMode
  ocrNodePath: string
}): Promise<AppConfig> {
  const response = await fetch(`${OCR_API_BASE}/api/settings/config`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  return parseApiResponse<AppConfig>(response, '保存配置失败')
}

export async function openConfigFolder(): Promise<void> {
  const response = await fetch(`${OCR_API_BASE}/api/settings/config/open-folder`, {
    method: 'POST',
  })
  await parseApiResponse<{ ok: boolean }>(response, '打开配置文件夹失败')
}

export async function openLogFolder(): Promise<void> {
  const response = await fetch(`${OCR_API_BASE}/api/settings/log/open-folder`, {
    method: 'POST',
  })
  await parseApiResponse<{ ok: boolean }>(response, '打开日志文件夹失败')
}

export async function clearErrorLogs(): Promise<void> {
  const response = await fetch(`${OCR_API_BASE}/api/settings/log/clear`, {
    method: 'POST',
  })
  await parseApiResponse<{ ok: boolean }>(response, '清空日志失败')
}
