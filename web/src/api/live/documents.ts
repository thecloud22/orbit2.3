/** Documents, from the backend's records to what the Documents section, the requirement detail and the counts show. */
import type { Status } from '../types'
import type { DocumentRecord } from '../documents'
import type { ApiDocument } from './types'
import type { Bundle } from './present'
import { day, stamp } from './time'
import { staffByHandle } from './staff'

export const DOC_KIND: Record<ApiDocument['kind'], string> = {
  claimant_statement_w9: 'Claimant statement and W-9',
  death_certificate: 'Death certificate',
  police_report: 'Police report',
  other: 'Other document',
}

export const DOC_SOURCE: Record<ApiDocument['source'], string> = { portal: 'Portal', mail_room: 'Mail room', upload: 'Upload' }

export function docStatus(d: Pick<ApiDocument, 'status'>): Status {
  switch (d.status) {
    case 'received': return { label: 'Received · workflow deciding', tone: 'info' }
    case 'accepted': return { label: 'Accepted', tone: 'positive' }
    case 'not_enough': return { label: 'Not enough', tone: 'caution' }
    case 'under_review': return { label: 'Under review', tone: 'special' }
    case 'rejected': return { label: 'Rejected', tone: 'critical' }
  }
}

/** 'Diane Castellano' or 'Claimant statement and W-9 · Diane Castellano'. */
export const docTitle = (d: ApiDocument): string => `${DOC_KIND[d.kind]}${d.partyName ? ` · ${d.partyName}` : ''}`

/** 'a photocopy, no raised seal', 'certified, seal present', 'taxpayer number ***-**-6789': what the sender declared. */
export function docFacts(d: ApiDocument): string[] {
  const out: string[] = []
  if (d.attributes.tinMasked) out.push(`Taxpayer number ${d.attributes.tinMasked}`)
  if (d.attributes.photocopy === true) out.push('Photocopy')
  else if (d.attributes.photocopy === false) out.push('Original')
  if (d.attributes.sealPresent === true) out.push('Raised seal')
  else if (d.attributes.sealPresent === false) out.push('No raised seal')
  return out
}

/** Who reviewed it, by name (`rachel` -> Rachel Kim; a name the backend already recorded is kept). */
export const reviewerName = (handle: string | null | undefined): string | undefined => (handle ? staffByHandle(handle)?.name ?? handle : undefined)

/** The claim's documents, newest first, as the mock's document rows (for the counts and anything that reads `listDocuments`). */
export function mapDocuments(b: Bundle): DocumentRecord[] {
  return [...b.documents]
    .sort((x, y) => y.receivedAt.localeCompare(x.receivedAt))
    .map((d) => ({
      id: d.id,
      claimId: b.claim.claimNumber,
      title: docTitle(d),
      docType: DOC_KIND[d.kind],
      received: day(d.receivedAt),
      channel: DOC_SOURCE[d.source],
      pages: 1,
      // What waits for a person is what the section flags as new.
      isNew: d.status === 'under_review',
      status: docStatus(d),
      satisfies: d.requirementName ?? undefined,
      requirementId: d.requirementId ?? undefined,
      from: d.partyName ?? undefined,
    }))
}

export const docStamp = (d: Pick<ApiDocument, 'receivedAt'>): string => stamp(d.receivedAt)

/** The route to a run on Workflow & SLA: its key is the workflow id, plus #n from the second run on. */
export const runPath = (claim: string, key: string): string => `/claims/${claim}/workflow/run:${encodeURIComponent(key)}`
