import { spring, useCurrentFrame, useVideoConfig } from 'remotion'

/**
 * useBounceScale — trả về scale factor cho entrance animation của caption.
 * Dùng Remotion spring() để tạo hiệu ứng nảy 85% → 105% → 100%.
 *
 * @param entranceFrame - frame số bắt đầu hiển thị phrase này
 * @returns số scale từ 0 (chưa tới) đến ~1 (đã settle)
 */
export function useBounceScale(entranceFrame: number): number {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const relativeFrame = frame - entranceFrame

  // Chưa tới lúc hiện — ẩn hoàn toàn
  if (relativeFrame < 0) return 0

  return spring({
    frame: relativeFrame,
    fps,
    config: {
      damping: 10,      // độ tắt dần — thấp hơn = nảy nhiều hơn
      stiffness: 200,   // độ cứng lò xo — cao hơn = snap nhanh hơn
      mass: 0.4         // khối lượng — nhỏ hơn = nhanh hơn
    },
    from: 0.85,
    to: 1,
  })
}
