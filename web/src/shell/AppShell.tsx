import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { GlobalBar } from './GlobalBar'
import { WorkspaceTabs } from './WorkspaceTabs'
import { CommandPalette } from './CommandPalette'
import { DemoControls } from '../components/DemoControls'
import { LIVE } from '../api/live/config'

export function AppShell() {
  const [palette, setPalette] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((p) => !p)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <a href="#main" className="skip-link">Skip to content</a>
      <GlobalBar onSearch={() => setPalette(true)} />
      <WorkspaceTabs />
      <div className="app-body" id="main">
        <Outlet />
      </div>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      {LIVE && <DemoControls />}
    </div>
  )
}
