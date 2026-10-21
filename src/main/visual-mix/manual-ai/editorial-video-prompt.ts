import type { AiImageOutputResolution } from '../../../../shared/types'
import { sanitizePromptLine } from './manual-ai-prompt-pack'
import type { EditorialFocusInstruction } from './editorial-focus-director'

/**
 * Removes contradictory text/overlay prohibitions from base prompt
 * so the embedded editorial instruction does not create conflicting prompt directives.
 * Retains all other negative constraints (speech, music, logo, watermark, artifacts, etc.).
 */
function stripConflictingTextProhibitions(prompt: string): string {
  return prompt
    // Strip external captions negative space reservation since label is now embedded
    .replace(/Reserve clean, uncluttered negative space in the [^.]+ quadrant for external editorial captions\.\s*/gi, '')
    // Strip conflicting negative text directives
    .replace(
      /\bno\s+(?:UI\s+text|text\s+overlays|embedded\s+captions|embedded\s+subtitles|UI\s+elements|unreadable\s+hallucinated\s+UI\s+text|subtitles)(?:,\s*)?/gi,
      ''
    )
    .replace(/\bno\s+text\b(?:,\s*)?/gi, '')
    .replace(/\bno\s+labels\b(?:,\s*)?/gi, '')
    // Clean up empty trailing "no ." or dangling commas
    .replace(/,\s*,/g, ',')
    .replace(/,\s*\./g, '.')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface ComposeEmbeddedEditorialVideoPromptParams {
  basePrompt: string
  instruction: EditorialFocusInstruction
  sceneDurationSecs: number
  outputResolution: AiImageOutputResolution
}

/**
 * Composes an AI video prompt embedding cinematic visual labels, intelligent focus animation,
 * and high-contrast typography directly into the prompt text.
 *
 * For scenes with presentationMode === 'none', returns the base prompt unchanged.
 */
export function composeEmbeddedEditorialVideoPrompt(
  params: ComposeEmbeddedEditorialVideoPromptParams
): string {
  const { basePrompt, instruction, sceneDurationSecs, outputResolution } = params

  if (instruction.presentationMode === 'none' || !instruction.exactText) {
    return sanitizePromptLine(basePrompt)
  }

  // 1. Remove contradictory text prohibitions from base prompt
  let cleanedBase = stripConflictingTextProhibitions(basePrompt)

  // 2. Format position description
  const positionStr = (instruction.labelPosition || 'top-left').replace('-', ' ')

  // 3. Format typography description
  const typographyClause =
    instruction.readabilityProfile === 'senior-friendly'
      ? 'Clean, ultra-high-contrast large bold sans-serif editorial typography with crisp white lettering and dark translucent pill backing for maximum senior-friendly legibility'
      : 'Clean, high-contrast modern sans-serif editorial typography with crisp lettering and subtle translucent backing'

  // 4. Format target, leader line, and highlight
  let targetClause = ''
  if (instruction.focusTarget) {
    const parts: string[] = [`identifying the visible ${instruction.focusTarget}`]
    if (instruction.leaderLine) {
      parts.push('with a sleek minimal thin graphic leader line extending from the label directly to the target')
    }
    if (instruction.highlightTarget) {
      parts.push('and a subtle focused bounding highlight around the structure')
    }
    targetClause = parts.join(' ') + '.'
  }

  // 5. Format animation & timing
  const animName = instruction.animation || 'fade-in'
  const appTime = (instruction.appearanceTimeSecs ?? 0.5).toFixed(1)
  const holdTime = (instruction.holdDurationSecs ?? Math.max(1.5, sceneDurationSecs - 1.5)).toFixed(1)
  const animationClause = `Animated editorial entrance: ${animName} appearing at ${appTime}s and holding steady for ${holdTime}s before softly receding.`

  // 6. Label display instructions
  let labelClause: string
  if (instruction.presentationMode === 'comparison' && instruction.secondaryText) {
    labelClause = `Embedded editorial comparison: Display exactly: "${instruction.exactText}" alongside secondary label: "${instruction.secondaryText}". Positioned in the ${positionStr} quadrant. ${typographyClause}. ${targetClause} ${animationClause}`
  } else {
    labelClause = `Embedded editorial label: Display exactly: "${instruction.exactText}". Positioned in the ${positionStr} quadrant. ${typographyClause}. ${targetClause} ${animationClause}`
  }

  // 7. Strict exception clause guaranteeing no hallucinated UI/watermarks while permitting the label
  const exceptionClause =
    'Only the exact specified editorial label is allowed. No additional on-screen text, subtitles, UI elements, logos or watermark.'

  // 8. Assemble integrated prompt
  // Place editorial label instructions just before the negative constraints or at the end of visual description
  const fullPrompt = `${cleanedBase} ${labelClause} ${exceptionClause}`

  return sanitizePromptLine(fullPrompt)
}
