import type { AspectRatio, Ratio } from '../types'

export const RATIOS: AspectRatio[] = ['auto', '1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9']

export const RATIO_SIZE: Record<Ratio, string> = {
  '1:1': '1024x1024',
  '2:3': '1024x1536',
  '3:2': '1536x1024',
  '3:4': '768x1024',
  '4:3': '1024x768',
  '9:16': '1008x1792',
  '16:9': '1792x1008',
}

export function isFixedRatio(ratio: AspectRatio): ratio is Ratio {
  return ratio !== 'auto'
}

export function getRatioSize(ratio: AspectRatio) {
  return isFixedRatio(ratio) ? RATIO_SIZE[ratio] : '自动'
}

export function getRatioPreviewStyle(ratio: AspectRatio) {
  if (ratio === 'auto') {
    return {
      width: '18px',
      height: '18px',
    }
  }

  const [w, h] = ratio.split(':').map(Number)
  const maxW = 18
  const maxH = 18
  const scale = Math.min(maxW / w, maxH / h)
  return {
    width: `${Math.max(6, w * scale)}px`,
    height: `${Math.max(6, h * scale)}px`,
  }
}
