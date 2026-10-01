import type { User } from '../types'

export const USERS: User[] = [
  {
    id: 'rachel',
    name: 'Rachel Kim',
    initials: 'RK',
    title: 'Life claims examiner',
    team: 'Life & annuity team',
    role: 'lifeExaminer',
    payoutLimit: 250_000,
    authorityNotes: ['Life payouts to $250,000', 'Denials need a second review'],
  },
  {
    id: 'jordan',
    name: 'Jordan Ellis',
    initials: 'JE',
    title: 'DI case manager',
    team: 'DI Team 2',
    role: 'diCaseManager',
    payoutLimit: 15_000,
    authorityNotes: ['Monthly benefits to $15,000', 'Denials need a second review'],
  },
  {
    id: 'irene',
    name: 'Irene Walsh',
    initials: 'IW',
    title: 'Annuity claims specialist',
    team: 'Life & annuity team',
    role: 'annuitySpecialist',
    payoutLimit: 750_000,
    authorityNotes: ['Annuity claims to $750,000', 'Recoveries above $10,000 need approval'],
  },
  {
    id: 'monica',
    name: 'Monica Reyes',
    initials: 'MR',
    title: 'Team lead, life & annuity',
    team: 'Life & annuity team',
    role: 'teamLead',
    payoutLimit: 2_000_000,
    authorityNotes: ['Payouts to $2,000,000', 'Second reviews for the team'],
  },
]

/** People who appear on claims but don't sign in to this mock. */
export const STAFF: Record<string, { name: string; initials: string; title: string }> = {
  leon: { name: 'Leon Park', initials: 'LP', title: 'Life claims examiner' },
  sofia: { name: 'Sofia Marin', initials: 'SM', title: 'Life claims examiner' },
  dmitri: { name: 'Dmitri Novak', initials: 'DN', title: 'DI examiner' },
  owen: { name: 'Owen Brandt', initials: 'OB', title: 'Reconsideration specialist' },
  priya: { name: 'Priya Nair', initials: 'PN', title: 'DI case manager' },
}
