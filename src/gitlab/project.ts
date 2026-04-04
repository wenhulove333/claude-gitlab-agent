import { GitLabClient } from './client.js';
import type { Project, Label } from './types.js';

export interface ProjectVariables {
  [key: string]: string | number | boolean;
}

export class ProjectAPI {
  constructor(private client: GitLabClient) {}

  async get(projectId: number): Promise<Project> {
    return this.client.get<Project>(`/projects/${projectId}`);
  }

  async getByPath(pathWithNamespace: string): Promise<Project> {
    const encoded = encodeURIComponent(pathWithNamespace);
    return this.client.get<Project>(`/projects/${encoded}`);
  }

  async getLabels(projectId: number): Promise<Label[]> {
    return this.client.get<Label[]>(`/projects/${projectId}/labels`);
  }

  async getVariable(projectId: number, key: string): Promise<{ value: string }> {
    return this.client.get(`/projects/${projectId}/variables/${key}`);
  }

  async setVariable(projectId: number, key: string, value: string): Promise<void> {
    return this.client.put(`/projects/${projectId}/variables/${key}`, { value });
  }
}
