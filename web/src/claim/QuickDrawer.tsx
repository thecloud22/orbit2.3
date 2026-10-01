import { useState } from 'react'
import type { Claim } from '../api/types'
import { addCommunication } from '../api/communications'
import { logEvent } from '../api/history'
import { addNote, addTask } from '../api/tasks'
import { Drawer } from '../components/Drawer'
import { useToast } from '../components/Toasts'
import { useSession } from '../shell/session'
import type { QuickAction } from './ClaimHeader'

/** Log call, add note and new task open over the claim, so the context stays on screen. */
export function QuickDrawer({ claim, action, onClose }: { claim: Claim; action: QuickAction; onClose: () => void }) {
  const { user } = useSession()
  const toast = useToast()
  const people = claim.parties.filter((p) => !p.roles.includes('Insured') || p.roles.includes('Claimant'))
  const [who, setWho] = useState(people[0]?.name ?? '')
  const [dir, setDir] = useState<'in' | 'out'>('in')
  const [text, setText] = useState('')
  const [due, setDue] = useState('')

  const title = action === 'call' ? 'Log call' : action === 'note' ? 'Add note' : 'New task'

  function save() {
    if (!text.trim()) return
    if (action === 'call') {
      addCommunication({ claimId: claim.id, channel: 'call', direction: dir, title: dir === 'in' ? `Call from ${who}` : `Call to ${who}`, party: `${who} · phone`, detail: text.trim(), status: { label: 'Logged', tone: 'neutral' } })
      logEvent(claim.id, { type: 'communication', title: `Call logged with ${who}`, actor: user.name })
      toast('Call logged')
    } else if (action === 'note') {
      addNote(claim.id, user.name, text.trim())
      toast('Note saved to the claim file')
    } else {
      addTask(claim.id, text.trim(), user.name, undefined, due || undefined)
      logEvent(claim.id, { type: 'task', title: `Task created: ${text.trim()}`, actor: user.name })
      toast('Task added')
    }
    onClose()
  }

  return (
    <Drawer
      title={`${title} · ${claim.name}`}
      onClose={onClose}
      width={480}
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn--primary" onClick={save} disabled={!text.trim()}>Save</button>
        </>
      }
    >
      {action === 'call' && (
        <>
          <div className="field">
            <label htmlFor="qd-who">With</label>
            <select id="qd-who" className="select" value={who} onChange={(e) => setWho(e.target.value)}>
              {people.map((p) => <option key={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="radio-cards" role="radiogroup" aria-label="Direction">
            <label className="radio-card"><input type="radio" name="dir" checked={dir === 'in'} onChange={() => setDir('in')} />Inbound</label>
            <label className="radio-card"><input type="radio" name="dir" checked={dir === 'out'} onChange={() => setDir('out')} />Outbound</label>
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor="qd-text">{action === 'task' ? 'Task' : action === 'call' ? 'What was discussed' : 'Note'}</label>
        {action === 'task' ? (
          <input id="qd-text" className="input" value={text} onChange={(e) => setText(e.target.value)} />
        ) : (
          <textarea id="qd-text" className="textarea" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
        )}
      </div>
      {action === 'task' && (
        <div className="field" style={{ maxWidth: 200 }}>
          <label htmlFor="qd-due">Due</label>
          <input id="qd-due" type="date" className="input" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
      )}
      <p className="sub">Saved to the claim’s history with your name and the time.</p>
    </Drawer>
  )
}
