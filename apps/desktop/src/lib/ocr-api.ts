const OCR_API_BASE = 'http://localhost:38765'

export type OcrModelVariant = 'mobile' | 'server'

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

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

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

    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight

    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('无法创建画布')
    }

    context.drawImage(image, 0, 0)
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
