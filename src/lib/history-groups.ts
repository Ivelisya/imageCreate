export type HistoryGroupableJob = {
  id: string;
  createdAt?: string;
};

export type HistoryDayGroup<T extends HistoryGroupableJob> = {
  key: string;
  label: string;
  jobs: T[];
};

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function localDayLabel(date: Date, now: Date): string {
  const dayStart = startOfLocalDay(date);
  const nowStart = startOfLocalDay(now);
  const deltaDays = Math.round((nowStart.getTime() - dayStart.getTime()) / 86_400_000);

  if (deltaDays === 0) {
    return "今天";
  }

  if (deltaDays === 1) {
    return "昨天";
  }

  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function getJobTime(job: HistoryGroupableJob): number {
  if (!job.createdAt) {
    return Number.NEGATIVE_INFINITY;
  }

  const time = new Date(job.createdAt).getTime();
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

export function groupJobsByLocalDay<T extends HistoryGroupableJob>(
  jobs: T[],
  now = new Date()
): HistoryDayGroup<T>[] {
  const groups = new Map<string, HistoryDayGroup<T>>();

  for (const job of [...jobs].sort((left, right) => getJobTime(right) - getJobTime(left))) {
    const date = job.createdAt ? new Date(job.createdAt) : null;
    const hasValidDate = date !== null && !Number.isNaN(date.getTime());
    const key = hasValidDate ? localDayKey(date) : "unknown";
    const label = hasValidDate ? localDayLabel(date, now) : "时间未知";
    const group = groups.get(key) ?? { key, label, jobs: [] };

    group.jobs.push(job);
    groups.set(key, group);
  }

  return [...groups.values()];
}
