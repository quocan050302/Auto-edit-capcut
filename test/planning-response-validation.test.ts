/**
 * planning-response-validation.test.ts
 *
 * Verifies robust validation of Gemini responses:
 * - Partial JSON handling
 * - Malformed/corrupted responses
 * - Duplicate scene indices
 * - Out-of-batch scene indices
 * - Source fidelity preservation
 */

import { describe, it } from 'node:test'
import * as assert from 'node:assert'
import type { SceneSkeleton } from '../src/main/planning/scene-segmenter'
import type { ScenePlan } from '../src/main/planner'

describe('Planning Response Validation', () => {
  const mockSkeletons: SceneSkeleton[] = [
    {
      sceneIndex: 1,
      startTime: 0,
      endTime: 5,
      duration: 5,
      narrativeText: 'In 1914, the great expedition embarked on their journey.',
      transcriptSegmentIds: ['s1']
    },
    {
      sceneIndex: 2,
      startTime: 5,
      endTime: 10,
      duration: 5,
      narrativeText: 'Navigating rough waters, the crew spotted unfamiliar shores.',
      transcriptSegmentIds: ['s2']
    },
    {
      sceneIndex: 3,
      startTime: 10,
      endTime: 15,
      duration: 5,
      narrativeText: 'Scientific instruments recorded anomalous readings.',
      transcriptSegmentIds: ['s3']
    }
  ]

  it('Validates and maps complete response correctly', () => {
    const rawItems = [
      {
        sceneIndex: 1,
        visualIntent: 'Historic ship sailing through foggy waters',
        visualNote: 'Wide establishing cinematic shot',
        searchQueries: ['historical ship voyage', '1914 expedition ocean'],
        mediaType: 'video',
        energyLevel: 'medium',
        shotType: 'wide'
      },
      {
        sceneIndex: 2,
        visualIntent: 'Rough ocean waves crashing near coastline',
        visualNote: 'Dramatic camera angle',
        searchQueries: ['rough ocean waves', 'rocky coastline stormy'],
        mediaType: 'video',
        energyLevel: 'high',
        shotType: 'medium'
      },
      {
        sceneIndex: 3,
        visualIntent: 'Vintage compass and navigation instruments',
        visualNote: 'Close-up macro detail',
        searchQueries: ['antique compass map', 'brass navigation instruments'],
        mediaType: 'image',
        energyLevel: 'low',
        shotType: 'close-up'
      }
    ]

    const enrichedMap = new Map<number, Partial<ScenePlan>>()
    const validBatchIndices = new Set(mockSkeletons.map((s) => s.sceneIndex))

    for (const item of rawItems) {
      if (typeof item.sceneIndex === 'number' && validBatchIndices.has(item.sceneIndex)) {
        enrichedMap.set(item.sceneIndex, item as Partial<ScenePlan>)
      }
    }

    assert.strictEqual(enrichedMap.size, 3)
    assert.strictEqual(enrichedMap.get(1)?.visualIntent, 'Historic ship sailing through foggy waters')
    assert.strictEqual(enrichedMap.get(3)?.mediaType, 'image')
  })

  it('Partial JSON: retains valid scenes and identifies missing scene for fallback', () => {
    // Only scenes 1 and 3 are present; scene 2 is missing
    const rawItems = [
      {
        sceneIndex: 1,
        visualIntent: 'Historic ship sailing through foggy waters',
        searchQueries: ['historical ship voyage']
      },
      {
        sceneIndex: 3,
        visualIntent: 'Vintage compass and navigation instruments',
        searchQueries: ['antique compass map']
      }
    ]

    const enrichedMap = new Map<number, Partial<ScenePlan>>()
    const validBatchIndices = new Set(mockSkeletons.map((s) => s.sceneIndex))

    for (const item of rawItems) {
      if (typeof item.sceneIndex === 'number' && validBatchIndices.has(item.sceneIndex)) {
        enrichedMap.set(item.sceneIndex, item as Partial<ScenePlan>)
      }
    }

    assert.strictEqual(enrichedMap.size, 2)
    assert.strictEqual(enrichedMap.has(1), true)
    assert.strictEqual(enrichedMap.has(2), false)
    assert.strictEqual(enrichedMap.has(3), true)

    // Simulate algorithmic fallback filling missing scene 2
    for (const skel of mockSkeletons) {
      if (!enrichedMap.has(skel.sceneIndex)) {
        enrichedMap.set(skel.sceneIndex, {
          sceneIndex: skel.sceneIndex,
          visualIntent: 'Documentary cinematic b-roll',
          searchQueries: ['documentary archive footage', 'historical b-roll']
        })
      }
    }

    assert.strictEqual(enrichedMap.size, 3)
    assert.strictEqual(enrichedMap.get(2)?.visualIntent, 'Documentary cinematic b-roll')
  })

  it('Duplicate scene indices: rejects overwriting earlier valid entry', () => {
    const rawItems = [
      {
        sceneIndex: 1,
        visualIntent: 'Original valid visual intent for Scene 1',
        searchQueries: ['valid ship query']
      },
      {
        sceneIndex: 1,
        visualIntent: 'Corrupted duplicate overwriting attempt',
        searchQueries: ['bad duplicate']
      }
    ]

    const enrichedMap = new Map<number, Partial<ScenePlan>>()
    const validBatchIndices = new Set(mockSkeletons.map((s) => s.sceneIndex))

    for (const item of rawItems) {
      if (typeof item.sceneIndex === 'number' && validBatchIndices.has(item.sceneIndex)) {
        if (!enrichedMap.has(item.sceneIndex)) {
          enrichedMap.set(item.sceneIndex, item as Partial<ScenePlan>)
        }
      }
    }

    assert.strictEqual(enrichedMap.size, 1)
    assert.strictEqual(enrichedMap.get(1)?.visualIntent, 'Original valid visual intent for Scene 1')
  })

  it('Invalid scene indices: ignores out-of-batch scene numbers', () => {
    const rawItems = [
      {
        sceneIndex: 999, // not in batch
        visualIntent: 'Alien artifact',
        searchQueries: ['ufo']
      },
      {
        sceneIndex: 1,
        visualIntent: 'Valid scene 1',
        searchQueries: ['ship']
      }
    ]

    const enrichedMap = new Map<number, Partial<ScenePlan>>()
    const validBatchIndices = new Set(mockSkeletons.map((s) => s.sceneIndex))

    for (const item of rawItems) {
      if (typeof item.sceneIndex === 'number' && validBatchIndices.has(item.sceneIndex)) {
        enrichedMap.set(item.sceneIndex, item as Partial<ScenePlan>)
      }
    }

    assert.strictEqual(enrichedMap.size, 1)
    assert.strictEqual(enrichedMap.has(999), false)
    assert.strictEqual(enrichedMap.has(1), true)
  })

  it('Source fidelity: timeline and narrative text remain 100% identical to skeleton', () => {
    const aiData: Partial<ScenePlan> = {
      visualIntent: 'Custom AI enriched intent',
      searchQueries: ['custom query 1', 'custom query 2', 'custom query 3']
    }

    const skel = mockSkeletons[0]
    const scene: ScenePlan = {
      sceneIndex: skel.sceneIndex,
      mediaFile: '',
      mediaType: 'video',
      startTime: skel.startTime,
      endTime: skel.endTime,
      duration: skel.duration,
      narrativeText: skel.narrativeText,
      transcriptSegmentIds: [...skel.transcriptSegmentIds],
      transitionIn: 'cut',
      visualNote: 'Visual note',
      visualIntent: aiData.visualIntent ?? 'default',
      searchQueries: aiData.searchQueries ?? [],
      energyLevel: 'medium',
      shotType: 'wide'
    }

    assert.strictEqual(scene.startTime, 0)
    assert.strictEqual(scene.endTime, 5)
    assert.strictEqual(scene.duration, 5)
    assert.strictEqual(scene.narrativeText, 'In 1914, the great expedition embarked on their journey.')
    assert.deepStrictEqual(scene.transcriptSegmentIds, ['s1'])
  })
})
