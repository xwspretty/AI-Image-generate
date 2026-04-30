import type { ChangeEvent } from 'react'
import type { InputImage } from '../types'
import { fileToInputImage } from '../lib/api'

interface Props {
  image: InputImage | null
  onChange: (image: InputImage | null) => void
  onError: (message: string) => void
}

const MAX_FILE_SIZE = 12 * 1024 * 1024
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp']

export function ImageUploader({ image, onChange, onError }: Props) {
  async function handleFile(file: File | undefined) {
    if (!file) return
    if (!ACCEPTED.includes(file.type)) {
      onError('仅支持 PNG / JPG / WebP 图片')
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      onError('图片不能超过 12MB；建议先压缩后再上传')
      return
    }
    onChange(await fileToInputImage(file))
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>) {
    void handleFile(event.target.files?.[0])
    event.target.value = ''
  }

  return (
    <div className="uploader">
      {image ? (
        <div className="upload-preview">
          <img src={image.dataUrl} alt="参考图预览" />
          <div className="upload-meta">
            <strong>{image.name}</strong>
            <span>{(image.size / 1024 / 1024).toFixed(2)} MB</span>
          </div>
          <button type="button" className="ghost-btn danger" onClick={() => onChange(null)}>移除</button>
        </div>
      ) : (
        <label
          className="dropzone"
          onDrop={(e) => {
            e.preventDefault()
            void handleFile(e.dataTransfer.files?.[0])
          }}
          onDragOver={(e) => e.preventDefault()}
        >
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleInput} />
          <span className="dropzone-icon">＋</span>
          <strong>上传参考图</strong>
          <small>点击或拖拽，支持 PNG / JPG / WebP</small>
        </label>
      )}
    </div>
  )
}
