import type { AnswerBody, AskContext } from '../assistant'

/**
 * Scripted answers for the six main sample claims. In the real product these come from a model grounded
 * in the claim record (retrieval over documents, requirements, decisions and history), served by the backend.
 * Each entry matches a question pattern; `starter` makes it a suggested question.
 */
export interface Scripted {
  match: RegExp
  starter?: string
  answer: (ctx: AskContext) => AnswerBody
}

function reqLine(ctx: AskContext, id: string): string | undefined {
  const r = ctx.requirements.find((x) => x.id === id)
  if (!r) return undefined
  return r.state === 'met' || r.state === 'waived' ? `Now: ${r.status.label.toLowerCase()}.` : undefined
}

export const SCRIPTED: Record<string, Scripted[]> = {
  // ---------------------------------------------------------------- Pierce — term life, fast track
  'L-26-040112': [
    {
      match: /why.*interest|interest (rule|rate)/,
      starter: 'Why is interest paid?',
      answer: () => ({
        paragraphs: [
          'The state rule for this policy requires interest on death proceeds from the date of death until the payment date. Here that is 3.25% from 29 Aug to 26 Sep: $373.97.',
          'Interest is reported to Margaret on a 1099-INT by 31 Jan 2027. The death benefit itself isn’t taxable income to her.',
        ],
        sources: [{ label: 'Policy §9 Payment of proceeds', section: 'decision' }, { label: 'Decision workbench', section: 'decision' }],
        followUps: ['How is the payment calculated?'],
      }),
    },
    {
      match: /calculat|how much|amount|refund|total|break ?down/,
      starter: 'How is the payment calculated?',
      answer: () => ({
        paragraphs: ['The death benefit is the $150,000 face amount; there are no policy loans. Linden Grove Funeral Home is paid its $9,850 assignment first and Margaret receives the rest.'],
        bullets: [
          'Linden Grove Funeral Home — assignment: $9,850.00',
          'Margaret Pierce — remainder of the face amount: $140,150.00',
          'Interest at 3.25%, 29 Aug–26 Sep: $373.97',
          'Refund of the unearned September premium: $68.40',
        ],
        after: ['Total $150,442.37. Margaret’s three lines go out as one EFT of $140,592.37.'],
        sources: [{ label: 'Policy record', section: 'policies' }, { label: 'Assignment', section: 'documents' }, { label: 'Decision workbench', section: 'decision' }],
        followUps: ['Why is interest paid?', 'Is anything blocking the fast track?'],
      }),
    },
  ],

  // ---------------------------------------------------------------- Okafor — complex life
  'L-26-038907': [
    {
      match: /contestab|why.*(term|review)|application|underwriting/,
      starter: 'Why is the term policy contestable?',
      answer: (ctx) => ({
        paragraphs: [
          'Term policy LP-2511086 was issued on 1 Nov 2025 and Daniel died on 14 Jul 2026, about 8 months later. A policy can be contested for two years from issue, so the application is checked against the records before this policy — or its rider — is decided.',
        ],
        bullets: [
          'One question so far: application Q4 answered No to blood-pressure treatment; pharmacy history shows an antihypertensive since 2022.',
          'Whether that is material is Underwriting’s call. It is not a finding.',
          `Dr. Anil Patel’s records are on a second request, due 30 Sep.${reqLine(ctx, 'req-okafor-patel') ? ' ' + reqLine(ctx, 'req-okafor-patel') : ''}`,
          'The review is due 9 Oct.',
        ],
        sources: [{ label: 'Application Q4', section: 'contestable' }, { label: 'Pharmacy history', section: 'contestable' }, { label: 'Requirements', section: 'requirements' }],
        actions: [{ kind: 'open', label: 'Open contestable review', section: 'contestable' }],
        followUps: ['Can the rider be paid before the review finishes?', 'What does Adaeze need to do for the children’s shares?'],
      }),
    },
    {
      match: /rider|accidental|adb|toxicolog/,
      starter: 'Can the rider be paid before the review finishes?',
      answer: () => ({
        paragraphs: ['No. The $250,000 accidental death rider is attached to the term policy, so it follows that policy’s outcome. It also needs the coroner’s final report.'],
        bullets: [
          'Today’s toxicology report found no alcohol or drugs, so the intoxication exclusion would not apply if the coroner agrees.',
          'The coroner’s final report is requested; it comes from outside, with no set date.',
        ],
        sources: [{ label: 'Toxicology report', section: 'documents' }, { label: 'Rider on LP-2511086', section: 'policies' }],
        actions: [{ kind: 'open', label: 'Review toxicology report', section: 'documents' }],
        followUps: ['Why is the term policy contestable?'],
      }),
    },
    {
      match: /custodian|children|minor|adaeze|kids|guardian|lawyer/,
      starter: 'What does Adaeze need to do for the children’s shares?',
      answer: () => ({
        paragraphs: ['Chidi’s and Amara’s shares of the whole life policy — $36,045 each — are held and earn interest until someone is documented to manage the money for them. There are two ways:'],
        bullets: [
          'Adaeze names a custodian under the state’s Uniform Transfers to Minors Act by signing the UTMA form. No court is needed up to the state limit.',
          'Or she sends a court order appointing a guardian of the estate.',
        ],
        after: ['She asked in the portal at 09:20 whether she needs a lawyer. For the first option she doesn’t — letter LTR-L-131 explains it.'],
        sources: [{ label: 'Portal message · 09:20', section: 'communications' }, { label: 'LTR-L-131', section: 'communications' }],
        actions: [{ kind: 'open', label: 'Open the custodian letter', section: 'communications' }],
        followUps: ['What’s still outstanding?'],
      }),
    },
  ],

  // ---------------------------------------------------------------- Whitman — payment held
  'L-26-035120': [
    {
      match: /tell robert|what (can|should) i (tell|say)|explain to|robert/,
      starter: 'What can I tell Robert?',
      answer: () => ({
        paragraphs: ['Tell him the claim is approved, the payment is going through a standard verification check before it’s released, and interest keeps being added until it’s paid.'],
        bullets: [
          'Don’t mention the sanctions list or the name match — describe it as a standard verification.',
          'Don’t promise a release date until Payments confirms one.',
          'He prefers phone calls in the morning.',
        ],
        sources: [{ label: 'Decision record v1', section: 'decision' }, { label: 'People & roles', section: 'people' }],
        actions: [
          { kind: 'task', label: 'Create task: call Robert', text: 'Call Robert Whitman about payment timing' },
          { kind: 'open', label: 'Open Communications', section: 'communications' },
        ],
        followUps: ['Why is the payment held?'],
      }),
    },
    {
      match: /held|hold|sanction|screen|why.*(payment|not paid)/,
      starter: 'Why is the payment held?',
      answer: () => ({
        paragraphs: ['Payments is holding the $436,000 payout while it confirms Robert Whitman’s identity. His name partly matched an entry on a sanctions list during payee screening; partial matches are usually cleared once date of birth and address are compared.'],
        bullets: [
          'Approved today at 08:52. It was above your $250,000 authority, so Monica Reyes approved it at 08:50.',
          'The hold sits with Payments; the contact is Lauren Pike.',
          'Interest keeps accruing from 21 Aug until payment.',
        ],
        sources: [{ label: 'Decision record v1', section: 'decision' }, { label: 'Screening result', section: 'payments' }],
        actions: [{ kind: 'open', label: 'See the hold', section: 'payments' }],
        followUps: ['What can I tell Robert?'],
      }),
    },
  ],

  // ---------------------------------------------------------------- Vasquez — DI, missing information
  'D-26-073390': [
    {
      match: /hsu|physician|aps|doctor|attending/,
      starter: 'What have we done to get Dr. Hsu’s statement?',
      answer: (ctx) => {
        const now = reqLine(ctx, 'req-vas-aps')
        return {
          paragraphs: [
            'It was requested on 26 Aug by fax and through the provider portal. An automatic reminder went on 5 Sep and a second request on 16 Sep, when Elena was also told in her portal. The first status letter on 24 Sep listed it as still needed.',
          ],
          bullets: now
            ? [now]
            : [
                'It is 9 days past its 16 Sep due date.',
                'Today’s step: phone Dr. Hsu’s office on (555) 010-4400.',
                'Other routes: Elena can help (portal task sent 16 Sep), or the records vendor’s file (ETA 1 Oct) may be enough for clinical review.',
              ],
          sources: [{ label: 'Follow-up plan', section: 'requirements', target: 'req-vas-aps' }],
          actions: [{ kind: 'open', label: 'Open the requirement', section: 'requirements', target: 'req-vas-aps' }],
          followUps: ['How will the residual benefit be calculated?'],
        }
      },
    },
    {
      match: /residual|calculat|how much|benefit amount|earnings/,
      starter: 'How will the residual benefit be calculated?',
      answer: (ctx) => {
        const fin = ctx.requirements.filter((r) => /tax return|p&l/i.test(r.name))
        return {
          paragraphs: [
            'Elena’s residual benefit is her loss of earnings as a share of her prior earnings, applied to the $12,000 monthly benefit. For example — illustrative only — a 40% loss of earnings would pay 40% of $12,000, or $4,800 a month.',
          ],
          bullets: [
            'Prior earnings come from her 2024 and 2025 tax returns.',
            'Current earnings come from the monthly practice P&L since June.',
            ...fin.map((r) => `${r.name}: ${r.status.label.toLowerCase()}`),
            'Hugo Brenner, claims financial analyst, does the calculation once they’re in.',
          ],
          sources: [{ label: 'Residual rider', section: 'policies' }, { label: 'Financials', section: 'financials' }, { label: 'Requirements', section: 'requirements' }],
          actions: [{ kind: 'open', label: 'Open Financials', section: 'financials' }],
          followUps: ['What’s still outstanding?'],
        }
      },
    },
  ],

  // ---------------------------------------------------------------- Bell — DI, ongoing
  'D-25-018334': [
    {
      match: /any.?occ|own.?occ|transition|definition/,
      starter: 'When does the definition change to any occupation?',
      answer: () => ({
        paragraphs: ['Marcus’s own-occupation period ends on 31 May 2027. From 1 Jun 2027 he is disabled only if he can’t work in any occupation reasonably suited to his education, training and experience.'],
        bullets: [
          '14 Oct — transferable skills analysis with Chris Duarte, CRC.',
          '1 Dec — the transition review opens and the any-occupation notice should go out.',
          'The better sitting tolerance in the new APS may widen the occupations the analysis finds.',
        ],
        sources: [{ label: 'Policy · definitions', section: 'policies' }, { label: 'Case plan', section: 'case-plan' }],
        actions: [{ kind: 'open', label: 'Open case plan', section: 'case-plan' }],
        followUps: ['What changed in the new APS?'],
      }),
    },
    {
      match: /aps|changed|restriction|castillo|new statement|sitting/,
      starter: 'What changed in the new APS?',
      answer: (ctx) => {
        const doc = ctx.documents.find((d) => d.id === 'doc-bell-aps')
        return {
          paragraphs: ['Dr. Castillo’s statement of 22 Sep, compared with June:'],
          bullets: [
            'Sitting: 30 minutes at a time (was 20).',
            'Sitting per day: 4 hours (was 3) — handwritten and low confidence, so worth checking.',
            'Prognosis: permanent restrictions, maximum medical improvement reached (was “re-evaluate in 3 months”).',
            'No change to lifting (10 lb occasionally), standing, walking or postural limits.',
          ],
          after: [
            doc && !doc.isNew
              ? 'The fields have been accepted, so proof of loss is renewed to 21 Dec.'
              : 'Accepting the fields renews proof of loss to 21 Dec and updates the restrictions Chris Duarte uses on 14 Oct.',
          ],
          sources: [{ label: 'APS · 22 Sep, p.2', section: 'documents', target: 'doc-bell-aps' }, { label: 'Medical', section: 'medical' }],
          actions: [{ kind: 'open', label: 'Review the APS', section: 'documents', target: 'doc-bell-aps' }],
          followUps: ['When does the definition change to any occupation?'],
        }
      },
    },
  ],

  // ---------------------------------------------------------------- Hart — annuity, two beneficiaries
  'A-26-015530': [
    {
      match: /tax|withh|1099|nathan/,
      starter: 'How is Nathan’s payment taxed?',
      answer: () => ({
        paragraphs: ['Nathan’s $327,500 share includes $127,500 of taxable gain — his half of the $255,000 gain over the $400,000 cost basis. Federal withholding of 10% on the gain, $12,750, leaves $314,750, paid by EFT on 26 Sep.'],
        bullets: ['He’ll receive a 1099-R for the gain.', 'He chose the withholding on his W-4R.'],
        sources: [{ label: 'Distributions', section: 'distributions' }, { label: 'W-4R', section: 'documents' }],
        followUps: ['What are Claire’s options?'],
      }),
    },
    {
      match: /fixed|float|market|why.*(amount|value)|how much.*claire|claire.*how much/,
      starter: 'Why isn’t Claire’s amount fixed yet?',
      answer: () => ({
        paragraphs: ['Each share is valued on the day that beneficiary’s claim is in good order. Claire’s half stays invested until then, so it moves with the market — but it can’t fall below $327,500, half of the guaranteed minimum death benefit.'],
        bullets: [
          'Contract value on 22 Sep: $612,400.',
          'Guaranteed minimum death benefit (highest anniversary, 14 Feb 2026): $655,000.',
          'Nathan’s half was valued on 22 Sep at $327,500.',
        ],
        sources: [{ label: 'GMDB rider', section: 'policies' }, { label: 'Unit values · 22 Sep', section: 'distributions' }],
        followUps: ['What are Claire’s options?'],
      }),
    },
    {
      match: /option|elect|choose|lump|5.?year|life expectancy|claire/,
      starter: 'What are Claire’s options?',
      answer: (ctx) => {
        const r = ctx.requirements.find((x) => x.id === 'req-hart-claire')
        const inOrder = r && (r.state === 'met' || r.state === 'waived')
        return {
          paragraphs: ['The contract is non-qualified, so Claire’s deadlines run from the date of death, 3 Sep 2026:'],
          bullets: [
            'Lump sum — the whole gain is taxable in one year.',
            'Within 5 years — fully paid out by 3 Sep 2031.',
            'Over her life expectancy — payments must start by 3 Sep 2027.',
            'Continuing as owner is only for a spouse, so it isn’t open to her.',
          ],
          after: [inOrder ? 'Her claim is now in good order, so she can elect.' : 'She can’t elect until her claimant statement and W-9 arrive.'],
          sources: [{ label: 'Contract VA-2201946', section: 'policies' }, { label: 'Distributions', section: 'distributions' }],
          actions: [{ kind: 'open', label: 'Open Distributions', section: 'distributions' }],
          followUps: ['Why isn’t Claire’s amount fixed yet?'],
        }
      },
    },
  ],
}
