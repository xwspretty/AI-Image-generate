import { useEffect, useRef, useState } from 'react'
import type { AppSettings, AspectRatio, GenerationTask, GenerateResultItem, HistoryItem, InputImage, Mode, ResolutionTier, WorkerTaskSnapshot } from './types'
import { RatioPicker } from './components/RatioPicker'
import { ResolutionPicker } from './components/ResolutionPicker'
import { ImageUploader } from './components/ImageUploader'
import { SettingsModal } from './components/SettingsModal'
import { HistoryPanel } from './components/HistoryPanel'
import { TaskQueue } from './components/TaskQueue'
import { createId, createWorkerGenerationTask, generateImagesDirect, generateImagesStream, getWorkerGenerationTask, uploadImageToPixhost } from './lib/api'
import { addHistory, clearHistory, deleteHistory, getHistory, updateHistoryImageUrl } from './lib/db'
import { getImageSize, getResolutionLabel } from './lib/ratios'
import { DEFAULT_SETTINGS, loadActiveWorkerTasks, rememberActiveWorkerTask, removeActiveWorkerTask, loadSettings, saveSettings } from './lib/storage'
import './styles.css'

type Message = { text: string; type: 'ok' | 'error' | 'info' } | null

type UploadResult = { index: number; remoteUrl: string; remoteThumbUrl?: string }

