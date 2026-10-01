import { NOTES, TASKS } from './fixtures/tasks'
import { collection, newId, respond } from './store'
import { nowStamp } from '../lib/dates'
import type { Note, Task } from './types'

export const tasks = collection<Task>(TASKS)
export const notes = collection<Note>(NOTES)

/** GET /claims/{id}/tasks */
export function listTasks(claimId: string): Promise<Task[]> {
  return respond(tasks.where((t) => t.claimId === claimId))
}

export function addTask(claimId: string, title: string, assignee: string, source?: string, due?: string): Task {
  return tasks.insert({ id: newId('t'), claimId, title, assignee, done: false, source, due })
}

export function toggleTask(id: string): Promise<void> {
  tasks.update(id, (t) => ({ done: !t.done }))
  return respond(undefined)
}

/** GET /claims/{id}/notes — newest first. */
export function listNotes(claimId: string): Promise<Note[]> {
  return respond(notes.where((n) => n.claimId === claimId).sort((a, b) => b.at.localeCompare(a.at)))
}

export function addNote(claimId: string, author: string, text: string): Promise<Note> {
  return respond(notes.insert({ id: newId('n'), claimId, author, text, at: nowStamp() }))
}
