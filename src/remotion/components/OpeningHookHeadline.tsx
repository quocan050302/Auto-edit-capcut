import React from 'react'
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Img } from 'remotion'

export const OpeningHookHeadline: React.FC<{
  primaryText: string
  entranceFrame: number
  exitFrame: number
}> = ({ primaryText, entranceFrame, exitFrame }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  
  const progress = spring({
    frame: frame - entranceFrame,
    fps,
    config: { damping: 12, stiffness: 200, mass: 0.5 }
  })
  
  const exitProgress = spring({
    frame: frame - exitFrame + 10, // start exiting a bit early
    fps,
    config: { damping: 14, stiffness: 200 }
  })

  const scale = interpolate(progress, [0, 1], [0.88, 1.0])
  const opacity = interpolate(progress, [0, 1], [0, 1]) - exitProgress
  
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity: Math.max(0, opacity) }}>
      <div style={{
        backgroundColor: 'rgba(0,0,0,0.8)',
        padding: '20px 40px',
        transform: `scale(${scale}) translateY(${interpolate(progress, [0, 1], [20, 0])}px)`,
        color: '#fff',
        fontSize: '80px',
        fontWeight: 800,
        fontFamily: 'Inter, sans-serif',
        textAlign: 'center',
        textTransform: 'uppercase',
        borderLeft: '10px solid #e11d48' // red accent
      }}>
        {primaryText}
      </div>
    </AbsoluteFill>
  )
}

export const OpeningQuestionCard: React.FC<{
  text: string
  entranceFrame: number
  exitFrame: number
}> = ({ text, entranceFrame, exitFrame }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  
  const progress = spring({
    frame: frame - entranceFrame,
    fps,
    config: { damping: 15, stiffness: 150 }
  })
  
  const exitProgress = spring({
    frame: frame - exitFrame + 5,
    fps,
    config: { damping: 15, stiffness: 150 }
  })

  const y = interpolate(progress, [0, 1], [50, 0])
  const opacity = interpolate(progress, [0, 1], [0, 1]) - exitProgress

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity: Math.max(0, opacity) }}>
      <div style={{
        transform: `translateY(${y}px)`,
        color: '#fff',
        fontSize: '70px',
        fontWeight: 700,
        fontFamily: 'Inter, sans-serif',
        textAlign: 'center',
        textShadow: '0 4px 12px rgba(0,0,0,0.5)',
        letterSpacing: '2px'
      }}>
        {text}
      </div>
    </AbsoluteFill>
  )
}

export const OpeningStatPunch: React.FC<{
  text: string
  entranceFrame: number
  exitFrame: number
}> = ({ text, entranceFrame, exitFrame }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  
  const progress = spring({
    frame: frame - entranceFrame,
    fps,
    config: { damping: 10, stiffness: 250, mass: 0.8 } // snappy
  })
  
  const exitProgress = spring({
    frame: frame - exitFrame + 10,
    fps,
    config: { damping: 14, stiffness: 200 }
  })

  const scale = interpolate(progress, [0, 1], [1.5, 1.0])
  const opacity = progress - exitProgress

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity: Math.max(0, opacity) }}>
      <div style={{
        backgroundColor: '#eab308', // yellow
        color: '#000',
        padding: '15px 30px',
        transform: `scale(${scale})`,
        fontSize: '90px',
        fontWeight: 900,
        fontFamily: 'Inter, sans-serif',
        boxShadow: '0 10px 25px rgba(0,0,0,0.3)'
      }}>
        {text}
      </div>
    </AbsoluteFill>
  )
}
