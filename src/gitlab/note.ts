import { GitLabClient } from './client.js';
import type { Note } from './types.js';

export interface CreateNoteOptions {
  body: string;
  noteableType: 'Issue' | 'MergeRequest';
}

export class NoteAPI {
  constructor(private client: GitLabClient) {}

  async create(projectId: number, noteableIid: number, body: string): Promise<Note> {
    return this.client.post<Note>(`/projects/${projectId}/issues/${noteableIid}/notes`, { body });
  }

  async update(projectId: number, noteId: number, body: string): Promise<Note> {
    return this.client.put<Note>(`/projects/${projectId}/notes/${noteId}`, { body });
  }

  async delete(projectId: number, noteId: number): Promise<void> {
    return this.client.delete(`/projects/${projectId}/notes/${noteId}`);
  }
}
