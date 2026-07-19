import { useEffect, useState } from 'react'
import type { AppSettings, RuntimeConfig } from '../types'
import { listModelsDirect, listModelsViaWorker } from '../lib/api'
import { clearSettings, deriveIdentityTokenFromPassword, IDENTITY_TOKEN_MIN_LENGTH, isValidIdentityToken, maskSecret, normalizeIdentityToken, validateSpacePassword } from '../lib/storage'

const DEFAULT_IMAGE_MODEL = 'gpt-image-2'
const DEFAULT_PROMPT_MODEL = 'gpt-5.4-mini'

function uniqueOptions(...groups: string[][]) {
  return Array.from(new Set(groups.flat().map((item) => item.trim()).filter(Boolean)))
}

function isLocalPreview() {
  return (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost')
    && (window.location.port === '4173' || window.location.port === '5173')
}

function filterImageModels(models: string[]) {
  return models.filter((model) => /^gpt-image/i.test(model))
}

function filterPromptModels(models: string[]) {
  return models.filter((model) => /^gpt-.*mini/i.test(model) && !/image|tts|audio|transcribe|embedding|moderation|sora/i.test(model))
}

function selectValue(value: string, options: string[], customOpen: boolean) {
  return customOpen || !options.includes(value) ? '__custom__' : value
}

interface Props {
  open: boolean
  settings: AppSettings
  onClose: () => void
  onSave: (settings: AppSettings) => void
  onMessage: (message: string, type?: 'ok' | 'error') => void
  runtimeConfig?: RuntimeConfig | null
}

export function SettingsModal({ open, settings, onClose, onSave, onMessage, runtimeConfig }: Props) {
  const managedApi = runtimeConfig?.managedApi === true
  const [draft, setDraft] = useState(settings)
  const [spacePasswordDraft, setSpacePasswordDraft] = useState('')
  const [showSecrets, setShowSecrets] = useState(false)
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [customImageModelOpen, setCustomImageModelOpen] = useState(false)
  const [customPromptModelOpen, setCustomPromptModelOpen] = useState(false)

  useEffect(() => {
    if (open) {
      setDraft(managedApi && settings.requestMode === 'direct' ? { ...settings, requestMode: 'worker' } : settings)
      setSpacePasswordDraft('')
      setModelOptions([])
      setCustomImageModelOpen(false)
      setCustomPromptModelOpen(false)
    }
  }, [open, settings, managedApi])

  useEffect(() => {
    if (!open) return undefined

    const scrollY = window.scrollY
    const { style } = document.body
    const previous = {
      position: style.position,
      top: style.top,
      left: style.left,
      right: style.right,
      width: style.width,
      overflow: style.overflow,
    }

    style.position = 'fixed'
    style.top = `-${scrollY}px`
    style.left = '0'
    style.right = '0'
    style.width = '100%'
    style.overflow = 'hidden'

    return () => {
      style.position = previous.position
      style.top = previous.top
      style.left = previous.left
      style.right = previous.right
      style.width = previous.width
      style.overflow = previous.overflow
      window.scrollTo(0, scrollY)
    }
  }, [open])

  if (!open) return null

  async function save() {
    let identityToken = normalizeIdentityToken(draft.identityToken)
    const nextPassword = spacePasswordDraft.trim()
    if (nextPassword) {
      const validation = validateSpacePassword(nextPassword)
      if (!validation.ok) {
        onMessage(validation.message || `空间密码至少需要 ${IDENTITY_TOKEN_MIN_LENGTH} 位`, 'error')
        return
      }
      try {
        identityToken = await deriveIdentityTokenFromPassword(nextPassword)
      } catch (error) {
        onMessage(error instanceof Error ? error.message : '空间密码处理失败', 'error')
        return
      }
    }
    if (!isValidIdentityToken(identityToken)) {
      onMessage(`请设置至少 ${IDENTITY_TOKEN_MIN_LENGTH} 位的复杂空间密码`, 'error')
      return
    }
    onSave({ ...draft, requestMode: managedApi && draft.requestMode === 'direct' ? 'worker' : draft.requestMode, identityToken })
    onClose()
    onMessage('设置已保存到浏览器本地', 'ok')
  }

  async function refreshModels() {
    if (managedApi) {
      onMessage('服务端已托管 API 配置，无需手动获取模型列表', 'ok')
      return
    }
    if (!draft.baseUrl.trim()) {
      onMessage('请先填写 API URL', 'error')
      return
    }
    if (!draft.apiKey.trim()) {
      onMessage('请先填写 API Key', 'error')
      return
    }
    if (draft.requestMode !== 'direct' && !isLocalPreview() && !isValidIdentityToken(draft.identityToken)) {
      onMessage(`请先设置至少 ${IDENTITY_TOKEN_MIN_LENGTH} 位复杂空间密码`, 'error')
      return
    }

    setLoadingModels(true)
    try {
      const models = draft.requestMode === 'direct' || isLocalPreview()
        ? await listModelsDirect(draft.baseUrl, draft.apiKey)
        : await listModelsViaWorker(draft.baseUrl, draft.apiKey, draft.identityToken)
      setModelOptions(models)
      const imageCount = filterImageModels(models).length
      const promptCount = filterPromptModels(models).length
      onMessage(models.length ? `已获取 ${models.length} 个模型，可用生图 ${imageCount} 个，提示词 ${promptCount} 个` : '接口没有返回模型列表，可继续手动填写', models.length ? 'ok' : 'error')
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '获取模型列表失败', 'error')
    } finally {
      setLoadingModels(false)
    }
  }

  function clearLocal() {
    clearSettings()
    onSave({ ...settings, apiKey: '', identityToken: '' })
    onMessage('已清空浏览器内保存的配置', 'ok')
    onClose()
  }

  const imageModelOptions = uniqueOptions([DEFAULT_IMAGE_MODEL], filterImageModels(modelOptions), draft.model === DEFAULT_IMAGE_MODEL ? [] : [draft.model])
  const promptModelOptions = uniqueOptions([DEFAULT_PROMPT_MODEL], filterPromptModels(modelOptions), draft.promptModel === DEFAULT_PROMPT_MODEL ? [] : [draft.promptModel])

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-label="设置">
        <header className="modal-header">
          <div>
            <h2>设置</h2>
            <p>{managedApi ? 'API Key / URL 已由服务端托管；空间密码只保存不可逆派生结果。' : 'API Key / URL 保存在浏览器里；空间密码只保存不可逆派生结果。'}</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>×</button>
        </header>

        <div className="settings-grid">
          <div className="field full">
            <span>请求方式</span>
            <div className="request-mode-tabs">
              <button type="button" className={draft.requestMode === 'worker' ? 'active' : ''} onClick={() => setDraft((prev) => ({ ...prev, requestMode: 'worker' }))}>Worker 流式代理</button>
              <button type="button" className={draft.requestMode === 'background' ? 'active' : ''} onClick={() => setDraft((prev) => ({ ...prev, requestMode: 'background' }))}>Worker 后台任务</button>
              <button
                type="button"
                className={draft.requestMode === 'direct' ? 'active' : ''}
                disabled={managedApi}
                onClick={() => setDraft((prev) => ({ ...prev, requestMode: 'direct' }))}
                title={managedApi ? '服务端托管 API Key 时不可使用浏览器直连' : undefined}
              >浏览器直连</button>
            </div>
            <div className="mode-help">
              <p><strong>流式代理</strong>：默认推荐，前台等待结果，适合即时生成和查看错误。</p>
              <p><strong>后台任务</strong>：适合批量或耗时生成，切到后台也会继续执行；结果会上传图床并写入云端任务。</p>
              <p><strong>浏览器直连</strong>：链路最短，但需要上游支持 CORS；服务端托管 API Key 时不可选。</p>
            </div>
          </div>

          {managedApi ? (
            <div className="field full">
              <span>API 配置</span>
              <small>已由服务端托管：生图模型 {runtimeConfig?.imageModel || '默认'}，提示词模型 {runtimeConfig?.promptModel || '默认'}。</small>
            </div>
          ) : (
            <>
              <label className="field full">
                <span>API URL</span>
                <input value={draft.baseUrl} placeholder="https://api.openai.com/v1" onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
                <small>填写 API 根地址，例如 <code>https://api.example.com/v1</code>。</small>
              </label>

              <label className="field full">
                <span>API Key</span>
                <input type={showSecrets ? 'text' : 'password'} value={draft.apiKey} placeholder="sk-..." autoComplete="off" onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
                <small>当前：{maskSecret(draft.apiKey)}</small>
              </label>
            </>
          )}

          <label className="field full">
            <span>空间密码</span>
            <input type={showSecrets ? 'text' : 'password'} value={spacePasswordDraft} placeholder={`留空不修改；新密码至少 ${IDENTITY_TOKEN_MIN_LENGTH} 位，并包含多种字符`} autoComplete="new-password" onChange={(e) => setSpacePasswordDraft(e.target.value)} />
            <small>当前：{isValidIdentityToken(draft.identityToken) ? '已用不可逆算法保存' : '未设置'}。输入完全相同的空间密码会进入同一个云端任务空间；不同密码任务互相隔离。</small>
          </label>

          {!managedApi ? (
            <>
              <div className="field full">
                <div className="model-field-header">
                  <span>模型选择</span>
                  <button type="button" className="ghost-btn small" disabled={loadingModels} onClick={() => void refreshModels()}>{loadingModels ? '获取中...' : '获取模型列表'}</button>
                </div>
                <small>先从常用模型里选；点击获取后会合并你当前 API 返回的模型。下拉没有时仍可手动填写。</small>
              </div>

              <label className="field">
                <span>生图模型</span>
                <select value={selectValue(draft.model, imageModelOptions, customImageModelOpen)} onChange={(e) => {
                  if (e.target.value === '__custom__') {
                    setCustomImageModelOpen(true)
                    return
                  }
                  setCustomImageModelOpen(false)
                  setDraft({ ...draft, model: e.target.value })
                }}>
                  {imageModelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
                  <option value="__custom__">自定义模型...</option>
                </select>
                {customImageModelOpen || !imageModelOptions.includes(draft.model) ? <input value={draft.model} placeholder="gpt-image-2" onChange={(e) => setDraft({ ...draft, model: e.target.value })} /> : null}
              </label>

              <label className="field">
                <span>提示词模型</span>
                <select value={selectValue(draft.promptModel, promptModelOptions, customPromptModelOpen)} onChange={(e) => {
                  if (e.target.value === '__custom__') {
                    setCustomPromptModelOpen(true)
                    return
                  }
                  setCustomPromptModelOpen(false)
                  setDraft({ ...draft, promptModel: e.target.value })
                }}>
                  {promptModelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
                  <option value="__custom__">自定义模型...</option>
                </select>
                {customPromptModelOpen || !promptModelOptions.includes(draft.promptModel) ? <input value={draft.promptModel} placeholder="gpt-5.4-mini" onChange={(e) => setDraft({ ...draft, promptModel: e.target.value })} /> : null}
              </label>
            </>
          ) : null}

          <label className="field"><span>超时时间（秒）</span><input type="number" min={10} max={900} value={draft.timeoutSec} onChange={(e) => setDraft({ ...draft, timeoutSec: Number(e.target.value) })} /></label>
          <label className="field"><span>默认生成张数</span><input type="number" min={1} max={12} value={draft.count} onChange={(e) => setDraft({ ...draft, count: Number(e.target.value) })} /></label>
          <label className="field"><span>并发数</span><input type="number" min={1} max={6} value={draft.concurrency} onChange={(e) => setDraft({ ...draft, concurrency: Number(e.target.value) })} /></label>

          {!managedApi ? <label className="check-field full"><input type="checkbox" checked={showSecrets} onChange={(e) => setShowSecrets(e.target.checked)} />显示密钥和令牌</label> : null}
          <label className="check-field full"><input type="checkbox" checked={draft.autoUploadPixhost} onChange={(e) => setDraft({ ...draft, autoUploadPixhost: e.target.checked })} />生成成功后自动上传到 PiXhost 图床，结果图悬浮时可复制 URL</label>
          <small className="settings-note full">自动上传会把生成图片发送到第三方图床；后台任务模式下结果始终会自动上传并只保存图床直链。</small>
          <label className="check-field full"><input type="checkbox" checked={draft.rememberSecrets} onChange={(e) => setDraft({ ...draft, rememberSecrets: e.target.checked })} />长期保存到 localStorage；关闭后只保存到当前会话 sessionStorage</label>
        </div>

        <footer className="modal-actions">
          <button type="button" className="ghost-btn danger" onClick={clearLocal}>清空本地配置</button>
          <div className="spacer" />
          <button type="button" className="ghost-btn" onClick={onClose}>取消</button>
          <button type="button" className="primary-btn" onClick={save}>保存</button>
        </footer>
      </section>
    </div>
  )
}
