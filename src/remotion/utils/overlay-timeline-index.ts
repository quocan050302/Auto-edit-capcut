/**
 * overlay-timeline-index.ts
 *
 * High-performance, stateless interval timeline index for Remotion overlays.
 * Replaces O(N) full-array iterations and unnecessary React hook executions per frame
 * with an indexed interval search (O(log N + k)) while strictly preserving:
 *  - Exact boundary evaluation (inclusive currentTime >= start && currentTime <= end)
 *  - Exact original item ordering (stacking order)
 *  - Original source indices (animation seeds)
 *  - Statelessness (frames rendered in any order or in parallel return identical outputs)
 */

export interface IndexedInterval<T> {
  item: T
  originalIndex: number
  startTime: number
  endTime: number
}

export class OverlayTimelineIndex<T> {
  private readonly sortedByStart: IndexedInterval<T>[]
  private readonly maxEndTimePrefix: number[]

  constructor(
    items: T[],
    getTimeBounds: (item: T, originalIndex: number) => { startTime: number; endTime: number } | null
  ) {
    const list: IndexedInterval<T>[] = []
    for (let i = 0; i < items.length; i++) {
      const bounds = getTimeBounds(items[i], i)
      if (bounds && Number.isFinite(bounds.startTime) && Number.isFinite(bounds.endTime)) {
        list.push({
          item: items[i],
          originalIndex: i,
          startTime: bounds.startTime,
          endTime: bounds.endTime
        })
      }
    }

    // Sort by startTime ascending. For ties, sort by originalIndex.
    list.sort((a, b) => {
      if (a.startTime !== b.startTime) return a.startTime - b.startTime
      return a.originalIndex - b.originalIndex
    })

    this.sortedByStart = list

    // Precompute prefix maximum end times for early pruning
    this.maxEndTimePrefix = new Array(list.length)
    let maxEnd = -Infinity
    for (let i = 0; i < list.length; i++) {
      if (list[i].endTime > maxEnd) maxEnd = list[i].endTime
      this.maxEndTimePrefix[i] = maxEnd
    }
  }

  get length(): number {
    return this.sortedByStart.length
  }

  /**
   * Queries all items active at `time` (i.e. startTime <= time && time <= endTime).
   * Returns items in their original array order.
   */
  queryActive(time: number): T[] {
    const n = this.sortedByStart.length
    if (n === 0) return []

    // Binary search for largest index R where sortedByStart[R].startTime <= time
    let low = 0
    let high = n - 1
    let rightmost = -1

    while (low <= high) {
      const mid = (low + high) >> 1
      if (this.sortedByStart[mid].startTime <= time) {
        rightmost = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }

    if (rightmost === -1) return []

    const matches: IndexedInterval<T>[] = []

    // Scan backwards from rightmost.
    // Prune if prefix max end time is less than current time (no earlier item can reach `time`).
    for (let i = rightmost; i >= 0; i--) {
      if (this.maxEndTimePrefix[i] < time) {
        break
      }
      const entry = this.sortedByStart[i]
      if (entry.endTime >= time) {
        matches.push(entry)
      }
    }

    if (matches.length === 0) return []
    if (matches.length === 1) return [matches[0].item]

    // Sort back into original array order to guarantee identical stacking order
    matches.sort((a, b) => a.originalIndex - b.originalIndex)
    return matches.map((m) => m.item)
  }

  /**
   * Frame-based query: active when entranceFrame <= frame && frame < exitFrame.
   * Returns active items in original array order.
   */
  queryActiveFrames(frame: number, fps: number): T[] {
    const time = frame / fps
    const activeByTime = this.queryActive(time)
    if (activeByTime.length === 0) return []

    // Verify exact frame-boundary condition entranceFrame <= frame && frame < exitFrame
    return activeByTime.filter((item) => {
      const bounds = this.sortedByStart.find((s) => s.item === item)
      if (!bounds) return false
      const entranceFrame = Math.round(bounds.startTime * fps)
      const exitFrame = Math.round(bounds.endTime * fps)
      return frame >= entranceFrame && frame < exitFrame
    })
  }
}
