/**
 * Command Center layout — "Open Plan / Columns".
 *
 * A single open office floor (matching the main office) with a decorated top
 * wall. The floor is split into four vertical status columns (left→right by
 * priority): Needs-you, Working, Done, Ended. Each column holds a 2×4 grid of
 * workstations; overflow is summarised as "+N more".
 */

import type { OverviewBucket, Position } from "@/types";
import type { TranslationKey } from "@/i18n";
import { CANVAS_WIDTH, CANVAS_HEIGHT } from "@/constants/canvas";

/** Status columns, including the frontend-only "ended" bucket. */
export type ZoneKey = OverviewBucket | "ended";

/** What fixed furniture a column shows. */
export type ZoneKind = "desks" | "lounge" | "exit" | "gym";

export interface ZoneDef {
  key: ZoneKey;
  kind: ZoneKind;
  labelKey: TranslationKey;
  emoji: string;
  color: number; // PixiJS hex
  cssColor: string;
  x: number; // column left
  y: number; // column top (floor top)
  w: number; // column width
  h: number; // column height
}

/** Height of the decorated top wall strip. */
export const TOP_WALL_H = 250;
/** Floor furniture strip begins here (below the desk grid). */
export const FLOOR_DECOR_Y = CANVAS_HEIGHT - 96;

const COL_W = CANVAS_WIDTH / 4; // 320
const FLOOR_TOP = TOP_WALL_H;
const FLOOR_H = CANVAS_HEIGHT - TOP_WALL_H;

const COL_DEFS: Array<{
  key: ZoneKey;
  kind: ZoneKind;
  labelKey: TranslationKey;
  emoji: string;
  color: number;
  cssColor: string;
}> = [
  {
    key: "needs_you",
    kind: "desks",
    labelKey: "commandCenter.zone.needsYou",
    emoji: "⚠",
    color: 0xfbbf24,
    cssColor: "#fbbf24",
  },
  {
    key: "working",
    kind: "desks",
    labelKey: "commandCenter.zone.working",
    emoji: "\u{1F7E2}",
    color: 0x22c55e,
    cssColor: "#22c55e",
  },
  {
    key: "done",
    kind: "lounge",
    labelKey: "commandCenter.zone.done",
    emoji: "✅",
    color: 0x3b82f6,
    cssColor: "#3b82f6",
  },
  {
    // (로컬 커스텀) 4번째 칸 = 휴식 중: 쉰 지 오래됐거나 끝난 세션이 뛰고 운동하며 논다
    key: "ended",
    kind: "gym",
    labelKey: "commandCenter.zone.ended",
    emoji: "🏃",
    color: 0xa78bfa,
    cssColor: "#a78bfa",
  },
];

export const ZONES: ZoneDef[] = COL_DEFS.map((c, i) => ({
  ...c,
  x: i * COL_W,
  y: FLOOR_TOP,
  w: COL_W,
  h: FLOOR_H,
}));

export const ZONE_ORDER: ZoneKey[] = ["needs_you", "working", "done", "ended"];

export const ZONE_BY_KEY: Record<ZoneKey, ZoneDef> = ZONES.reduce(
  (acc, z) => {
    acc[z.key] = z;
    return acc;
  },
  {} as Record<ZoneKey, ZoneDef>,
);

/** Elevator/exit doorway sits on the back wall at the floor boundary. */
export const EXIT_DOOR_BASE_Y = TOP_WALL_H;
export const EXIT_DOOR_X = ZONE_BY_KEY.ended.x + ZONE_BY_KEY.ended.w / 2;

// Workstation grid within a column.
// (로컬 커스텀) 책상은 칸마다 가운데 한 줄 3개(말풍선이 서로 안 가리게 넉넉히).
// 4번째 세션부터는 책상 없이 오른쪽 옆에 "서서" 보인다(최대 6명) — 안 보이게 숨지 않도록.
const DESK_ROWS = 3;
const HEADER_H = 44;
const ROW_TOP = FLOOR_TOP + HEADER_H + 190; // first row's feet (위에 말풍선 자리)
const ROW_GAP = 225;
const STANDING_DX = 92; // 4~6번째: 가운데 줄에서 오른쪽으로

/** 책상(소파)이 놓이는 자리 수. */
export const DESK_SLOTS = DESK_ROWS; // 3
/** Max visible agents per column before collapsing to "+N more". */
export const MAX_SLOTS = DESK_ROWS * 2; // 6

/** Pixel position (agent feet) for the slot at *index* within *zone* (column). */
export function slotPosition(zone: ZoneDef, index: number): Position {
  if (zone.kind === "gym") {
    // 휴식 칸: 2열 × 3행 놀이 자리(책상 없음)
    const col = index % 2;
    const row = Math.floor(index / 2) % DESK_ROWS;
    return { x: zone.x + zone.w * (col ? 0.7 : 0.3), y: ROW_TOP + row * ROW_GAP - 20 };
  }
  const row = index % DESK_ROWS;
  const standing = index >= DESK_ROWS;
  const x = zone.x + zone.w / 2 + (standing ? STANDING_DX : 0);
  const y = ROW_TOP + row * ROW_GAP + (standing ? 24 : 0);
  return { x, y };
}
