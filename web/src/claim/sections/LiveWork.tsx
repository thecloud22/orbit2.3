import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { LifeFlow } from '../../api/lifeFlow'
import { ApiError } from '../../api/live/http'
import * as live from '../../api/live/data'
import { fmtDate } from '../../lib/dates'
import { useToast } from '../../components/Toasts'
import { useSession } from '../../shell/session'
import './Live.css'

/**
 * Live Workflow & SLA: the claim's open work items. The welcome call has an action of its own (POST /work-items/{id}:complete with the
 * item's ETag), which also meets the first_contact_by row. The others (record a decision, approve) complete when their action is done.
 */
export function LiveWork({ flow }: { flow: LifeFlow }) {
  const toast = useToast()
  const { user } = useSession()
  const items = flow.live?.workItems ?? []
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | undefined>()
  if (!items.length) return null

  async function complete(w: (typeof items)[number]) {
    setBusy(w.id)
    setErr(undefined)
    try {
      await live.completeWorkItem(flow.claimId, w)
      toast(w.welcomeCall ? 'Welcome call logged · first contact is met' : `Done: ${w.action}`)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 412 ? 'This item changed since you opened it. It is shown again with the latest; try once more.' : (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="wf-block" aria-labelledby="lw-h" data-claim-work>
      <div className="section-head">
        <h3 id="lw-h">Work on this claim</h3>
        <span className="aside">The backend’s open work items for it</span>
      </div>
      {err && <div className="lv-error" role="alert" style={{ marginBottom: 8 }}>{err}</div>}
      <div className="lv-work">
        {items.map((w) => (
          <div key={w.id} className="lv-work-row" data-work-item={w.id}>
            <div>
              <div className="strong">{w.action}</div>
              <div className="sub">{w.why} · due {fmtDate(w.dueOn)} · waiting on {w.waitingOn}{w.ownerId !== user.id && w.ownerId !== 'Unassigned' ? ` · ${w.ownerId}’s item` : ''}</div>
            </div>
            {w.welcomeCall ? (
              <button type="button" className="btn btn--primary btn--sm" data-log-welcome-call disabled={busy === w.id} onClick={() => complete(w)}>{busy === w.id ? 'Logging…' : 'Log the welcome call'}</button>
            ) : (
              <Link className="btn btn--sm" to={`/claims/${flow.claimId}/${w.section}`}>Open</Link>
            )}
          </div>
        ))}
      </div>
      <p className="lv-note" style={{ marginTop: 6 }}>The backend has no call log yet: logging the welcome call ticks this item and meets the first-contact service level, nothing more.</p>
    </section>
  )
}
