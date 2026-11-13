'use client';

import type { ProjectionInput, ProjectionResult } from '@/lib/projection/types';
import type { EntityDto } from '@/lib/server/dto';
import { useApi } from './api';
import { useApp } from '@/components/AppContext';

export interface ProjectionPayload {
  ctx: string;
  entities: EntityDto[];
  input: ProjectionInput;
  result: ProjectionResult;
}

export function useProjection() {
  const app = useApp();
  return useApi<ProjectionPayload>(`/api/projection?${app.qs}`);
}
