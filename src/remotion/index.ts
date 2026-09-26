/**
 * src/remotion/index.ts
 *
 * Entry point cho Remotion composition bundle.
 * Load Google Fonts qua @remotion/google-fonts trước khi render.
 *
 * Fonts:
 *   Anton        — BigStatementCaption (sans_bold_caps)
 *   Playfair Display — NewsChyronCaption (serif segment)
 *   Inter        — DataNoteCallout
 */
import { registerRoot } from 'remotion'
import { loadFont as loadAnton } from '@remotion/google-fonts/Anton'
import { loadFont as loadPlayfair } from '@remotion/google-fonts/PlayfairDisplay'
import { loadFont as loadInter } from '@remotion/google-fonts/Inter'
import { RemotionRoot } from './Root'

// Load fonts — Remotion tự inject vào document head khi render với Chromium
loadAnton()
loadPlayfair()
loadInter()

registerRoot(RemotionRoot)
