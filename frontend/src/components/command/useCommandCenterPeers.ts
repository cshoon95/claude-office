"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useOverviewStore,
  selectOverviewEntries,
} from "@/stores/overviewStore";
import type { BossState, Position } from "@/types";
import type { Session } from "@/hooks/useSessions";
import {
  MAX_SLOTS,
  ZONE_BY_KEY,
  ZONE_ORDER,
  slotPosition,
  type ZoneKey,
} from "./layout";

// Ended sessions linger in the Ended zone for this long after they finish.
// (로컬 커스텀) 끝난 세션은 퇴근시키지 않고 3시간 동안 "휴식 중" 칸에서 논다
const RECENT_ENDED_MS = 3 * 60 * 60 * 1000;
// 완료 후 이만큼 조용하면 소파(완료)에서 휴식 칸으로 옮긴다
const REST_AFTER_MS = 5 * 60 * 1000;
// 휴식 칸 놀이 — 2분마다 바뀐다
export const ACTIVITIES = ["run", "jump", "pushup", "ball", "dance", "stretch", "sleep"] as const;
export type Activity = (typeof ACTIVITIES)[number];
function activityFor(id: string, now: number): Activity {
  let h = 7;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ACTIVITIES[(h + Math.floor(now / 120000)) % ACTIVITIES.length];
}

export interface CommandPeer {
  activity: Activity;
  sessionId: string;
  label: string;
  bucket: ZoneKey;
  state: BossState | null;
  currentTask: string | null;
  todoDone: number;
  todoTotal: number;
  subagentCount: number;
  /** (로컬 커스텀) 대기 중일 때 Claude 가 묻는 질문(첫 줄 질문 + 선택지 줄) */
  pendingQuestion: string | null;
  slotIndex: number;
  /** Static slot position (Phase B). Walking between slots lands in Phase C. */
  position: Position;
}

/** Combined cross-session totals shown on the Command Center board. */
export interface CommandSummary {
  /** Live terminals (active = needs-you + working + done). */
  terminals: number;
  /** Total active subagents across all sessions. */
  subagents: number;
  todoDone: number;
  todoTotal: number;
}

export interface CommandCenterPeers {
  peers: CommandPeer[];
  counts: Record<ZoneKey, number>;
  overflow: Record<ZoneKey, number>;
  summary: CommandSummary;
}

function labelFor(session: Session | undefined, sessionId: string): string {
  return (
    session?.projectName ||
    session?.displayName ||
    session?.label ||
    sessionId.slice(0, 8)
  );
}

// ---------------------------------------------------------------------------
// Free-slot allocator (module-level so it persists across renders).
// Each session claims the lowest free slot in its column and KEEPS it until it
// leaves or changes column — agents don't reshuffle when others come and go.
// Idempotent (safe under double-render).
// ---------------------------------------------------------------------------
const slotAlloc = new Map<string, { bucket: ZoneKey; slot: number }>();

/** Clear all slot reservations (call on Command Center unmount). */
export function resetSlotAlloc(): void {
  slotAlloc.clear();
}

function assignSlots(
  presentByBucket: Map<ZoneKey, string[]>,
): Map<string, number> {
  const bucketOf = new Map<string, ZoneKey>();
  for (const [bucket, ids] of presentByBucket)
    for (const id of ids) bucketOf.set(id, bucket);

  // Release slots for sessions that left or changed column.
  for (const [sid, a] of [...slotAlloc]) {
    if (bucketOf.get(sid) !== a.bucket) slotAlloc.delete(sid);
  }

  const result = new Map<string, number>();
  for (const [bucket, ids] of presentByBucket) {
    const used = new Set<number>();
    for (const id of ids) {
      const a = slotAlloc.get(id);
      if (a) used.add(a.slot);
    }
    // Sorted so simultaneous newcomers get deterministic slots.
    for (const id of [...ids].sort()) {
      let a = slotAlloc.get(id);
      if (!a) {
        let slot = 0;
        while (used.has(slot)) slot++;
        used.add(slot);
        a = { bucket, slot };
        slotAlloc.set(id, a);
      }
      result.set(id, a.slot);
    }
  }
  return result;
}

/**
 * Combine the live `/ws/overview` entries with recently-ended sessions from the
 * polled session list, join project labels, and assign each peer to a zone slot.
 *
 * Bucketing rules:
 * - A session the list marks "ended" goes to the Ended zone regardless of any
 *   stale in-memory boss state.
 * - Otherwise the live bucket from the overview feed wins.
 * - Recently-ended sessions with no live entry still appear in the Ended zone.
 */
