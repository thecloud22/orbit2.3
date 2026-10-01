import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { getClaim, sectionLabel } from '../api/claims'
import { useQuery } from '../api/useQuery'
import { isLiveId } from '../api/live/mode'
import { useLivePoll } from '../api/live/poll'
import { LIVE } from '../api/live/config'
import * as live from '../api/live/data'
import type { SectionKey } from '../api/types'
import { Loading } from '../components/Planned'
import { useToast } from '../components/Toasts'
import { useSession } from '../shell/session'
import { ClaimHeader, type QuickAction } from './ClaimHeader'
import { ExceptionStrip } from './ExceptionStrip'
import { SectionNav } from './SectionNav'
import { ContextPanel, type PanelTab } from './ContextPanel'
import { QuickDrawer } from './QuickDrawer'
import { SECTIONS } from './sections'
import { LIVE_SECTIONS } from './liveSections'
import { useClaimCounts } from './useCounts'
import './claim.css'

/** One claim, one workspace: header, exceptions, sections, and a context panel beside them. */
export function ClaimWorkspace() {
  const { claimId = '', section = 'overview', target } = useParams()
  const { openTab } = useSession()
  const toast = useToast()
  const isLive = isLiveId(claimId)
  useLivePoll(isLive ? claimId : undefined, isLive)
  const { data: claim, error } = useQuery(() => getClaim(claimId), [claimId])
  const counts = useClaimCounts(claimId)
  const [panelTab, setPanelTab] = useState<PanelTab>('assistant')
  const [collapsed, setCollapsed] = useState(false)
  const [quick, setQuick] = useState<QuickAction | null>(null)

  useEffect(() => {
    if (claim) openTab(claim.id)
  }, [claim, openTab])

  useEffect(() => {
    if (claim) document.title = `${claim.name} · ${sectionLabel(claim, section as SectionKey)} — Claims`
  }, [claim, section])

  if (error) {
    return (
      <div className="cw-error">
        <h1>{LIVE && isLive ? 'Could not open the claim' : 'Claim not found'}</h1>
        <p className="soft">{LIVE && isLive ? error.message : `${claimId} isn’t in the mock data.`}</p>
      </div>
    )
  }
  if (!claim) return <div style={{ padding: 24, width: '100%' }}><Loading rows={8} /></div>

  const key = section as SectionKey
  if (!claim.sections.includes(key) && !(key in SECTIONS)) return <Navigate to={`/claims/${claim.id}/overview`} replace />
  const Section = (claim.live && LIVE_SECTIONS[key]) || SECTIONS[key]
  // Log call, notes and tasks are the mock's; the backend has no such endpoints yet.
  const onQuick = (a: QuickAction) => {
    if (claim.live && a === 'call') {
      // The one call the backend tracks is the welcome call (a work item); logging it meets the first-contact service level.
      live.logWelcomeCall(claim.id).then((m) => toast(m), (e: Error) => toast(e.message))
    } else if (claim.live) toast('Not available live yet: the backend has no call log, notes or tasks endpoints')
    else setQuick(a)
  }

  return (
    <div className="cw">
      <ClaimHeader claim={claim} section={key} onQuick={onQuick} />
      <ExceptionStrip claim={claim} />
      <div className="cw-body">
        <SectionNav claim={claim} counts={counts} onTasks={() => { setPanelTab('tasks'); setCollapsed(false) }} />
        <main className="cw-main" aria-label={sectionLabel(claim, key)}>
          <Section claim={claim} target={target} onQuick={onQuick} />
        </main>
        <ContextPanel claim={claim} tab={panelTab} setTab={setPanelTab} counts={counts} collapsed={collapsed} setCollapsed={setCollapsed} />
      </div>
      {quick && <QuickDrawer claim={claim} action={quick} onClose={() => setQuick(null)} />}
    </div>
  )
}
