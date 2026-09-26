import { Composition } from 'remotion'
import { CaptionsOverlay } from './CaptionsOverlay'
import type { CaptionPlan } from '../../shared/types'

const DEFAULT_PLAN: CaptionPlan = {
  enabled: true,
  activeRanges: [],
  phrases: [],
}

/**
 * RemotionRoot — đăng ký các Composition cho project.
 *
 * durationInFrames đặt tạm 54000 (= 30fps × 30min).
 * Giá trị thật được override khi gọi renderMedia() trong remotion-renderer.ts
 * thông qua trường `composition.durationInFrames`.
 */
export const RemotionRoot: React.FC = () => (
  <Composition
    id="CaptionsOverlay"
    component={CaptionsOverlay}
    durationInFrames={54000}   // 30 phút max — override thật qua renderMedia
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{ captionPlan: DEFAULT_PLAN }}
  />
)
