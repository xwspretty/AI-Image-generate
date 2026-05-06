import type { AppSettings, AspectRatio, ResolutionTier } from '../types'
import { normalizeRatioForResolution } from './ratios'

const SETTINGS_KEY = 'ai-image-generate:settings:v1'
const SESSION_SETTINGS_KEY = 'ai-image-generate:session-settings:v1'
const ACTIVE_BACKGROUND_TASKS_KEY = 'ai-image-generate:active-background-tasks:v1'
const SCOPED_ACTIVE_BACKGROUND_TASKS_KEY = 'ai-image-generate:active-background-tasks:v2'
export const IDENTITY_TOKEN_MIN_LENGTH = 10
const DERIVED_IDENTITY_TOKEN_RE = /^[a-f0-9]{64}$/i

export const DEFAULT_SETTINGS: AppSettings = {
  requestMode: 'worker',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  identityToken: '',
  model: 'gpt-image-2',
  timeoutSec: 420,
  count: 1,
  concurrency: 2,
  defaultRatio: '1:1',
  defaultResolution: 'standard',
  autoUploadPixhost: false,
  rememberSecrets: true,
}

function normalizeRatio(value: unknown): AspectRatio {
  return value === 'auto' || value === '1:1' || value === '2:3' || value === '3:2' || value === '3:4' || value === '4:3' || value === '9:16' || value === '16:9'
    ? value
    : DEFAULT_SETTINGS.defaultRatio
}

function normalizeResolution(value: unknown): ResolutionTier {
  return value === 'auto' || value === 'standard' || value === '2k' || value === '4k'
    ? value
    : DEFAULT_SETTINGS.defaultResolution
}

function sanitizeSettings(raw: Partial<AppSettings>): AppSettings {
  const defaultResolution = normalizeResolution(raw.defaultResolution)
  const defaultRatio = normalizeRatioForResolution(normalizeRatio(raw.defaultRatio), defaultResolution)
  const identityToken = normalizeIdentityToken(raw.identityToken)
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    requestMode: raw.requestMode === 'direct' || raw.requestMode === 'background' ? raw.requestMode : DEFAULT_SETTINGS.requestMode,
    timeoutSec: clampNumber(raw.timeoutSec, DEFAULT_SETTINGS.timeoutSec, 10, 900),
    count: clampNumber(raw.count, DEFAULT_SETTINGS.count, 1, 12),
    concurrency: clampNumber(raw.concurrency, DEFAULT_SETTINGS.concurrency, 1, 6),
    defaultRatio,
    defaultResolution,
    identityToken,
    autoUploadPixhost: raw.autoUploadPixhost === true,
    rememberSecrets: raw.rememberSecrets !== false,
  }
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.round(num)))
}

export function loadSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const session = sessionStorage.getItem(SESSION_SETTINGS_KEY)
    if (session) {
      const parsed = JSON.parse(session) as Partial<AppSettings>
      const sanitized = sanitizeSettings(parsed)
      if (typeof parsed.identityToken === 'string' && parsed.identityToken && parsed.identityToken !== sanitized.identityToken) {
        sessionStorage.setItem(SESSION_SETTINGS_KEY, JSON.stringify(sanitized))
      }
      return sanitized
    }

    const saved = localStorage.getItem(SETTINGS_KEY)
    if (!saved) return DEFAULT_SETTINGS
    const parsed = JSON.parse(saved) as Partial<AppSettings>
    const sanitized = sanitizeSettings(parsed)
    if (typeof parsed.identityToken === 'string' && parsed.identityToken && parsed.identityToken !== sanitized.identityToken) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitized))
    }
    return sanitized
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: AppSettings) {
  if (typeof window === 'undefined') return
  const normalized = sanitizeSettings(settings)
  if (normalized.rememberSecrets) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized))
    sessionStorage.removeItem(SESSION_SETTINGS_KEY)
  } else {
    sessionStorage.setItem(SESSION_SETTINGS_KEY, JSON.stringify(normalized))
    localStorage.removeItem(SETTINGS_KEY)
  }
}

export function clearSettings() {
  localStorage.removeItem(SETTINGS_KEY)
  sessionStorage.removeItem(SESSION_SETTINGS_KEY)
}

export interface ActiveBackgroundTask {
  id: string
  createdAt: number
}

export function normalizeIdentityToken(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return DERIVED_IDENTITY_TOKEN_RE.test(normalized) ? normalized : ''
}

export function isValidIdentityToken(value: unknown) {
  return Boolean(normalizeIdentityToken(value))
}

export function validateSpacePassword(value: unknown): { ok: boolean; message?: string } {
  const password = typeof value === 'string' ? value.trim() : ''
  if (password.length < IDENTITY_TOKEN_MIN_LENGTH) {
    return { ok: false, message: `空间密码至少需要 ${IDENTITY_TOKEN_MIN_LENGTH} 位` }
  }

  const compact = password.replace(/\s+/g, '')
  const lower = compact.toLowerCase()
  if (!compact) return { ok: false, message: '空间密码不能只包含空格' }
  if (/^(.)\1+$/.test(compact)) return { ok: false, message: '空间密码过于简单：不能使用同一个字符重复' }
  if (/(.)\1{5,}/.test(compact)) return { ok: false, message: '空间密码过于简单：不能包含大量连续重复字符' }
  if (isSequential(lower)) return { ok: false, message: '空间密码过于简单：不能使用连续数字或连续字母' }
  if (hasRepeatedPattern(lower)) return { ok: false, message: '空间密码过于简单：不能使用重复片段' }
  if (containsKeyboardSequence(lower)) return { ok: false, message: '空间密码过于简单：不能使用键盘顺序' }
  if (containsWeakWord(lower)) return { ok: false, message: '空间密码过于简单：不能使用常见弱密码词' }
  if (isDateLike(lower)) return { ok: false, message: '空间密码过于简单：不能使用明显日期或年份重复' }

  const categories = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^a-zA-Z0-9]/.test(password),
  ].filter(Boolean).length
  if (categories < 3) {
    return { ok: false, message: '空间密码过于简单：建议同时包含大小写字母、数字和符号中的至少三类' }
  }

  return { ok: true }
}

