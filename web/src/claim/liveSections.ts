import { createElement, type ComponentType } from 'react'
import type { SectionKey } from '../api/types'
import { NotLive } from './NotLive'
import type { SectionProps } from './sections/types'
import { DecisionLive } from './sections/DecisionLive'
import { PaymentsLive } from './sections/PaymentsLive'
import { DocumentsLive } from './sections/DocumentsLive'

/** A plain "not on the backend yet" note, for a section the backend has nothing for (none today). */
export function notLive(section: SectionKey, title: string, needs: string[]): ComponentType<SectionProps> {
  return function NotLiveSection() {
    return createElement(NotLive, { title, needs, section })
  }
}

/**
 * What a live claim shows in place of the mock's section. A section that is not listed here is the mock's own component,
 * fed by live data (Overview, Workflow, Policies, People, Requirements, Communications, History).
 *
 * Decision, Payments and Documents are live components (DecisionLive, PaymentsLive, DocumentsLive): they read the backend's decisions,
 * payment items and payment runs, and its documents (with the examiner's review).
 */
export const LIVE_SECTIONS: Partial<Record<SectionKey, ComponentType<SectionProps>>> = {
  documents: DocumentsLive,
  decision: DecisionLive,
  payments: PaymentsLive,
}
