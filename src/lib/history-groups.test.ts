import { describe, expect, it } from "vitest";
import { groupJobsByLocalDay, type HistoryGroupableJob } from "./history-groups";

describe("history grouping", () => {
  it("groups jobs by local day newest first", () => {
    const jobs: HistoryGroupableJob[] = [
      { id: "old", createdAt: "2026-04-27T09:00:00.000Z" },
      { id: "newer", createdAt: "2026-04-29T11:30:00.000Z" },
      { id: "new", createdAt: "2026-04-29T10:30:00.000Z" },
      { id: "yesterday", createdAt: "2026-04-28T08:00:00.000Z" }
    ];

    expect(groupJobsByLocalDay(jobs, new Date("2026-04-29T12:00:00.000Z"))).toEqual([
      {
        key: "2026-04-29",
        label: "今天",
        jobs: [
          { id: "newer", createdAt: "2026-04-29T11:30:00.000Z" },
          { id: "new", createdAt: "2026-04-29T10:30:00.000Z" }
        ]
      },
      {
        key: "2026-04-28",
        label: "昨天",
        jobs: [{ id: "yesterday", createdAt: "2026-04-28T08:00:00.000Z" }]
      },
      {
        key: "2026-04-27",
        label: "2026年4月27日",
        jobs: [{ id: "old", createdAt: "2026-04-27T09:00:00.000Z" }]
      }
    ]);
  });

  it("places missing dates into an unknown group", () => {
    expect(groupJobsByLocalDay([{ id: "draft" }], new Date("2026-04-29T12:00:00.000Z"))).toEqual([
      {
        key: "unknown",
        label: "时间未知",
        jobs: [{ id: "draft" }]
      }
    ]);
  });
});
