/** The life intake page's draft, as the API's POST /claims/life-intake body. */
import type { LifeDraft, LifeIntakeContext } from '../lifeIntake'
import { inPlay } from '../lifeIntake'
import { postLifeIntake } from './data'
import type { LifeIntakeRequest } from './types'

const money2 = (n: number) => ({ amount: n.toFixed(2), currency: 'USD' })

/** The life intake draft as POST /claims/life-intake's body. The mock's policy administration supplies the snapshot the API asks for. */
export function toLifeIntakeRequest(ctx: LifeIntakeContext, draft: LifeDraft): LifeIntakeRequest {
  const { claimed } = inPlay(ctx, draft)
  const callerBeneficiary = ctx.designation.beneficiaries.find((b) => b.name === draft.callerName)
  return {
    caller: {
      name: draft.callerName,
      relationship: draft.relationship || undefined,
      phone: draft.phone || undefined,
      email: draft.email || undefined,
      contactBy: (['email', 'text', 'phone', 'mail'] as const).filter((k) => draft.contactBy[k]),
      verifiedDateOfBirth: draft.verifiedDob,
      verifiedPolicyNumber: draft.verifiedPolicy,
      agentConsent: draft.agentConsent === 'yes',
      beneficiaryRef: callerBeneficiary?.id,
    },
    insured: { name: ctx.insured.name, dateOfBirth: ctx.insured.dob, ssnLast4: ctx.insured.ssnLast4 || undefined },
    death: {
      dateOfDeath: draft.dateOfDeath,
      placeOfDeath: draft.placeOfDeath || undefined,
      manner: (draft.manner || 'natural') as 'natural' | 'accident' | 'pending',
      outsideUs: draft.outsideUs === 'yes',
      funeralHome: draft.funeralHome || undefined,
    },
    policies: claimed.map((p) => ({
      policyNumber: p.ref,
      productCode: p.ref.split('-')[0],
      productName: p.product,
      issueDate: p.issued,
      paidToDate: p.paidTo,
      inForce: p.inForce,
      faceAmount: money2(p.faceAmount),
      riders: p.riders.map((r) => ({ key: r.key, name: r.name, amount: money2(r.amount) })),
    })),
    designation: {
      date: ctx.designation.date,
      source: ctx.designation.source,
      beneficiaries: ctx.designation.beneficiaries.map((b) => {
        const c = draft.contacts[b.id]
        return {
          ref: b.id,
          name: b.name,
          relationship: b.relationship,
          kind: b.kind,
          sharePercent: b.share,
          dateOfBirth: b.dob,
          diedOn: b.died,
          diedSource: b.diedSource,
          contact: c && !b.died ? { phone: c.phone || undefined, email: c.email || undefined, address: c.address || undefined, packet: c.packet || undefined } : undefined,
        }
      }),
    },
    agent: { name: ctx.agent.name, agency: ctx.agent.agency },
    otherClaimantsPossible: draft.otherClaimants === 'yes',
  }
}

/** Submits the draft. Resolves to the new claim's number. Rejects with an ApiError: a 422 carries `errors`, see `intakeIssues`. */
export function submitLifeIntake(ctx: LifeIntakeContext, draft: LifeDraft): Promise<string> {
  return postLifeIntake(toLifeIntakeRequest(ctx, draft))
}
