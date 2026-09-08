import type { Attachment, PermissionRequest, PlanDoc } from './types';
import type { ModelState } from './models';
export type RunStatus = 'idle' | 'queued' | 'running' | 'needs-input' | 'completed' | 'failed' | 'interrupted';
export type QueuedPrompt = { id: string; text: string; attachments: Attachment[] };
export const EMPTY_QUEUE: QueuedPrompt[] = [];
export type TaskRuntime = ModelState & { status: RunStatus; processId?: number; queue: QueuedPrompt[]; permissions: PermissionRequest[]; draft: string; attachments: Attachment[]; planDoc: PlanDoc | null; planPanelOpen: boolean; planReviewOpen: boolean; error?: string; loading: boolean };
export function emptyRuntime(): TaskRuntime { return { status: 'idle', queue: [], permissions: [], models: [], efforts: [], draft: '', attachments: [], planDoc: null, planPanelOpen: false, planReviewOpen: false, loading: false }; }
export function isRunning(task?: Pick<TaskRuntime, 'status'>): boolean { return task?.status === 'running' || task?.status === 'needs-input'; }
export function nextQueued(tasks: Record<string, TaskRuntime>, concurrency: number): string[] {
  const capacity = Math.max(0, concurrency - Object.values(tasks).filter(isRunning).length);
  return Object.keys(tasks)
    .filter((id) => {
      const task = tasks[id];
      if (!task.queue.length || isRunning(task)) return false;
      if (task.status === "queued") return true;
      if (task.loading) return false;
      return task.status !== "failed" && task.status !== "interrupted";
    })
    .slice(0, capacity);
}
export function acceptsEvent(task: TaskRuntime | undefined, processId?: number): boolean { return Boolean(task && processId != null && task.processId === processId); }
export function addPermission(task: TaskRuntime, permission: PermissionRequest): TaskRuntime {
  if (task.permissions.some(p => p.id === permission.id && p.processId === permission.processId)) return task;
  return { ...task, status: 'needs-input', permissions: [...task.permissions, permission] };
}
