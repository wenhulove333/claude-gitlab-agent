/**
 * Prometheus metrics for Claude GitLab Agent
 *
 * Metrics exposed:
 * - claude_webhook_requests_total{event_type} - Total webhook requests
 * - claude_task_duration_seconds{task_type} - Task duration histogram
 * - claude_task_success_total{task_type} - Successful tasks
 * - claude_task_failed_total{task_type} - Failed tasks
 * - claude_workspace_count - Current workspace count
 */

export type EventType = 'issue' | 'merge_request' | 'note' | 'unknown';
export type TaskType = 'comment' | 'review' | 'create_mr' | 'unknown';

// Simple counter implementation
class Counter {
  private value = 0;
  private labels: Record<string, string> = {};

  inc(labels: Record<string, string> = {}): void {
    this.value++;
    this.labels = labels;
  }

  getValue(): number {
    return this.value;
  }

  getLabels(): Record<string, string> {
    return this.labels;
  }
}

// Simple gauge implementation
class Gauge {
  private value = 0;

  set(value: number): void {
    this.value = value;
  }

  inc(): void {
    this.value++;
  }

  dec(): void {
    this.value--;
  }

  getValue(): number {
    return this.value;
  }
}

// Simple histogram implementation
class Histogram {
  private values: number[] = [];
  private labels: Record<string, string> = {};
  private buckets = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

  observe(value: number, labels: Record<string, string> = {}): void {
    this.values.push(value);
    this.labels = labels;
  }

  getValues(): number[] {
    return this.values;
  }

  getLabels(): Record<string, string> {
    return this.labels;
  }

  getBuckets(): number[] {
    return this.buckets;
  }
}

// Metrics storage
const metrics = {
  webhookRequests: new Counter(),
  taskDuration: new Histogram(),
  taskSuccess: new Counter(),
  taskFailed: new Counter(),
  workspaceCount: new Gauge(),
};

export function recordWebhookRequest(eventType: EventType): void {
  metrics.webhookRequests.inc({ event_type: eventType });
}

export function recordTaskDuration(taskType: TaskType, durationSeconds: number): void {
  metrics.taskDuration.observe(durationSeconds, { task_type: taskType });
}

export function recordTaskSuccess(taskType: TaskType): void {
  metrics.taskSuccess.inc({ task_type: taskType });
}

export function recordTaskFailed(taskType: TaskType): void {
  metrics.taskFailed.inc({ task_type: taskType });
}

export function setWorkspaceCount(count: number): void {
  metrics.workspaceCount.set(count);
}

export function incrementWorkspaceCount(): void {
  metrics.workspaceCount.inc();
}

export function decrementWorkspaceCount(): void {
  metrics.workspaceCount.dec();
}

/**
 * Generate Prometheus metrics output
 */
export function generateMetrics(): string {
  const lines: string[] = [
    '# HELP claude_webhook_requests_total Total webhook requests',
    '# TYPE claude_webhook_requests_total counter',
    `claude_webhook_requests_total{event_type="unknown"} ${metrics.webhookRequests.getValue()}`,
    '',
    '# HELP claude_task_duration_seconds Task duration in seconds',
    '# TYPE claude_task_duration_seconds histogram',
    ...generateHistogramLines('claude_task_duration_seconds', metrics.taskDuration),
    '',
    '# HELP claude_task_success_total Successful tasks',
    '# TYPE claude_task_success_total counter',
    `claude_task_success_total{task_type="unknown"} ${metrics.taskSuccess.getValue()}`,
    '',
    '# HELP claude_task_failed_total Failed tasks',
    '# TYPE claude_task_failed_total counter',
    `claude_task_failed_total{task_type="unknown"} ${metrics.taskFailed.getValue()}`,
    '',
    '# HELP claude_workspace_count Current workspace count',
    '# TYPE claude_workspace_count gauge',
    `claude_workspace_count ${metrics.workspaceCount.getValue()}`,
  ];

  return lines.join('\n');
}

function generateHistogramLines(name: string, histogram: Histogram): string[] {
  const lines: string[] = [];
  const values = histogram.getValues();
  const buckets = histogram.getBuckets();

  for (const bucket of buckets) {
    const count = values.filter((v) => v <= bucket).length;
    lines.push(`${name}_bucket{le="${bucket}"} ${count}`);
  }

  // +Inf bucket
  lines.push(`${name}_bucket{le="+Inf"} ${values.length}`);
  lines.push(`${name}_sum ${values.reduce((a, b) => a + b, 0)}`);
  lines.push(`${name}_count ${values.length}`);

  return lines;
}
