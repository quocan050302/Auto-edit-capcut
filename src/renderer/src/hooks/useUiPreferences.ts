import { useState, useEffect, useCallback } from 'react'

export type InterfaceMode = 'simple' | 'advanced'

export const STORAGE_KEY_INTERFACE_MODE = 'ai-video-factory.interface-mode'

export function getStoredInterfaceMode(): InterfaceMode {
  try {
    const val = localStorage.getItem(STORAGE_KEY_INTERFACE_MODE)
    if (val === 'advanced' || val === 'simple') {
      return val
    }
  } catch {
    // localStorage might be unavailable in some test/restricted envs
  }
  return 'simple' // Default for new users is Simple Mode
}

export function setStoredInterfaceMode(mode: InterfaceMode): void {
  try {
    localStorage.setItem(STORAGE_KEY_INTERFACE_MODE, mode)
  } catch {
    // Ignore storage write errors
  }
}

export function useUiPreferences() {
  const [interfaceMode, setInterfaceModeState] = useState<InterfaceMode>(() => getStoredInterfaceMode())

  // Sync to localStorage whenever state changes
  const setInterfaceMode = useCallback((mode: InterfaceMode) => {
    setInterfaceModeState(mode)
    setStoredInterfaceMode(mode)
  }, [])

  const toggleInterfaceMode = useCallback(() => {
    setInterfaceModeState((prev) => {
      const next = prev === 'simple' ? 'advanced' : 'simple'
      setStoredInterfaceMode(next)
      return next
    })
  }, [])

  // Listen to storage events from other tabs or windows if any
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY_INTERFACE_MODE && (e.newValue === 'simple' || e.newValue === 'advanced')) {
        setInterfaceModeState(e.newValue)
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  return {
    interfaceMode,
    setInterfaceMode,
    toggleInterfaceMode,
    isSimpleMode: interfaceMode === 'simple',
    isAdvancedMode: interfaceMode === 'advanced'
  }
}
