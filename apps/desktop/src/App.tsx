import { useEffect, useState } from 'react'
import './App.css'
import {
  loadImagePixels,
  recognizeImage,
  type OcrModelVariant,
} from './lib/ocr-api'

const MODEL_ROOT_KEY = 'ocr-model-root'
const MODEL_VARIANT_KEY = 'ocr-model-variant'

function App() {
  const [modelRoot, setModelRoot] = useState('')
  const [variant, setVariant] = useState<OcrModelVariant>('server')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [resultText, setResultText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setModelRoot(localStorage.getItem(MODEL_ROOT_KEY) ?? '')
    const savedVariant = localStorage.getItem(MODEL_VARIANT_KEY)
    if (savedVariant === 'mobile' || savedVariant === 'server') {
      setVariant(savedVariant)
    }
  }, [])

  useEffect(() => {
    if (!selectedFile) {
      setPreviewUrl(null)
      return
    }

    const objectUrl = URL.createObjectURL(selectedFile)
    setPreviewUrl(objectUrl)

    return () => {
      URL.revokeObjectURL(objectUrl)
    }
  }, [selectedFile])

  function handleModelRootChange(value: string) {
    setModelRoot(value)
    localStorage.setItem(MODEL_ROOT_KEY, value)
  }

  function handleVariantChange(value: OcrModelVariant) {
    setVariant(value)
    localStorage.setItem(MODEL_VARIANT_KEY, value)
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
      const text = await recognizeImage({
        modelRoot: modelRoot.trim(),
        variant,
        image,
      })
      setResultText(text)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OCR 识别失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app">
      <h1>OCR 文字识别</h1>

      <section className="panel">
        <h2>模型配置</h2>
        <label className="field">
          <span>paddleocr-js-onnx 路径</span>
          <input
            type="text"
            value={modelRoot}
            onChange={(event) => handleModelRootChange(event.target.value)}
            placeholder="/path/to/paddleocr-js-onnx"
          />
        </label>

        <label className="field">
          <span>模型类型</span>
          <select
            value={variant}
            onChange={(event) =>
              handleVariantChange(event.target.value as OcrModelVariant)
            }
          >
            <option value="server">server（高精度）</option>
            <option value="mobile">mobile（轻量）</option>
          </select>
        </label>
      </section>

      <section className="panel">
        <h2>上传图片</h2>
        <label className="upload-button">
          选择图片
          <input
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null
              setSelectedFile(file)
              setResultText('')
              setError('')
            }}
          />
        </label>

        {selectedFile && <p className="file-name">{selectedFile.name}</p>}

        {previewUrl && (
          <img src={previewUrl} alt="预览" className="preview-image" />
        )}

        <button
          type="button"
          className="primary-button"
          onClick={handleRecognize}
          disabled={loading || !selectedFile}
        >
          {loading ? '识别中...' : '开始识别'}
        </button>
      </section>

      <section className="panel">
        <h2>识别结果</h2>
        {error && <p className="error-text">{error}</p>}
        <textarea
          className="result-text"
          value={resultText}
          readOnly
          placeholder="识别结果会显示在这里"
        />
      </section>
    </div>
  )
}

export default App
