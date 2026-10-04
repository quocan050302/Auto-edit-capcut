import type { HealthMotionPreset } from './health-visual-types'

/**
 * Builds an FFmpeg video filter string for subtle, documentary-grade motion
 * applied to a still image during scene clip encoding.
 *
 * Parameters:
 *  - preset: 'slow-push-in' | 'slow-push-out' | 'pan-left' | 'pan-right' | 'micro-drift' | 'none'
 *  - width: target video width (e.g. 1920)
 *  - height: target video height (e.g. 1080)
 *  - duration: duration of the scene in seconds
 *  - fps: frames per second (e.g. 30)
 */
export function buildHealthMotionFilter(
  preset: HealthMotionPreset,
  width: number,
  height: number,
  duration: number,
  fps: number
): string {
  if (preset === 'none') {
    return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`
  }

  const frames = Math.max(1, Math.round(duration * fps))

  switch (preset) {
    case 'slow-push-in': {
      // Zoom subtly from 1.00 to 1.06 centered
      const rate = (0.06 / frames).toFixed(6)
      const z = `min(1.06,1.0+${rate}*on)`
      const x = `iw/2-(iw/zoom/2)`
      const y = `ih/2-(ih/zoom/2)`
      return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps}`
    }

    case 'slow-push-out': {
      // Zoom subtly from 1.06 to 1.00 centered
      const rate = (0.06 / frames).toFixed(6)
      const z = `max(1.0,1.06-${rate}*on)`
      const x = `iw/2-(iw/zoom/2)`
      const y = `ih/2-(ih/zoom/2)`
      return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps}`
    }

    case 'pan-left': {
      // Fixed zoom 1.05, pan smoothly right to left
      const z = '1.05'
      const x = `max(0,(iw-iw/zoom)*(1.0-on/${frames}))`
      const y = `ih/2-(ih/zoom/2)`
      return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps}`
    }

    case 'pan-right': {
      // Fixed zoom 1.05, pan smoothly left to right
      const z = '1.05'
      const x = `min(iw-iw/zoom,(iw-iw/zoom)*(on/${frames}))`
      const y = `ih/2-(ih/zoom/2)`
      return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps}`
    }

    case 'micro-drift': {
      // Micro drift: 1.00 -> 1.03 with gentle diagonal travel
      const rate = (0.03 / frames).toFixed(6)
      const z = `min(1.03,1.0+${rate}*on)`
      const x = `min(iw-iw/zoom,(iw-iw/zoom)*(on/${frames}))`
      const y = `min(ih-ih/zoom,(ih-ih/zoom)*(on/${frames}))`
      return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps}`
    }

    default:
      return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`
  }
}
