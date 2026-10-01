import type { ClinicalFile } from '../clinical'

// Owned by the Medical screen. Minimum necessary: only the claim team and assigned clinical staff
// see this; agents of record never do.

const FUNCTIONS = ['Lift/carry', 'Sit at a time', 'Sit per day', 'Stand at a time', 'Walk at a time', 'Stand + walk per day', 'Bend, twist, crouch', 'Prognosis']

const row = (...v: string[]) => Object.fromEntries(FUNCTIONS.map((f, i) => [f, v[i]]))

export const CLINICAL: ClinicalFile[] = [
  // ------------------------------------------------------------------ Bell
  {
    id: 'D-25-018334',
    claimId: 'D-25-018334',
    condition: 'Lumbar degenerative disc disease · L4–L5 fusion 18 Feb 2025',
    treating: 'Dr. Owen Castillo, orthopaedic spine',
    diagnoses: [
      { code: 'M51.36', label: 'Other intervertebral disc degeneration, lumbar region', since: 'Jan 2025', primary: true },
      { code: 'M48.061', label: 'Spinal stenosis, lumbar region, without neurogenic claudication', since: 'Jan 2025' },
      { code: 'M54.16', label: 'Radiculopathy, lumbar region', since: 'Dec 2024' },
      { code: 'Z98.1', label: 'Arthrodesis status', since: 'Feb 2025' },
    ],
    providers: [
      { name: 'Dr. Owen Castillo', specialty: 'Orthopaedic spine', role: 'Treating · attending physician', since: 'Dec 2024', last: 'Exam 22 Sep 2026', next: '2026-12-12', status: { label: 'APS current', tone: 'positive' } },
      { name: 'Lakeview Physical Therapy', specialty: 'Physical therapy', role: 'Home program and visits', since: 'Mar 2025', last: 'Visit 18 Sep 2026', next: '2026-09-29', status: { label: 'Active', tone: 'info' } },
      { name: 'Dr. Renee Albright', specialty: 'Pain management', role: 'Injections', since: 'Oct 2025', last: 'Visit Jan 2026', status: { label: 'As needed', tone: 'neutral' } },
      { name: 'Dr. Helen Moss', specialty: 'Primary care', role: 'Annual care', since: '2016', last: 'Visit Apr 2026', status: { label: 'Routine', tone: 'neutral' } },
    ],
    functions: FUNCTIONS,
    versions: [
      { v: 1, date: '2025-01-06', source: 'APS with claim · Dr. Castillo', state: 'superseded', values: row('10 lb occasionally', '15 min', '2 h', '10 min', '10 min', '1 h', 'Never', 'Surgery planned') },
      { v: 2, date: '2025-04-02', source: 'Post-operative APS', state: 'superseded', values: row('None', '10 min', '1 h', '10 min', '10 min', '1 h', 'Never', 'Post-operative recovery') },
      { v: 3, date: '2025-06-10', source: 'APS · Jun 2025', state: 'superseded', values: row('10 lb occasionally', '15 min', '2 h', '10 min', '10 min', '1 h', 'Never', 'Improving') },
      { v: 4, date: '2025-10-20', source: 'APS · Oct 2025', state: 'superseded', values: row('10 lb occasionally', '15 min', '2 h', '10 min', '15 min', '1.5 h', 'Never', 'Improving slowly') },
      { v: 5, date: '2026-01-14', source: 'APS · Jan 2026', state: 'superseded', values: row('10 lb occasionally', '20 min', '2.5 h', '15 min', '15 min', '2 h', 'Never', 'Re-evaluate in 6 months') },
      { v: 6, date: '2026-06-10', source: 'APS · Jun 2026', state: 'current', values: row('10 lb occasionally', '20 min', '3 h', '15 min', '15 min', '2 h', 'Never', 'Re-evaluate in 3 months') },
      { v: 7, date: '2026-09-22', source: 'APS · 22 Sep 2026', state: 'proposed', docId: 'doc-bell-aps', values: row('10 lb occasionally', '30 min', '4 h', '15 min', '15 min', '2 h', 'Never', 'Permanent, MMI reached') },
    ],
    demands: [
      { demand: 'Driving a box truck or tractor, 4–6 h a day', current: 'Sit 20 min at a time, 3 h a day', proposed: 'Sit 30 min at a time, 4 h a day', fit: 'beyond' },
      { demand: 'Loading and unloading, 25–50 lb frequently', current: '10 lb occasionally', proposed: '10 lb occasionally', fit: 'beyond' },
      { demand: 'Yard work: standing and walking 3–4 h a day', current: '2 h a day', proposed: '2 h a day', fit: 'beyond' },
      { demand: 'Climbing into cabs, bending to secure loads', current: 'Never', proposed: 'Never', fit: 'beyond' },
      { demand: 'Running operations: dispatch, customers, billing', current: 'Seated tasks with breaks', proposed: 'Seated tasks with breaks', fit: 'partly' },
      { demand: 'Any occupation: full-time sedentary day, about 6 h sitting', current: '3 h a day', proposed: '4 h a day', fit: 'beyond', anyOcc: true },
      { demand: 'Any occupation: part-time sedentary work, up to 4 h a day', current: '3 h a day', proposed: '4 h a day', fit: 'partly', anyOcc: true },
    ],
    timeline: [
      { date: '2 Dec 2024', label: 'Onset' },
      { date: 'Jan 2025', label: 'MRI — L4–5 stenosis and disc degeneration' },
      { date: '18 Feb 2025', label: 'L4–L5 fusion' },
      { date: 'Mar–Aug 2025', label: 'Physical therapy' },
      { date: 'Oct 2025', label: 'Pain management injections' },
      { date: 'Jun 2026', label: 'APS — restrictions v6' },
      { date: '22 Sep 2026', label: 'Exam — maximum medical improvement', current: true },
    ],
    guideline: 'Expected duration for lumbar fusion with medium-to-heavy work: [duration guideline source · range]. Permanent restrictions after maximum medical improvement are consistent with fusion and residual radicular symptoms.',
    nextVisit: '2026-12-12',
    referral: {
      nurse: 'Sam Whitaker, RN',
      from: 'Jordan Ellis',
      opened: '2026-09-25',
      due: '2026-10-07',
      question: 'APS update received today. Do the restrictions still prevent him from driving, loading and running operations (his own occupation)? Do they support full-time sedentary work, which matters for the any-occupation change on 1 Jun 2027?',
      state: 'open',
      opinion: {
        supported: 'supported',
        consistent: ['Imaging and surgery', 'Treatment intensity', 'Reported activities'],
        ownOcc: 'prevented',
        sedentary: 'notSupported',
        recommendation: 'Restrictions are supported and permanent. They still prevent driving, loading and running operations. Tolerances do not support full-time sedentary work; the 14 Oct skills analysis should look at part-time sedentary options. Consider an FCE if tolerances improve.',
        peerReview: 'no',
        nextReview: '2026-12-12',
        savedAt: '2026-09-25T09:24',
      },
      suggestion: {
        text: 'Sitting improved to 4 h a day but remains below a full-time sedentary day.',
        sources: ['APS · p.2', 'APS Jun 2026'],
        state: 'open',
      },
      contacts: [{ at: '2026-09-25T09:05', text: 'Call with Dr. Castillo’s nurse · confirmed MMI and next visit 12 Dec' }],
    },
  },

  // ------------------------------------------------------------------ Vasquez
  {
    id: 'D-26-073390',
    claimId: 'D-26-073390',
    condition: 'To be coded from Dr. Hsu’s statement',
    treating: 'Dr. Grace Hsu, rheumatology',
    diagnoses: [],
    providers: [
      { name: 'Dr. Grace Hsu', specialty: 'Rheumatology', role: 'Treating · Lakeside Rheumatology Associates', since: 'Apr 2026', last: 'Per claimant: visit 3 Sep 2026', contact: '(555) 010-4400 · fax (555) 010-4410', status: { label: 'Statement overdue', tone: 'critical' } },
      { name: 'Records vendor', specialty: 'Medical records, Jan 2025 – present', role: 'Ordered 27 Aug', status: { label: 'ETA 1 Oct', tone: 'caution' } },
    ],
    functions: [],
    versions: [],
    demands: [
      { demand: 'Fine-motor precision with both hands, 6–8 h a clinical day', current: '—', proposed: '—', fit: 'unknown' },
      { demand: 'Sustained neck and shoulder posture over the patient', current: '—', proposed: '—', fit: 'unknown' },
      { demand: 'Gripping handpieces and scalers', current: '—', proposed: '—', fit: 'unknown' },
      { demand: 'Running the practice: staff, scheduling, billing', current: '—', proposed: '—', fit: 'unknown' },
    ],
    timeline: [
      { date: 'Apr 2026', label: 'First visit with Dr. Hsu (per claimant)' },
      { date: '12 Jun 2026', label: 'Cut back to 2 clinical days a week' },
      { date: '25 Aug 2026', label: 'Claim filed' },
      { date: '1 Oct 2026', label: 'Records vendor ETA', current: true },
    ],
    known: [
      { label: 'What Elena reports', value: 'Pain and morning stiffness in both hands and wrists; she can’t sustain fine-motor procedures for a full day.', source: 'Claimant statement', date: '2026-08-25' },
      { label: 'Work since 12 Jun', value: 'Two clinical days a week; administrative work on other days.', source: 'Duties questionnaire', date: '2026-09-02' },
      { label: 'Pharmacy history', value: 'Methotrexate weekly since Apr 2026 with folic acid; a short prednisone course in May 2026.', source: 'Pharmacy history', date: '2026-08-27' },
      { label: 'Treating physician', value: 'Dr. Grace Hsu, Lakeside Rheumatology Associates, since Apr 2026.', source: 'Claimant statement', date: '2026-08-25' },
    ],
    missing: [
      { label: 'Attending physician statement', detail: 'Diagnosis, restrictions and limitations, and expected duration. Requested 26 Aug; reminders 5 and 16 Sep.', from: 'Dr. Grace Hsu', status: { label: '9 days late', tone: 'critical' }, action: { label: 'Call office', section: 'requirements', target: 'req-vas-aps' } },
      { label: 'Medical records, Jan 2025 – present', detail: 'Office notes, labs and imaging. May be enough for a clinical review if the statement stays outstanding.', from: 'Records vendor', status: { label: 'ETA 1 Oct', tone: 'caution' }, action: { label: 'See requirement', section: 'requirements' } },
      { label: 'Diagnosis codes', detail: 'Coded from the physician statement or the records — not from pharmacy fills.', from: 'Claim team', status: { label: 'Waiting', tone: 'neutral' } },
      { label: 'Restrictions and limitations', detail: 'None on file yet, so own-occupation demands can’t be compared.', from: 'Dr. Grace Hsu', status: { label: 'Waiting', tone: 'neutral' } },
    ],
  },
]