export function useCommandCenterPeers(sessions: Session[]): CommandCenterPeers {
  const entries = useOverviewStore(selectOverviewEntries);

  // Ticking clock (kept out of render for purity) used to age out ended peers.
  // Initialized to the current time so the first render correctly ages out old
  // ended sessions; the interval keeps it fresh thereafter.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => {
    const sessionById = new Map(sessions.map((s) => [s.id, s]));

    // Bucketed, pre-slot peers (without position yet).
    type Raw = Omit<CommandPeer, "slotIndex" | "position">;
    const byZone: Record<ZoneKey, Raw[]> = {
      needs_you: [],
      working: [],
      done: [],
      ended: [],
    };
    const seen = new Set<string>();
    // (로컬 커스텀) 조용해서 휴식 칸으로 옮긴 세션도 터미널은 열려 있다 — 합계에 넣는다
    let resting = 0;

    // 1) Live entries from the overview feed.
    for (const e of entries) {
      const session = sessionById.get(e.sessionId);
      // The backend marks finished sessions "completed" (not "active").
      const quiet = session ? now - new Date(session.updatedAt).getTime() : 0;
      const bucket: ZoneKey =
        session && session.status !== "active"
          ? "ended"
          : e.bucket === "done" && quiet > REST_AFTER_MS
            ? "ended"
            : e.bucket;
      seen.add(e.sessionId);
      if (bucket === "ended" && session?.status === "active") resting++;
      byZone[bucket].push({
        activity: activityFor(e.sessionId, now),
        sessionId: e.sessionId,
        label: labelFor(session, e.sessionId),
        bucket,
        state: e.state,
        currentTask: e.currentTask ?? null,
        todoDone: e.todoDone ?? 0,
        todoTotal: e.todoTotal ?? 0,
        subagentCount: e.subagentCount ?? 0,
        pendingQuestion: e.pendingQuestion ?? null,
      });
    }

    // 2) Recently-finished sessions with no live entry.
    for (const s of sessions) {
      if (seen.has(s.id)) continue;
      if (s.status === "active") continue; // only finished sessions exit
      const endedAt = new Date(s.updatedAt).getTime();
      if (Number.isNaN(endedAt) || now - endedAt > RECENT_ENDED_MS) continue;
      byZone.ended.push({
        activity: activityFor(s.id, now),
        sessionId: s.id,
        label: labelFor(s, s.id),
        bucket: "ended",
        state: null,
        currentTask: null,
        todoDone: 0,
        todoTotal: 0,
        subagentCount: 0,
        pendingQuestion: null,
      });
    }

    // 3) Free-slot allocation: each session keeps whatever slot it claimed
    //    (lowest free) until it leaves/changes column — no reshuffling.
    const presentByBucket = new Map<ZoneKey, string[]>();
    for (const key of ZONE_ORDER)
      presentByBucket.set(
        key,
        byZone[key].map((r) => r.sessionId),
      );
    const slots = assignSlots(presentByBucket);

    const peers: CommandPeer[] = [];
    const counts = {} as Record<ZoneKey, number>;
    const overflow = {} as Record<ZoneKey, number>;
    for (const key of ZONE_ORDER) {
      const zone = ZONE_BY_KEY[key];
      const raws = byZone[key];
      counts[key] = raws.length;
      let overflowCount = 0;
      for (const raw of raws) {
        const slot = slots.get(raw.sessionId) ?? 0;
        if (slot >= MAX_SLOTS) {
          overflowCount++;
          continue;
        }
        peers.push({
          ...raw,
          slotIndex: slot,
          position: slotPosition(zone, slot),
        });
      }
      overflow[key] = overflowCount;
    }

    // Combined cross-session totals (active terminals only).
    const summary: CommandSummary = {
      terminals: counts.needs_you + counts.working + counts.done + resting,
      subagents: 0,
      todoDone: 0,
      todoTotal: 0,
    };
    for (const key of ["needs_you", "working", "done"] as const) {
      for (const raw of byZone[key]) {
        summary.subagents += raw.subagentCount;
        summary.todoDone += raw.todoDone;
        summary.todoTotal += raw.todoTotal;
      }
    }

    return { peers, counts, overflow, summary };
  }, [entries, sessions, now]);
}
