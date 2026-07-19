import type { ChangeEvent } from 'react'
import type { InputImage } from '../types'
import { fileToInputImage } from '../lib/api'

interface Props {
  images: InputImage[]
  maxImages?: number
  maxTotalSize?: number
  onChange: (images: InputImage[]) => void
  onError: (message: string) => void
}

const MAX_FILE_SIZE = 12 * 1024 * 1024
const DEFAULT_MAX_IMAGES = 8
const DEFAULT_MAX_TOTAL_SIZE = 50 * 1024 * 1024
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp']

export function ImageUploader({
  images,
  maxImages = DEFAULT_MAX_IMAGES,
  maxTotalSize = DEFAULT_MAX_TOTAL_SIZE,
  onChange,
  onError,
}: Props) {
  async function addFiles(fileList: FileList | File[] | undefined | null) {
    const files = Array.from(fileList || [])
    if (!files.length) return

    const availableSlots = maxImages - images.length
    if (availableSlots <= 0) {
      onError(`最多只能上传 ${maxImages} 张参考图`)
      return
    }

    const acceptedFiles: File[] = []
    for (const file of files.slice(0, availableSlots)) {
      if (!ACCEPTED.includes(file.type)) {
        onError(`${file.name} 格式不支持，仅支持 PNG / JPG / WebP`)
        continue
      }
      if (file.size > MAX_FILE_SIZE) {
        onError(`${file.name} 超过 12MB，请先压缩`)
        continue
      }
      acceptedFiles.push(file)
    }

    if (files.length > availableSlots) {
      onError(`已达到上限，本次只添加 ${availableSlots} 张`)
    }

    if (!acceptedFiles.length) return

    const currentTotal = images.reduce((sum, image) => sum + image.size, 0)
    const nextFileTotal = acceptedFiles.reduce((sum, file) => sum + file.size, 0)
    if (currentTotal + nextFileTotal > maxTotalSize) {
      onError(`参考图总大小不能超过 ${(maxTotalSize / 1024 / 1024).toFixed(0)}MB`)
      return
    }

    const nextImages = await Promise.all(acceptedFiles.map(fileToInputImage))
    onChange([...images, ...nextImages])
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>) {
    void addFiles(event.target.files)
    event.target.value = ''
  }

  function removeImage(id: string) {
    onChange(images.filter((image) => image.id !== id))
  }

  function clearAll() {
    onChange([])
  }

  const totalSize = images.reduce((sum, image) => sum + image.size, 0)
  const canAdd = images.length < maxImages

  return (
    <div className="uploader">
      <div className="upload-header-line">
        <span>{images.length}/{maxImages}</span>
        <small>{(totalSize / 1024 / 1024).toFixed(1)}MB / {(maxTotalSize / 1024 / 1024).toFixed(0)}MB</small>
      </div>
      <div
        className="upload-list"
        onDrop={(e) => {
          e.preventDefault()
          void addFiles(e.dataTransfer.files)
        }}
        onDragOver={(e) => e.preventDefault()}
      >
        {images.map((image, index) => (
          <article key={image.id} className="upload-item" title={`${image.name} · ${(image.size / 1024 / 1024).toFixed(2)} MB`}>
            <img src={image.dataUrl} alt={`参考图 ${index + 1}`} />
            <div className="upload-item-info">
              <strong>{image.name}</strong>
              <span>#{index + 1} · {(image.size / 1024 / 1024).toFixed(2)} MB</span>
            </div>
            <button type="button" className="mini-danger-btn" onClick={() => removeImage(image.id)}>移除</button>
          </article>
        ))}
        {canAdd ? (
          <label className="dropzone compact">
            <input type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={handleInput} />
            <span className="dropzone-icon">＋</span>
            <strong>添加</strong>
            <small>拖拽/多选</small>
          </label>
        ) : null}
        {images.length ? <button type="button" className="ghost-btn danger" onClick={clearAll}>清空参考图</button> : null}
      </div>
    </div>
  )
}
