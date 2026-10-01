import type { ComponentType } from 'react'
import type { SectionKey } from '../../api/types'
import type { SectionProps } from './types'
import { OverviewSection } from './Overview'
import { PoliciesSection } from './Policies'
import { PeopleSection } from './People'
import { RequirementsSection } from './Requirements'
import { DocumentsSection } from './Documents'
import { ContestableSection } from './Contestable'
import { MedicalSection } from './Medical'
import { FinancialsSection } from './Financials'
import { DecisionSection } from './Decision'
import { PaymentsSection } from './Payments'
import { DistributionsSection } from './Distributions'
import { CasePlanSection } from './CasePlan'
import { CommunicationsSection } from './Communications'
import { HistorySection } from './History'
import { WorkflowSection } from './Workflow'

export const SECTIONS: Record<SectionKey, ComponentType<SectionProps>> = {
  overview: OverviewSection,
  workflow: WorkflowSection,
  policies: PoliciesSection,
  people: PeopleSection,
  requirements: RequirementsSection,
  documents: DocumentsSection,
  contestable: ContestableSection,
  medical: MedicalSection,
  financials: FinancialsSection,
  decision: DecisionSection,
  payments: PaymentsSection,
  distributions: DistributionsSection,
  'case-plan': CasePlanSection,
  communications: CommunicationsSection,
  history: HistorySection,
}
