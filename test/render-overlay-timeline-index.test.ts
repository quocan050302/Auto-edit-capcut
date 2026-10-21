import assert from 'assert'
import { OverlayTimelineIndex } from '../src/remotion/utils/overlay-timeline-index'

console.log('=== Test: OverlayTimelineIndex ===')

interface TestItem {
  id: string
  start: number
  end: number
}

// 1. Basic deterministic cases
const items: TestItem[] = [
  { id: 'a', start: 1.0, end: 4.0 },
  { id: 'b', start: 2.0, end: 5.0 },
  { id: 'c', start: 2.0, end: 3.0 },
  { id: 'd', start: 6.0, end: 8.0 },
  { id: 'e', start: 7.0, end: 9.0 }
]

const index = new OverlayTimelineIndex(items, (it) => ({
  startTime: it.start,
  endTime: it.end
}))

// Query at t = 0.5: none
assert.deepStrictEqual(index.queryActive(0.5).map((x) => x.id), [])

// Query at t = 1.0 (start of a): [a]
assert.deepStrictEqual(index.queryActive(1.0).map((x) => x.id), ['a'])

// Query at t = 2.5: a (1..4), b (2..5), c (2..3)
assert.deepStrictEqual(index.queryActive(2.5).map((x) => x.id), ['a', 'b', 'c'])

// Query at t = 3.0 (end of c): a, b, c
assert.deepStrictEqual(index.queryActive(3.0).map((x) => x.id), ['a', 'b', 'c'])

// Query at t = 4.5: b
assert.deepStrictEqual(index.queryActive(4.5).map((x) => x.id), ['b'])

// Query at t = 5.5: none
assert.deepStrictEqual(index.queryActive(5.5).map((x) => x.id), [])

// Query at t = 7.5: d (6..8), e (7..9)
assert.deepStrictEqual(index.queryActive(7.5).map((x) => x.id), ['d', 'e'])

console.log('✓ Basic deterministic queries passed')

// 2. Randomized stress testing against native Array.prototype.filter across 1,000 queries
const randomItems: TestItem[] = []
for (let i = 0; i < 50; i++) {
  const start = Math.random() * 100
  const duration = 0.5 + Math.random() * 10
  randomItems.push({
    id: `rnd_${i}`,
    start: Number(start.toFixed(3)),
    end: Number((start + duration).toFixed(3))
  })
}

const stressIndex = new OverlayTimelineIndex(randomItems, (it) => ({
  startTime: it.start,
  endTime: it.end
}))

for (let q = 0; q < 1000; q++) {
  const t = Math.random() * 110
  const expected = randomItems.filter((it) => t >= it.start && t <= it.end)
  const actual = stressIndex.queryActive(t)

  assert.strictEqual(
    actual.length,
    expected.length,
    `Query at ${t} mismatch length: expected ${expected.length}, got ${actual.length}`
  )
  for (let k = 0; k < expected.length; k++) {
    assert.strictEqual(
      actual[k].id,
      expected[k].id,
      `Query at ${t} item ${k} order mismatch: expected ${expected[k].id}, got ${actual[k].id}`
    )
  }
}

console.log('✓ 1,000 randomized queries strictly match Array.prototype.filter')

// 3. Out-of-order stateless query verification
// Remotion renders frames out of order. Verify queries in random order yield identical outputs.
const tSamples = [1.2, 85.4, 3.7, 45.0, 0.0, 105.2, 50.1]
for (const t of tSamples) {
  const q1 = stressIndex.queryActive(t)
  const q2 = stressIndex.queryActive(t)
  assert.deepStrictEqual(q1, q2, `Stateless query at t=${t} must be idempotent`)
}

console.log('✓ Out-of-order query idempotence verified')

console.log('ALL OverlayTimelineIndex tests passed successfully!')
