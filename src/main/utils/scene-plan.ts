import type { ScenePlan, ChapterPlan, SequencePlan } from '../planner'

export interface FlattenedSceneEntry<T = ScenePlan> {
  scene: T
  sceneId: string
  sceneIndex: number
  chapterIndex: number
  chapterTitle: string
  chapterPurpose: string
  sequenceIndex: number
  sequenceTitle: string
  isFirstInChapter: boolean
  isFirstInSequence: boolean
  isLastInChapter: boolean
  isLastInSequence: boolean
}

export interface PlanLike {
  chapters?: Array<{
    chapterIndex?: number
    title?: string
    purpose?: string
    sequences?: Array<{
      sequenceIndex?: number
      title?: string
      scenes?: unknown[]
    }>
    chapters_seq?: Array<{
      sequenceIndex?: number
      title?: string
      scenes?: unknown[]
    }>
  }>
  [key: string]: unknown
}

/**
 * Universal scene flattener for Production Intelligence and Rendering modules.
 * Unifies scene extraction across both `sequences` and legacy `chapters_seq` schemas.
 * Guarantees deterministic scene IDs and preserves sequence/chapter topology.
 */
export function flattenEditPlanScenes<T = ScenePlan>(plan: PlanLike): FlattenedSceneEntry<T>[] {
  const result: FlattenedSceneEntry<T>[] = []
  const chapters = plan.chapters ?? []

  for (let chIdx = 0; chIdx < chapters.length; chIdx++) {
    const ch = chapters[chIdx]
    const chapterIndex = typeof ch.chapterIndex === 'number' ? ch.chapterIndex : chIdx
    const chapterTitle = ch.title ?? `Chapter ${chapterIndex + 1}`
    const chapterPurpose = ch.purpose ?? ''

    const rawSequences = ch.sequences ?? ch.chapters_seq ?? []
    let isFirstInChapter = true

    for (let seqIdx = 0; seqIdx < rawSequences.length; seqIdx++) {
      const seq = rawSequences[seqIdx]
      const sequenceIndex = typeof seq.sequenceIndex === 'number' ? seq.sequenceIndex : seqIdx
      const sequenceTitle = seq.title ?? `Sequence ${sequenceIndex + 1}`
      const scenes = (seq.scenes ?? []) as T[]
      let isFirstInSequence = true

      for (let scIdx = 0; scIdx < scenes.length; scIdx++) {
        const rawScene = scenes[scIdx] as Record<string, unknown>
        const sceneIndex = typeof rawScene.sceneIndex === 'number'
          ? rawScene.sceneIndex
          : result.length

        // Generate deterministic sceneId if not present
        const sceneId = typeof rawScene.sceneId === 'string' && rawScene.sceneId.trim().length > 0
          ? rawScene.sceneId
          : `chapter-${chapterIndex}-sequence-${sequenceIndex}-scene-${sceneIndex}`

        const isLastInSequence = scIdx === scenes.length - 1
        const isLastInChapter = isLastInSequence && seqIdx === rawSequences.length - 1

        result.push({
          scene: rawScene as T,
          sceneId,
          sceneIndex,
          chapterIndex,
          chapterTitle,
          chapterPurpose,
          sequenceIndex,
          sequenceTitle,
          isFirstInChapter,
          isFirstInSequence,
          isLastInChapter,
          isLastInSequence
        })

        isFirstInChapter = false
        isFirstInSequence = false
      }
    }
  }

  return result
}