export async function deriveIdentityTokenFromPassword(password: string) {
  const normalized = password.trim()
  const validation = validateSpacePassword(normalized)
  if (!validation.ok) throw new Error(validation.message || '空间密码过于简单')
  const bytes = new TextEncoder().encode(`ai-image-generate-owner:v1:${normalized}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return bytesToHex(new Uint8Array(digest))
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function isSequential(value: string) {
  if (value.length < IDENTITY_TOKEN_MIN_LENGTH) return false
  const digits = '012345678901234567890'
  const reverseDigits = '098765432109876543210'
  const letters = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz'
  const reverseLetters = 'zyxwvutsrqponmlkjihgfedcbazyxwvutsrqponmlkjihgfedcba'
  return digits.includes(value) || reverseDigits.includes(value) || letters.includes(value) || reverseLetters.includes(value)
}

function hasRepeatedPattern(value: string) {
  for (let size = 1; size <= Math.floor(value.length / 2); size += 1) {
    if (value.length % size !== 0) continue
    const part = value.slice(0, size)
    if (part.repeat(value.length / size) === value) return true
  }
  return false
}

function containsKeyboardSequence(value: string) {
  const keyboardRows = [
    'qwertyuiop',
    'poiuytrewq',
    'asdfghjkl',
    'lkjhgfdsa',
    'zxcvbnm',
    'mnbvcxz',
    '1qaz2wsx3edc4rfv5tgb',
    '0okm9ijn8uhb7ygv6tfc',
  ]
  return keyboardRows.some((row) => value.includes(row.slice(0, Math.min(row.length, Math.max(6, value.length)))))
    || ['qwerty', 'asdfgh', 'zxcvbn', '1qaz2wsx', 'qwerty123', 'qwertyuiop'].some((item) => value.includes(item))
}

function containsWeakWord(value: string) {
  const normalized = value.replace(/[^a-z0-9]/g, '')
  const weakWords = [
    'password',
    'admin',
    'administrator',
    'letmein',
    'welcome',
    'iloveyou',
    'qwerty',
    'testtest',
    'aiimage',
    'aigenerate',
    'imagegenerate',
    'cloudtask',
    'myspace',
  ]
  return weakWords.some((word) => normalized.includes(word))
}

function isDateLike(value: string) {
  if (!/^\d+$/.test(value)) return false
  if (/^(19|20)\d{2}\1/.test(value)) return true
  if (/^(19|20)\d{2}$/.test(value.slice(0, 4)) && hasRepeatedPattern(value)) return true
  return /^(19|20)\d{6,}$/.test(value)
}

function identityStorageSuffix(identityToken: string) {
  const normalized = normalizeIdentityToken(identityToken)
  let hash = 2166136261
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function activeBackgroundTasksKey(identityToken: string) {
  const normalized = normalizeIdentityToken(identityToken)
  if (!normalized) return ACTIVE_BACKGROUND_TASKS_KEY
  return `${SCOPED_ACTIVE_BACKGROUND_TASKS_KEY}:${identityStorageSuffix(normalized)}`
}

export function loadActiveBackgroundTasks(identityToken = ''): ActiveBackgroundTask[] {
  if (typeof window === 'undefined') return []
  if (!isValidIdentityToken(identityToken)) return []
  try {
    const saved = localStorage.getItem(activeBackgroundTasksKey(identityToken))
    if (!saved) return []
    const parsed = JSON.parse(saved) as ActiveBackgroundTask[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => typeof item?.id === 'string' && item.id.trim())
      .map((item) => ({ id: item.id, createdAt: Number(item.createdAt) || Date.now() }))
  } catch {
    return []
  }
}

export function saveActiveBackgroundTasks(tasks: ActiveBackgroundTask[], identityToken = '') {
  if (typeof window === 'undefined') return
  if (!isValidIdentityToken(identityToken)) return
  const compact = tasks
    .filter((item, index, arr) => item.id && arr.findIndex((other) => other.id === item.id) === index)
    .slice(0, 50)
  localStorage.setItem(activeBackgroundTasksKey(identityToken), JSON.stringify(compact))
}

export function addActiveBackgroundTask(id: string, createdAt = Date.now(), identityToken = '') {
  const tasks = loadActiveBackgroundTasks(identityToken)
  saveActiveBackgroundTasks([{ id, createdAt }, ...tasks.filter((item) => item.id !== id)], identityToken)
}

export function removeActiveBackgroundTask(id: string, identityToken = '') {
  saveActiveBackgroundTasks(loadActiveBackgroundTasks(identityToken).filter((item) => item.id !== id), identityToken)
}

export function maskSecret(value: string) {
  if (!value) return '未填写'
  if (value.length <= 8) return '••••••••'
  return `${value.slice(0, 4)}••••••••${value.slice(-4)}`
}
