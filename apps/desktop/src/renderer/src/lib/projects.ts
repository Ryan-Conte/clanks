import type { ProjectSummary } from '@clanks/core';
import { createContext, useContext } from 'react';

/** The project list, kept live for the whole window. Null until it first arrives. */
export const ProjectsContext = createContext<ProjectSummary[] | null>(null);

export function useProjects(): ProjectSummary[] | null {
  return useContext(ProjectsContext);
}

export function useProject(id: string | null | undefined): ProjectSummary | undefined {
  return useProjects()?.find((p) => p.id === id);
}

/** A folder's last part, for showing a path briefly. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** A path inside a folder, with the folder's own separator. */
export function joinPath(folder: string, name: string): string {
  const separator = folder.includes('\\') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${separator}${name}`;
}