type GenerationPayload = {
  mode: Mode
  prompt: string
  ratio: AspectRatio
  resolution: ResolutionTier
  model: string
  baseUrl: string
  apiKey: string
  timeoutSec: number
  count: number
  concurrency: number
  inputImages: InputImage[]
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('text-to-image')
  const [prompt, setPrompt] = useState('')
  const [ratio, setRatio] = useState<AspectRatio>(() => loadSettings().defaultRatio)
  const [resolution, setResolution] = useState<ResolutionTier>(() => loadSettings().defaultResolution)
  const [inputImages, setInputImages] = useState<InputImage[]>([])
  const [tasks, setTasks] = useState<GenerationTask[]>([])
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [historyCollapsed, setHistoryCollapsed] = useState(false)
  const [message, setMessage] = useState<Message>(null)
  const uploadCacheRef = useRef(new Map<string, Map<number, UploadResult>>())
  const uploadInFlightRef = useRef(new Set<string>())
  const workerPollingRef = useRef(new Set<string>())
  const workerFinalizedRef = useRef(new Set<string>())

  useEffect(() => {
    void refreshHistory()
    void restoreActiveWorkerTasks()
  }, [])

  useEffect(() => {
    const recover = () => {
      if (!document.hidden) void restoreActiveWorkerTasks()
    }
    document.addEventListener('visibilitychange', recover)
    window.addEventListener('focus', recover)
    return () => {
      document.removeEventListener('visibilitychange', recover)
      window.removeEventListener('focus', recover)
    }
  }, [])

  useEffect(() => {
    setRatio(settings.defaultRatio)
  }, [settings.defaultRatio])

  useEffect(() => {
    setResolution(settings.defaultResolution)
  }, [settings.defaultResolution])

  function showMessage(text: string, type: 'ok' | 'error' | 'info' = 'info') {
    setMessage({ text, type })
  }

  function patchSettings(patch: Partial<AppSettings>) {
    updateSettings({ ...settings, ...patch })
  }

  function patchTask(id: string, patch: Partial<GenerationTask>) {
    setTasks((prev) => prev.map((task) => task.id === id ? { ...task, ...patch } : task))
  }

  function updateTaskResult(taskId: string, result: GenerateResultItem) {
    setTasks((prev) => prev.map((task) => {
      if (task.id !== taskId) return task
      const nextResults = [...task.results]
      nextResults[result.index] = { ...nextResults[result.index], ...result }
      return { ...task, results: nextResults.filter(Boolean) }
    }))
  }

  function patchTaskResult(taskId: string, index: number, patch: Partial<GenerateResultItem>) {
    setTasks((prev) => prev.map((task) => {
      if (task.id !== taskId) return task
      const nextResults = [...task.results]
      const existing = nextResults.find((item) => item.index === index) || nextResults[index]
      if (!existing) return task
      const merged = { ...existing, ...patch, index }
      const slot = nextResults.findIndex((item) => item.index === index)
      if (slot >= 0) nextResults[slot] = merged
      else nextResults[index] = merged
      return { ...task, results: nextResults.filter(Boolean) }
    }))
  }

  function rememberUploadResult(taskId: string, uploaded: UploadResult) {
    const taskUploads = uploadCacheRef.current.get(taskId) || new Map<number, UploadResult>()
    taskUploads.set(uploaded.index, uploaded)
    uploadCacheRef.current.set(taskId, taskUploads)
  }

  function collectCachedUploads(taskId: string, target: Map<number, UploadResult>) {
    const cachedUploads = uploadCacheRef.current.get(taskId)
    if (!cachedUploads) return
    for (const [index, uploaded] of cachedUploads) {
      target.set(index, uploaded)
    }
  }

  function mergeTaskResults(
    incoming: GenerateResultItem[],
    local: GenerateResultItem[] = [],
    uploadedByIndex = new Map<number, UploadResult>(),
  ) {
    const localByIndex = new Map(local.map((item) => [item.index, item]))
    return incoming
      .map((item) => {
        const localItem = localByIndex.get(item.index)
        const uploaded = uploadedByIndex.get(item.index)
        return {
          ...item,
          remoteUrl: uploaded?.remoteUrl || localItem?.remoteUrl || item.remoteUrl,
          remoteThumbUrl: uploaded?.remoteThumbUrl || localItem?.remoteThumbUrl || item.remoteThumbUrl,
          uploading: localItem?.uploading,
          uploadError: localItem?.uploadError,
        }
      })
      .sort((a, b) => a.index - b.index)
  }

  function upsertWorkerTask(snapshot: WorkerTaskSnapshot) {
    setTasks((prev) => {
      const existing = prev.find((task) => task.id === snapshot.id)
      const uploadedByIndex = new Map<number, UploadResult>()
      collectCachedUploads(snapshot.id, uploadedByIndex)
      const nextTask: GenerationTask = {
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        mode: snapshot.mode,
        requestMode: 'worker',
        prompt: snapshot.prompt,
        ratio: snapshot.ratio,
        resolution: snapshot.resolution,
        size: snapshot.size,
        model: snapshot.model,
        count: snapshot.count,
        concurrency: snapshot.concurrency,
        status: snapshot.status,
        results: mergeTaskResults(snapshot.results, existing?.results, uploadedByIndex),
        elapsedMs: snapshot.elapsedMs,
        error: snapshot.error,
      }

      if (existing) {
        return prev.map((task) => task.id === snapshot.id ? nextTask : task)
      }
      return [nextTask, ...prev]
    })
  }

  function completeTask(taskId: string, responseResults: GenerateResultItem[], elapsedMs: number) {
    setTasks((prev) => prev.map((task) => {
      if (task.id !== taskId) return task
      const uploadedByIndex = new Map<number, UploadResult>()
      collectCachedUploads(taskId, uploadedByIndex)
      const merged = mergeTaskResults(responseResults, task.results, uploadedByIndex)
      return { ...task, status: 'completed', results: merged, elapsedMs }
    }))
  }

  function updateSettings(next: AppSettings) {
    const normalized = {
      ...DEFAULT_SETTINGS,
      ...next,
      count: Math.max(1, Math.min(12, Math.round(Number(next.count) || DEFAULT_SETTINGS.count))),
      concurrency: Math.max(1, Math.min(6, Math.round(Number(next.concurrency) || DEFAULT_SETTINGS.concurrency))),
      timeoutSec: Math.max(10, Math.min(900, Math.round(Number(next.timeoutSec) || DEFAULT_SETTINGS.timeoutSec))),
      defaultRatio: next.defaultRatio,
      defaultResolution: next.defaultResolution,
      autoUploadPixhost: next.autoUploadPixhost === true,
    }
    setSettings(normalized)
    saveSettings(normalized)
  }

  async function refreshHistory() {
    setHistory(await getHistory())
  }

  function validateBeforeGenerate() {
    if (settings.requestMode === 'worker' && !settings.accessPassword.trim()) return '请先在设置里填写 Worker 访问密码'
    if (settings.autoUploadPixhost && !settings.accessPassword.trim()) return '自动上传图床需要 Worker 访问密码'
    if (!settings.baseUrl.trim()) return '请先填写 API URL'
    if (!settings.apiKey.trim()) return '请先填写 API Key'
    if (!settings.model.trim()) return '请先填写模型名称'
    if (!prompt.trim()) return '请输入提示词'
    if (mode === 'image-to-image' && inputImages.length === 0) return '图生图模式需要先上传参考图'
    return ''
  }

  function handleGenerate() {
    const invalid = validateBeforeGenerate()
    if (invalid) {
      showMessage(invalid, 'error')
      setSettingsOpen(true)
      return
    }

    setMessage(null)
    updateSettings(settings)

    const startedAt = Date.now()
    const taskId = createId('task')
    const payload = {
      mode,
      prompt: prompt.trim(),
      ratio,
      resolution,
      model: settings.model.trim(),
      baseUrl: settings.baseUrl.trim(),
      apiKey: settings.apiKey.trim(),
      timeoutSec: settings.timeoutSec,
      count: settings.count,
      concurrency: settings.concurrency,
      inputImages: mode === 'image-to-image' ? inputImages.map((image) => ({ ...image })) : [],
    }

    if (settings.requestMode === 'worker') {
      showMessage('后台任务提交中，切到后台后 Worker 会继续生成', 'info')
      void submitWorkerBackgroundTask(payload, settings.accessPassword, settings.autoUploadPixhost)
      return
    }

    const task: GenerationTask = {
      id: taskId,
      createdAt: startedAt,
      mode,
      requestMode: settings.requestMode,
      prompt: payload.prompt,
      ratio,
      resolution,
      size,
      model: payload.model,
      count: payload.count,
      concurrency: payload.concurrency,
      status: 'running',
      results: [],
    }
    setTasks((prev) => [task, ...prev])
    showMessage('任务已提交，可以继续提交新任务', 'ok')
    void runGenerationTask(taskId, payload, settings.requestMode, settings.accessPassword, settings.autoUploadPixhost, startedAt)
  }

  async function submitWorkerBackgroundTask(
    payload: GenerationPayload,
    accessPassword: string,
    autoUploadPixhost: boolean,
  ) {
    try {
      const snapshot = await createWorkerGenerationTask(payload, accessPassword)
      rememberActiveWorkerTask({
        id: snapshot.id,
        accessPassword,
        autoUploadPixhost,
        savedAt: Date.now(),
      })
      upsertWorkerTask(snapshot)
      showMessage('后台任务已提交，可以切到后台；回到前台会自动恢复结果', 'ok')
      void pollWorkerTask(snapshot.id, accessPassword, autoUploadPixhost)
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '后台任务提交失败', 'error')
    }
  }

  async function restoreActiveWorkerTasks() {
    const activeTasks = loadActiveWorkerTasks()
    if (!activeTasks.length) return

    for (const record of activeTasks) {
      if (workerPollingRef.current.has(record.id) || workerFinalizedRef.current.has(record.id)) continue
      void pollWorkerTask(record.id, record.accessPassword, record.autoUploadPixhost, true)
    }
  }

  async function pollWorkerTask(
    taskId: string,
    accessPassword: string,
    autoUploadPixhost: boolean,
    restored = false,
  ) {
    if (workerPollingRef.current.has(taskId)) return
    workerPollingRef.current.add(taskId)

    let retryCount = 0
    try {
      while (true) {
        try {
          const snapshot = await getWorkerGenerationTask(taskId, accessPassword)
          retryCount = 0
          upsertWorkerTask(snapshot)

          if (restored && snapshot.status === 'running') {
            restored = false
            showMessage('已恢复后台生成任务，正在等待结果', 'info')
          }

          if (snapshot.status !== 'running') {
            await finalizeWorkerSnapshot(snapshot, accessPassword, autoUploadPixhost)
            break
          }

          await delay(document.hidden ? 10_000 : 3_000)
        } catch (error) {
          retryCount += 1
          const message = error instanceof Error ? error.message : '后台任务查询失败'

          if (/401|访问密码|密码错误|auth/i.test(message)) {
            patchTask(taskId, { status: 'failed', error: message })
            removeActiveWorkerTask(taskId)
            showMessage(message, 'error')
            break
          }

          if (/404|不存在|过期|not found/i.test(message)) {
            patchTask(taskId, { status: 'failed', error: message })
            removeActiveWorkerTask(taskId)
            showMessage(message, 'error')
            break
          }

          patchTask(taskId, {
            status: 'running',
            error: `后台任务等待恢复中：${message}`,
          })
          if (!document.hidden && retryCount === 1) {
            showMessage('后台任务连接中断，回到前台后会继续尝试恢复', 'info')
          }
          await delay(document.hidden ? 15_000 : Math.min(15_000, 3_000 * retryCount))
        }
      }
    } finally {
      workerPollingRef.current.delete(taskId)
    }
  }

  async function finalizeWorkerSnapshot(
    snapshot: WorkerTaskSnapshot,
    accessPassword: string,
    autoUploadPixhost: boolean,
  ) {
    if (workerFinalizedRef.current.has(snapshot.id)) return
    workerFinalizedRef.current.add(snapshot.id)

    if (snapshot.status === 'failed') {
      upsertWorkerTask(snapshot)
      removeActiveWorkerTask(snapshot.id)
      showMessage(snapshot.error || '后台任务失败', 'error')
      return
    }

    let finalResults = snapshot.results
    if (autoUploadPixhost) {
      await Promise.allSettled(
        snapshot.results.map((result) => uploadGeneratedResult(snapshot.id, result, accessPassword)),
      )
      const uploadedByIndex = new Map<number, UploadResult>()
      collectCachedUploads(snapshot.id, uploadedByIndex)
      finalResults = mergeTaskResults(snapshot.results, [], uploadedByIndex)
      completeTask(snapshot.id, finalResults, snapshot.elapsedMs || Date.now() - snapshot.createdAt)
    }

    const okResults = finalResults.filter((item) => item.ok && item.image)
    const okImages = okResults.map((item) => item.image!)
    const failedCount = snapshot.count - okImages.length

    if (okImages.length) {
      await addHistory({
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        mode: snapshot.mode,
        prompt: snapshot.prompt,
        ratio: snapshot.ratio,
        resolution: snapshot.resolution,
        size: snapshot.size,
        model: snapshot.model,
        images: okImages,
        imageResultIndexes: okResults.map((item) => item.index),
        remoteUrls: okResults.map((item) => item.remoteUrl || ''),
        remoteThumbUrls: okResults.map((item) => item.remoteThumbUrl || ''),
        failedCount,
        elapsedMs: snapshot.elapsedMs || Date.now() - snapshot.createdAt,
      })
      await refreshHistory()
    }

    removeActiveWorkerTask(snapshot.id)
    showMessage(
      failedCount ? `后台任务完成 ${okImages.length} 张，失败 ${failedCount} 张` : `后台任务成功生成 ${okImages.length} 张图片`,
      failedCount ? 'info' : 'ok',
    )
  }

  async function runGenerationTask(
    taskId: string,
    payload: GenerationPayload,
    requestMode: AppSettings['requestMode'],
    accessPassword: string,
    autoUploadPixhost: boolean,
    startedAt: number,
  ) {
    try {
      let lastPingAt = 0
      const uploadPromises: Array<Promise<UploadResult | null>> = []
      const handleResult = (result: GenerateResultItem) => {
        updateTaskResult(taskId, result)
        if (autoUploadPixhost) {
          uploadPromises.push(uploadGeneratedResult(taskId, result, accessPassword))
        }
      }
      const response = requestMode === 'direct'
        ? await generateImagesDirect(payload, handleResult)
        : await generateImagesStream(payload, accessPassword, (event) => {
            if (event.event === 'result') handleResult(event.data)
            if (event.event === 'ping' && Date.now() - lastPingAt > 30_000) {
              lastPingAt = Date.now()
              showMessage('Worker 代理连接保持中...', 'info')
            }
          })

      completeTask(taskId, response.results, response.elapsedMs)

      const uploadedByIndex = new Map<number, UploadResult>()
      collectCachedUploads(taskId, uploadedByIndex)
      if (uploadPromises.length) {
        const settled = await Promise.allSettled(uploadPromises)
        for (const item of settled) {
          if (item.status === 'fulfilled' && item.value) {
            uploadedByIndex.set(item.value.index, item.value)
          }
        }
      }
      collectCachedUploads(taskId, uploadedByIndex)

      const historyResults = response.results.map((item) => ({
        ...item,
        remoteUrl: uploadedByIndex.get(item.index)?.remoteUrl || item.remoteUrl,
        remoteThumbUrl: uploadedByIndex.get(item.index)?.remoteThumbUrl || item.remoteThumbUrl,
      }))
      const okResults = historyResults.filter((item) => item.ok && item.image)
      const okImages = okResults.map((item) => item.image!)
      const failedCount = response.results.length - okImages.length

      if (uploadedByIndex.size) {
        completeTask(taskId, historyResults, response.elapsedMs)
      }

      if (okImages.length) {
        await addHistory({
          id: taskId,
          createdAt: startedAt,
          mode: payload.mode,
          prompt: payload.prompt,
          ratio: payload.ratio,
          resolution: payload.resolution,
          size: response.size,
          model: response.model,
          images: okImages,
          imageResultIndexes: okResults.map((item) => item.index),
          remoteUrls: okResults.map((item) => item.remoteUrl || ''),
          remoteThumbUrls: okResults.map((item) => item.remoteThumbUrl || ''),
          failedCount,
          elapsedMs: response.elapsedMs,
        })
        await refreshHistory()
      }

      showMessage(
        failedCount ? `任务完成 ${okImages.length} 张，失败 ${failedCount} 张` : `任务成功生成 ${okImages.length} 张图片`,
        failedCount ? 'info' : 'ok',
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成失败'
      patchTask(taskId, {
        status: 'failed',
        error: message,
        elapsedMs: Date.now() - startedAt,
      })
      showMessage(message, 'error')
    }
  }

  async function uploadGeneratedResult(
    taskId: string,
    result: GenerateResultItem,
    accessPassword: string,
    notify = false,
  ): Promise<UploadResult | null> {
    if (!result.ok || !result.image) return null
    const cached = uploadCacheRef.current.get(taskId)?.get(result.index)
    if (cached) return cached
    const uploadKey = `${taskId}:${result.index}`
    if (uploadInFlightRef.current.has(uploadKey)) return null
    uploadInFlightRef.current.add(uploadKey)

    patchTaskResult(taskId, result.index, { uploading: true, uploadError: undefined })
    try {
      const uploaded = await uploadImageToPixhost(
        result.image,
        `ai-image-${taskId}-${result.index + 1}.png`,
        accessPassword,
      )
      const uploadResult = { index: result.index, ...uploaded }
      patchTaskResult(taskId, result.index, {
        uploading: false,
        remoteUrl: uploaded.remoteUrl,
        remoteThumbUrl: uploaded.remoteThumbUrl,
        uploadError: undefined,
      })
      rememberUploadResult(taskId, uploadResult)
      if (notify) showMessage('图床上传成功，URL 已可复制', 'ok')
      return uploadResult
    } catch (error) {
      const message = error instanceof Error ? error.message : '图床上传失败'
      patchTaskResult(taskId, result.index, {
        uploading: false,
        uploadError: message,
      })
      if (notify) showMessage(message, 'error')
      return null
    } finally {
      uploadInFlightRef.current.delete(uploadKey)
    }
  }

  function handleUploadImage(taskId: string, result: GenerateResultItem) {
    if (!settings.accessPassword.trim()) {
      showMessage('上传图床需要先填写 Worker 访问密码', 'error')
      setSettingsOpen(true)
      return
    }
    if (result.uploading) return
    void uploadGeneratedResult(taskId, result, settings.accessPassword, true).then(async (uploaded) => {
      if (!uploaded) return
      await updateHistoryImageUrl(taskId, uploaded.index, uploaded.remoteUrl, uploaded.remoteThumbUrl)
      await refreshHistory()
    })
  }

  function handleUseAsReference(dataUrl: string) {
    const nextImage = {
      id: createId('ref'),
      name: 'generated-reference.png',
      type: dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png',
      dataUrl,
      size: dataUrl.length,
    }
    setInputImages((prev) => {
      if (prev.length >= 8) {
        showMessage('参考图最多 8 张，已替换为当前图片', 'info')
        return [nextImage]
      }
      return [...prev, nextImage]
    })
    setMode('image-to-image')
    showMessage('已放入图生图参考图', 'ok')
  }

  async function handleDeleteHistory(id: string) {
    await deleteHistory(id)
    await refreshHistory()
  }

  async function handleClearHistory() {
    if (!confirm('确认清空本地历史记录？')) return
    await clearHistory()
    await refreshHistory()
  }

  function removeTask(id: string) {
    uploadCacheRef.current.delete(id)
    setTasks((prev) => prev.filter((task) => task.id !== id))
  }

  function clearFinishedTasks() {
    setTasks((prev) => prev.filter((task) => task.status === 'running'))
  }

  const size = getImageSize(ratio, resolution)

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">AI</div>
          <div>
            <h1>AI Image Generate</h1>
            <p>自定义 URL / Key 的私人生图工作台</p>
          </div>
        </div>
        <div className="top-actions">
          <div className="config-pill" title={settings.baseUrl}>
            <span>{settings.requestMode === 'worker' ? 'Worker 代理' : '浏览器直连'}</span>
          </div>
          <button type="button" className="secondary-btn" onClick={() => setSettingsOpen(true)}>设置</button>
        </div>
      </header>

      {message ? (
        <div className={`toast ${message.type}`}>
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)}>×</button>
        </div>
      ) : null}

      <main className={`workspace ${historyCollapsed ? 'history-collapsed' : ''}`}>
        <aside className="sidebar">
          <section className="panel">
            <label className="label">模式</label>
            <div className="mode-tabs">
              <button type="button" className={mode === 'text-to-image' ? 'active' : ''} onClick={() => setMode('text-to-image')}>文生图</button>
              <button type="button" className={mode === 'image-to-image' ? 'active' : ''} onClick={() => setMode('image-to-image')}>图生图</button>
            </div>
          </section>

          <section className="panel">
            <label className="label" htmlFor="prompt">提示词</label>
            <textarea
              id="prompt"
              className="prompt-input"
              placeholder={mode === 'text-to-image' ? '描述你想生成的内容...' : '描述你希望如何修改这张图...'}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </section>

          {mode === 'image-to-image' ? (
            <section className="panel">
              <label className="label">参考图片</label>
              <ImageUploader images={inputImages} onChange={setInputImages} onError={(text) => showMessage(text, 'error')} />
            </section>
          ) : null}

          <section className="panel">
            <label className="label">模型</label>
            <input
              className="text-input"
              value={settings.model}
              onChange={(e) => patchSettings({ model: e.target.value })}
              placeholder="gpt-image-2"
            />
          </section>

          <section className="panel">
            <div className="label-row">
              <label className="label">比例</label>
              <span>{ratio === 'auto' ? '自动' : ratio}</span>
            </div>
            <RatioPicker
              value={ratio}
              onChange={(next) => {
                setRatio(next)
                patchSettings({ defaultRatio: next })
              }}
            />
          </section>

          <section className="panel">
            <div className="label-row">
              <label className="label">分辨率档位</label>
              <span>{getResolutionLabel(resolution)}</span>
            </div>
            <ResolutionPicker
              value={resolution}
              onChange={(next) => {
                setResolution(next)
                patchSettings({ defaultResolution: next })
              }}
            />
            <small className="hint-text">比例或分辨率选「自动」时不传 size，由上游模型自行决定。</small>
          </section>

          <section className="panel split-2">
            <label className="field compact">
              <span>张数</span>
              <input type="number" min={1} max={12} value={settings.count} onChange={(e) => patchSettings({ count: Number(e.target.value) })} />
            </label>
            <label className="field compact">
              <span>超时</span>
              <input type="number" min={10} max={900} value={settings.timeoutSec} onChange={(e) => patchSettings({ timeoutSec: Number(e.target.value) })} />
            </label>
          </section>

          <button type="button" className="generate-btn" onClick={handleGenerate}>
            提交任务（{settings.count} 张）
          </button>
        </aside>

        <section className="canvas-area">
          <div className="canvas-header">
            <div>
              <h2>生成结果</h2>
              <p>{mode === 'image-to-image' ? '图生图' : '文生图'} · {ratio} · {getResolutionLabel(resolution)} · {size} · {settings.requestMode === 'worker' ? 'Worker 后台代理' : '浏览器直连'} · 并发 {settings.concurrency}</p>
            </div>
          </div>
          <TaskQueue
            tasks={tasks}
            onUploadImage={handleUploadImage}
            onUseAsReference={handleUseAsReference}
            onMessage={showMessage}
            onRemove={removeTask}
            onClearFinished={clearFinishedTasks}
          />
        </section>

        <HistoryPanel
          items={history}
          collapsed={historyCollapsed}
          onToggleCollapsed={() => setHistoryCollapsed((prev) => !prev)}
          onReusePrompt={(value) => {
            setPrompt(value)
            showMessage('提示词已复用', 'ok')
          }}
          onUseImage={handleUseAsReference}
          onDelete={handleDeleteHistory}
          onClear={handleClearHistory}
          onMessage={showMessage}
        />
      </main>

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={updateSettings}
        onMessage={showMessage}
      />
    </div>
  )
}

