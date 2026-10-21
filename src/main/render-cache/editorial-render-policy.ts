import type { EditorialGenerationSettings } from '../visual-mix/manual-ai/editorial-focus-settings'

export interface EffectiveOverlayPolicy {
  renderCaptions: boolean
  renderProofVisuals: boolean
  renderVisualGrammar: boolean
  renderOpeningGraphics: boolean
  mode: 'full' | 'source-only'
}

/**
 * Resolves the effective render overlay policy.
 *
 * In 'full' mode (default):
 *   App-generated Remotion overlays (captions, proof visuals, visual grammar, opening graphics)
 *   are all rendered normally.
 *
 * In 'source-only' mode:
 *   App-generated visual overlays are disabled for that render, allowing source-only video composite
 *   without spawning Remotion Chromium processes, while fully preserving audio mixing,
 *   footage decoding, transitions, and downstream QA.
 */
export function resolveEffectiveOverlayPolicy(
  settings?: Partial<EditorialGenerationSettings> | null
): EffectiveOverlayPolicy {
  const isSourceOnly = settings?.renderOverlayMode === 'source-only'
  if (isSourceOnly) {
    return {
      renderCaptions: false,
      renderProofVisuals: false,
      renderVisualGrammar: false,
      renderOpeningGraphics: false,
      mode: 'source-only'
    }
  }
  return {
    renderCaptions: true,
    renderProofVisuals: true,
    renderVisualGrammar: true,
    renderOpeningGraphics: true,
    mode: 'full'
  }
}
