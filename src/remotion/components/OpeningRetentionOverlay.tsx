import React from 'react'
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion'
import type { OpeningRetentionEvent } from '../../../src/main/retention/opening-retention-types'
import { OpeningHookHeadline, OpeningQuestionCard, OpeningStatPunch } from './OpeningHookHeadline'

export const OpeningRetentionOverlay: React.FC<{
  events: OpeningRetentionEvent[]
}> = ({ events }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const currentTime = frame / fps

  const activeEvents = events.filter(
    (e) => currentTime >= e.startTime && currentTime <= e.startTime + e.duration
  )

  return (
    <AbsoluteFill>
      {activeEvents.map((ev) => {
        const entranceFrame = Math.round(ev.startTime * fps)
        const exitFrame = Math.round((ev.startTime + ev.duration) * fps)
        
        switch (ev.type) {
          case 'hook-headline':
            return (
              <OpeningHookHeadline
                key={ev.id}
                primaryText={ev.primaryText || ''}
                entranceFrame={entranceFrame}
                exitFrame={exitFrame}
              />
            )
          case 'question-card':
            return (
              <OpeningQuestionCard
                key={ev.id}
                text={ev.primaryText || ''}
                entranceFrame={entranceFrame}
                exitFrame={exitFrame}
              />
            )
          case 'stat-punch':
            return (
              <OpeningStatPunch
                key={ev.id}
                text={ev.primaryText || ''}
                entranceFrame={entranceFrame}
                exitFrame={exitFrame}
              />
            )
          // For transition-accent or other types, we could add more components here
          default:
            return null
        }
      })}
    </AbsoluteFill>
  )
}
