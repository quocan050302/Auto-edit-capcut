import type { HealthMotionPreset, HealthMotionSpec } from './health-visual-types'

/**
 * Builds an FFmpeg video filter string for subtle, documentary-grade motion
 * applied to a still image during scene clip encoding.
 *
 * Requirements:
 *  - Deterministic (no Math.random() or random expressions)
 *  - Smooth continuous interpolation (sinusoidal easing, no pixel jitter/shake)
 *  - Exact output dimensions (width x height)
 *  - Handles both HealthMotionPreset strings and rich HealthMotionSpec objects
 */
export function buildHealthMotionFilter(
  presetOrSpec: HealthMotionPreset | HealthMotionSpec,
  width: number,
  height: number,
  duration: number,
  fps: number
): string {
  const spec = typeof presetOrSpec === 'string'
    ? resolvePresetDefaults(presetOrSpec, duration)
    : presetOrSpec

  if (spec.preset === 'none') {
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`
  }

  const frames = Math.max(1, Math.round(duration * fps))
  const PI = '3.14159265'

  // Easing progress expression:
  // linear: (on/frames)
  // ease-in-out: (1-cos(PI*on/frames))/2
  // ease-out: sin((PI/2)*(on/frames))
  let tExpr: string
  switch (spec.ease) {
    case 'linear':
      tExpr = `(on/${frames})`
      break
    case 'ease-out':
      tExpr = `sin((${PI}/2)*(on/${frames}))`
      break
    case 'ease-in-out':
    default:
      tExpr = `((1-cos(${PI}*on/${frames}))/2)`
      break
  }

  const zStart = spec.zoomStart
  const zEnd = spec.zoomEnd
  const zRange = (zEnd - zStart).toFixed(6)

  // Zoom expression
  let zExpr: string
  let xExpr: string
  let yExpr: string

  switch (spec.preset) {
    case 'gentle-pulse': {
      // Extremely smooth organic breathing cycle (sin wave across full scene)
      // 1.025 base + 0.02 amplitude
      zExpr = `(1.025+0.02*sin(2*${PI}*on/${frames}))`
      xExpr = `((iw-iw/zoom)*${spec.focusX.toFixed(2)})`
      yExpr = `((ih-ih/zoom)*${spec.focusY.toFixed(2)})`
      break
    }

    case 'still-hold': {
      zExpr = `${zStart.toFixed(4)}`
      xExpr = `((iw-iw/zoom)*${spec.focusX.toFixed(2)})`
      yExpr = `((ih-ih/zoom)*${spec.focusY.toFixed(2)})`
      break
    }

    case 'pan-left': {
      zExpr = `${zStart.toFixed(4)}`
      // Move camera X from right (0.75) to left (0.25)
      xExpr = `((iw-iw/zoom)*(0.75-0.50*${tExpr}))`
      yExpr = `((ih-ih/zoom)*${spec.focusY.toFixed(2)})`
      break
    }

    case 'pan-right': {
      zExpr = `${zStart.toFixed(4)}`
      // Move camera X from left (0.25) to right (0.75)
      xExpr = `((iw-iw/zoom)*(0.25+0.50*${tExpr}))`
      yExpr = `((ih-ih/zoom)*${spec.focusY.toFixed(2)})`
      break
    }

    case 'pan-up': {
      zExpr = `${zStart.toFixed(4)}`
      // Move camera Y from bottom (0.75) to top (0.25)
      xExpr = `((iw-iw/zoom)*${spec.focusX.toFixed(2)})`
      yExpr = `((ih-ih/zoom)*(0.75-0.50*${tExpr}))`
      break
    }

    case 'pan-down': {
      zExpr = `${zStart.toFixed(4)}`
      // Move camera Y from top (0.25) to bottom (0.75)
      xExpr = `((iw-iw/zoom)*${spec.focusX.toFixed(2)})`
      yExpr = `((ih-ih/zoom)*(0.25+0.50*${tExpr}))`
      break
    }

    case 'drift-up-left': {
      zExpr = `(${zStart.toFixed(4)}+${zRange}*${tExpr})`
      xExpr = `((iw-iw/zoom)*(0.70-0.40*${tExpr}))`
      yExpr = `((ih-ih/zoom)*(0.70-0.40*${tExpr}))`
      break
    }

    case 'drift-up-right': {
      zExpr = `(${zStart.toFixed(4)}+${zRange}*${tExpr})`
      xExpr = `((iw-iw/zoom)*(0.30+0.40*${tExpr}))`
      yExpr = `((ih-ih/zoom)*(0.70-0.40*${tExpr}))`
      break
    }

    case 'drift-down-left': {
      zExpr = `(${zStart.toFixed(4)}+${zRange}*${tExpr})`
      xExpr = `((iw-iw/zoom)*(0.70-0.40*${tExpr}))`
      yExpr = `((ih-ih/zoom)*(0.30+0.40*${tExpr}))`
      break
    }

    case 'drift-down-right': {
      zExpr = `(${zStart.toFixed(4)}+${zRange}*${tExpr})`
      xExpr = `((iw-iw/zoom)*(0.30+0.40*${tExpr}))`
      yExpr = `((ih-ih/zoom)*(0.30+0.40*${tExpr}))`
      break
    }

    case 'push-out-center':
    case 'slow-push-out': {
      // Zoom out from e.g. 1.06 to 1.00
      zExpr = `(${zEnd.toFixed(4)}-(${zEnd - zStart})*${tExpr})`
      xExpr = `((iw-iw/zoom)*${spec.focusX.toFixed(2)})`
      yExpr = `((ih-ih/zoom)*${spec.focusY.toFixed(2)})`
      break
    }

    case 'push-in-left':
    case 'focus-left': {
      zExpr = `(${zStart.toFixed(4)}+${zRange}*${tExpr})`
      xExpr = `((iw-iw/zoom)*0.30)`
      yExpr = `((ih-ih/zoom)*0.50)`
      break
    }

    case 'push-in-right':
    case 'focus-right': {
      zExpr = `(${zStart.toFixed(4)}+${zRange}*${tExpr})`
      xExpr = `((iw-iw/zoom)*0.70)`
      yExpr = `((ih-ih/zoom)*0.50)`
      break
    }

    case 'micro-drift': {
      // Replaced old jitter with subtle continuous diagonal drift
      zExpr = `(${zStart.toFixed(4)}+${zRange}*${tExpr})`
      xExpr = `((iw-iw/zoom)*(0.40+0.20*${tExpr}))`
      yExpr = `((ih-ih/zoom)*(0.40+0.20*${tExpr}))`
      break
    }

    case 'push-in-center':
    case 'slow-push-in':
    default: {
      zExpr = `(${zStart.toFixed(4)}+${zRange}*${tExpr})`
      xExpr = `((iw-iw/zoom)*${spec.focusX.toFixed(2)})`
      yExpr = `((ih-ih/zoom)*${spec.focusY.toFixed(2)})`
      break
    }
  }

  return `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${width}x${height}:fps=${fps}`
}

/**
 * Resolves standard cinematic spec parameters for a given preset string
 */
export function resolvePresetDefaults(preset: HealthMotionPreset, duration: number): HealthMotionSpec {
  const isShort = duration < 2.5
  const isLong = duration > 5.0

  const intensity = isShort ? 'very-subtle' : isLong ? 'medium' : 'subtle'
  const zoomStart = 1.00
  const zoomEnd = isShort ? 1.03 : isLong ? 1.08 : 1.06

  switch (preset) {
    case 'push-in-left':
    case 'focus-left':
      return {
        preset,
        intensity,
        focusX: 0.30,
        focusY: 0.50,
        zoomStart: 1.01,
        zoomEnd,
        ease: 'ease-in-out',
        reason: 'Focus push toward viewer left'
      }

    case 'push-in-right':
    case 'focus-right':
      return {
        preset,
        intensity,
        focusX: 0.70,
        focusY: 0.50,
        zoomStart: 1.01,
        zoomEnd,
        ease: 'ease-in-out',
        reason: 'Focus push toward viewer right'
      }

    case 'push-out-center':
    case 'slow-push-out':
      return {
        preset: 'push-out-center',
        intensity,
        focusX: 0.50,
        focusY: 0.50,
        zoomStart: 1.00,
        zoomEnd,
        ease: 'ease-in-out',
        reason: 'Calm perspective push out from center'
      }

    case 'pan-left':
      return {
        preset: 'pan-left',
        intensity,
        focusX: 0.50,
        focusY: 0.50,
        zoomStart: 1.05,
        zoomEnd: 1.05,
        ease: 'ease-in-out',
        reason: 'Smooth horizontal pan right to left'
      }

    case 'pan-right':
      return {
        preset: 'pan-right',
        intensity,
        focusX: 0.50,
        focusY: 0.50,
        zoomStart: 1.05,
        zoomEnd: 1.05,
        ease: 'ease-in-out',
        reason: 'Smooth horizontal pan left to right'
      }

    case 'pan-up':
      return {
        preset: 'pan-up',
        intensity,
        focusX: 0.50,
        focusY: 0.50,
        zoomStart: 1.05,
        zoomEnd: 1.05,
        ease: 'ease-in-out',
        reason: 'Smooth upward vertical pan'
      }

    case 'pan-down':
      return {
        preset: 'pan-down',
        intensity,
        focusX: 0.50,
        focusY: 0.50,
        zoomStart: 1.05,
        zoomEnd: 1.05,
        ease: 'ease-in-out',
        reason: 'Smooth downward vertical pan'
      }

    case 'drift-up-left':
    case 'drift-up-right':
    case 'drift-down-left':
    case 'drift-down-right':
      return {
        preset,
        intensity,
        focusX: 0.50,
        focusY: 0.50,
        zoomStart: 1.01,
        zoomEnd: isShort ? 1.03 : 1.06,
        ease: 'ease-in-out',
        reason: `Subtle directional diagonal drift (${preset})`
      }

    case 'gentle-pulse':
      return {
        preset: 'gentle-pulse',
        intensity: 'subtle',
        focusX: 0.50,
        focusY: 0.50,
        zoomStart: 1.025,
        zoomEnd: 1.045,
        ease: 'ease-in-out',
        reason: 'Smooth organic biological pulsation'
      }

    case 'still-hold':
      return {
        preset: 'still-hold',
        intensity: 'very-subtle',
        focusX: 0.50,
        focusY: 0.50,
        zoomStart: 1.02,
        zoomEnd: 1.02,
        ease: 'linear',
        reason: 'Calm still hold with micro-scale overscan'
      }

    case 'none':
      return {
        preset: 'none',
        intensity: 'very-subtle',
        focusX: 0.50,
        focusY: 0.50,
        zoomStart: 1.00,
        zoomEnd: 1.00,
        ease: 'linear',
        reason: 'Static image without camera motion'
      }

    case 'slow-push-in':
    case 'push-in-center':
    default:
      return {
        preset: 'push-in-center',
        intensity,
        focusX: 0.50,
        focusY: 0.50,
        zoomStart,
        zoomEnd,
        ease: 'ease-in-out',
        reason: 'Documentary push-in on focal subject'
      }
  }
}
