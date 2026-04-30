import type { Ratio } from '../types'
import { RATIOS, getRatioPreviewStyle } from '../lib/ratios'

interface Props {
  value: Ratio
  onChange: (ratio: Ratio) => void
}

export function RatioPicker({ value, onChange }: Props) {
  return (
    <div className="ratio-list" role="radiogroup" aria-label="图片比例">
      {RATIOS.map((ratio) => (
        <button
          key={ratio}
          type="button"
          className={`ratio-btn ${ratio === value ? 'active' : ''}`}
          onClick={() => onChange(ratio)}
          aria-checked={ratio === value}
          role="radio"
        >
          <span className="ratio-icon" style={getRatioPreviewStyle(ratio)} />
          <span>{ratio}</span>
        </button>
      ))}
    </div>
  )
}
