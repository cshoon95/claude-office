"use client";

import { memo, useCallback, useRef, useState, type ReactNode } from "react";
import { useTick } from "@pixi/react";
import { Graphics, Texture } from "pixi.js";
import type { Position } from "@/types";
import { useMotionStore, selectMotionPos } from "@/systems/commandCenterMotion";
import { ZONE_BY_KEY, TOP_WALL_H, EXIT_DOOR_X } from "./layout";
import type { CommandPeer } from "./useCommandCenterPeers";

// ── 놀거리(로컬 커스텀): 쉬는 세션이 가끔 다녀오는 곳 ──
const WALK_Y = TOP_WALL_H + 34; // 벽 앞 통로
const ERRANDS: Array<{ x: number; text: string }> = [
  { x: EXIT_DOOR_X + 120, text: "💧 물 한 잔" },
  { x: 1000, text: "☕ 커피 내리는 중" },
  { x: 850, text: "🌇 창밖 구경" },
  { x: 420, text: "📝 투두 확인" },
  { x: 690, text: "⏰ 몇 시지…" },
];
const ERRAND_SPEED = 110; // px/s
const DWELL_MS = 3500;

type ErrandPhase = "idle" | "go" | "stay" | "back";
interface Errand {
  phase: ErrandPhase;
  nextAt: number; // idle → go 시작 시각
  waypoints: Position[]; // go 경로 (back은 역순)
  i: number;
  pos: Position | null;
  stayUntil: number;
  text: string;
}

function walkAlong(e: Errand, dt: number): boolean {
  let remaining = ERRAND_SPEED * dt;
  let pos = e.pos!;
  while (remaining > 0 && e.i < e.waypoints.length - 1) {
    const next = e.waypoints[e.i + 1];
    const dx = next.x - pos.x;
    const dy = next.y - pos.y;
    const seg = Math.hypot(dx, dy);
    if (remaining >= seg) {
      remaining -= seg;
      pos = { ...next };
      e.i++;
    } else {
      pos = { x: pos.x + (dx / seg) * remaining, y: pos.y + (dy / seg) * remaining };
      remaining = 0;
    }
  }
  e.pos = pos;
  return e.i >= e.waypoints.length - 1;
}

// ── 캐릭터 꾸미기: 세션 id 해시로 셔츠·피부·머리·액세서리를 고른다 ──
const SHIRTS = [0xe8590c, 0x1c7ed6, 0x2f9e44, 0xae3ec9, 0xd6336c, 0x0ca678, 0xf59f00, 0x5c7cfa, 0xe03131, 0x495057, 0x15aabf, 0x845ef7];
const SKINS = [0xf6d3b9, 0xeec1a0, 0xd9a07b, 0xb87a52, 0x8d5a3b];
const HAIRS = [0x2b2118, 0x5a3a1e, 0x8c5a2b, 0xd9b35c, 0xb4532a, 0x1f1f2e, 0xc0c0c8, 0xe599f7];
type HairStyle = "short" | "spiky" | "long" | "bob" | "bun" | "mohawk" | "bald";
const HAIR_STYLES: HairStyle[] = ["short", "spiky", "long", "bob", "bun", "mohawk", "bald"];
type Accessory = "none" | "cap" | "beanie" | "crown" | "bow" | "glasses" | "sunglasses" | "headset" | "flower" | "party";
const ACCESSORIES: Accessory[] = ["none", "cap", "beanie", "crown", "bow", "glasses", "sunglasses", "headset", "flower", "party"];
interface Look { shirt: number; skin: number; hair: number; style: HairStyle; accessory: Accessory; tie: boolean; cheeks: boolean }

const lookCache = new Map<string, Look>();
function lookFor(id: string): Look {
  const hit = lookCache.get(id);
  if (hit) return hit;
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const pick = <T,>(arr: T[], shift: number): T => arr[(h >>> shift) % arr.length];
  const look: Look = {
    shirt: pick(SHIRTS, 0), skin: pick(SKINS, 4), hair: pick(HAIRS, 8),
    style: pick(HAIR_STYLES, 12), accessory: pick(ACCESSORIES, 16),
    tie: ((h >>> 20) & 3) === 0, cheeks: ((h >>> 23) & 1) === 1,
  };
  lookCache.set(id, look);
  return look;
}

function drawCharacter(g: Graphics, L: Look, accent: number, loud: boolean): void {
  // 레트로 레고 미니피규어: 노란 원통 머리 + 꼭지, 점 눈·웃는 입, 사다리꼴 몸통, C자 손, 블록 다리
  const YELLOW = 0xffd23f, YDARK = 0xd9a400, INK = 0x1a1a1a;
  const legsC = 0x2b3a67; // 남색 바지
  // 다리·엉덩이
  g.roundRect(-14, -14, 28, 5, 1.5); g.fill({ color: legsC });
  g.roundRect(-14, -9, 13, 9, 1.5); g.roundRect(1, -9, 13, 9, 1.5); g.fill({ color: legsC });
  g.rect(-1, -9, 2, 9); g.fill({ color: 0x1b2647 });
  // 팔(몸통 양옆, 셔츠색) + C자 손
  g.poly([-13, -36, -19, -33, -21, -20, -16, -19, -13, -30]); g.fill({ color: L.shirt });
  g.poly([13, -36, 19, -33, 21, -20, 16, -19, 13, -30]); g.fill({ color: L.shirt });
  g.circle(-18.5, -16.5, 3.6); g.circle(18.5, -16.5, 3.6); g.fill({ color: YELLOW });
  g.circle(-18.5, -16.5, 1.4); g.circle(18.5, -16.5, 1.4); g.fill({ color: YDARK });
  // 몸통(사다리꼴) + 상태색 테두리
  g.poly([-12, -37, 12, -37, 15, -14, -15, -14]); g.fill({ color: L.shirt });
  g.poly([-12, -37, 12, -37, 15, -14, -15, -14]); g.stroke({ color: accent, width: loud ? 3 : 2, alpha: 0.95 });
  // 몸통 프린트
  if (L.tie) { g.poly([0, -36, -3, -33, 0, -22, 3, -33]); g.fill({ color: INK }); }
  else { g.rect(-4, -34, 8, 2); g.fill({ color: 0xffffff, alpha: 0.55 }); g.circle(0, -27, 2.4); g.fill({ color: 0xffffff, alpha: 0.5 }); }
  // 목
  g.rect(-4, -39, 8, 3); g.fill({ color: YDARK });
  // 머리(원통) + 꼭지
  g.roundRect(-10, -55, 20, 17, 4); g.fill({ color: YELLOW });
  g.rect(-10, -48, 3, 6); g.fill({ color: YDARK, alpha: 0.35 }); // 원통 음영
  const hasHat = L.accessory === "cap" || L.accessory === "beanie" || L.accessory === "crown" || L.accessory === "party";
  if (!hasHat && L.style === "bald") { g.roundRect(-5, -59, 10, 5, 1.5); g.fill({ color: YELLOW }); }
  // 머리카락(블록형 가발)
  if (!hasHat) {
    switch (L.style) {
      case "short": case "spiky": case "mohawk":
        g.roundRect(-11, -59, 22, 9, 4); g.fill({ color: L.hair });
        if (L.style === "spiky") { g.poly([-9, -59, -6, -64, -3, -59, 0, -65, 3, -59, 6, -64, 9, -59]); g.fill({ color: L.hair }); }
        if (L.style === "mohawk") { g.roundRect(-2, -66, 4, 8, 1.5); g.fill({ color: L.hair }); }
        break;
      case "long": case "bob":
        g.roundRect(-12, -59, 24, 9, 4); g.fill({ color: L.hair });
        g.roundRect(-12, -52, 4, L.style === "long" ? 18 : 11, 2); g.roundRect(8, -52, 4, L.style === "long" ? 18 : 11, 2); g.fill({ color: L.hair });
        break;
      case "bun":
        g.roundRect(-11, -59, 22, 8, 4); g.fill({ color: L.hair }); g.circle(0, -62, 4.5); g.fill({ color: L.hair });
        break;
      default: break;
    }
  }
  // 얼굴: 점 눈 + 웃는 입 (선글라스면 눈 대신 선글라스)
  if (L.accessory === "sunglasses") { g.roundRect(-8, -49, 16, 4, 1.5); g.fill({ color: INK }); }
  else { g.circle(-3.5, -47, 1.4); g.circle(3.5, -47, 1.4); g.fill({ color: INK }); }
  g.arc(0, -44.5, 3.4, 0.25, Math.PI - 0.25); g.stroke({ color: INK, width: 1.2 });
  if (L.cheeks) { g.circle(-6.5, -43.5, 1.6); g.circle(6.5, -43.5, 1.6); g.fill({ color: 0xff7a7a, alpha: 0.55 }); }
  // 액세서리
  switch (L.accessory) {
    case "cap": g.roundRect(-11, -60, 22, 8, 4); g.fill({ color: L.shirt }); g.roundRect(-2, -54, 16, 3, 1.5); g.fill({ color: L.shirt }); break;
    case "beanie": g.roundRect(-11, -61, 22, 10, 5); g.fill({ color: 0xc92a2a }); g.rect(-11, -54, 22, 3); g.fill({ color: 0xffffff }); g.circle(0, -62, 3); g.fill({ color: 0xffffff }); break;
    case "crown": g.poly([-9, -54, -9, -63, -4.5, -58, 0, -65, 4.5, -58, 9, -63, 9, -54]); g.fill({ color: 0xfcc419 }); g.stroke({ color: 0xe67700, width: 1 }); break;
    case "party": g.poly([-6, -55, 6, -55, 0, -69]); g.fill({ color: 0x7950f2 }); g.circle(0, -69, 2.4); g.fill({ color: 0xffd43b }); break;
    case "bow": g.poly([6, -58, 13, -62, 13, -54]); g.poly([6, -58, -1, -62, -1, -54]); g.fill({ color: 0xff6b9a }); g.circle(6, -58, 2); g.fill({ color: 0xd6336c }); break;
    case "glasses": g.circle(-3.5, -47, 3); g.circle(3.5, -47, 3); g.stroke({ color: INK, width: 1.1 }); break;
    case "flower": for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; g.circle(-8 + Math.cos(a) * 3, -57 + Math.sin(a) * 3, 2.2); } g.fill({ color: 0xffffff }); g.circle(-8, -57, 1.8); g.fill({ color: 0xffd43b }); break;
    default: break;
  }
}

function shortTask(s: string | null): string {
  if (!s) return "💻 작업 중";
  const t = s.replace(/\s+/g, " ").trim();
  return `💻 ${t.length > 14 ? t.slice(0, 13) + "…" : t}`;
}

// Body geometry (compact relative to the office BossSprite).
const BODY_W = 40;
const BODY_H = 58;
const HEAD_R = 13;
const HEAD_CY = -BODY_H + HEAD_R + 2;
const NAMEPLATE_Y = -BODY_H - 22;
const TODO_PROGRESS_Y = NAMEPLATE_Y + 9;

interface CommandCenterPeerProps {
  peer: CommandPeer;
  headsetTexture: Texture | null;
  sunglassesTexture: Texture | null;
  onActivate: (peer: CommandPeer, screen: { x: number; y: number }) => void;
  /** Animated position (used by the exit walk); defaults to the fixed slot. */
  positionOverride?: Position;
  /** Container alpha (used to fade exiting agents). */
  alphaOverride?: number;
}

function CommandCenterPeerComponent({
  peer,
  headsetTexture,
  sunglassesTexture,
  onActivate,
  positionOverride,
  alphaOverride,
}: CommandCenterPeerProps): ReactNode {
  const zone = ZONE_BY_KEY[peer.bucket];
  const accent = zone.color;
  const isNeedsYou = peer.bucket === "needs_you";
  // Walked position from the motion mover; exit animation overrides it.
  const motionPos = useMotionStore(selectMotionPos(peer.sessionId));
  const basePos = positionOverride ?? motionPos ?? peer.position;
  const alpha = alphaOverride ?? 1;

  // ── 살아 있는 느낌: 프레임마다 시간 진행 + 쉬는 세션의 심부름 ──
  const [now, setNow] = useState(0);
  const errand = useRef<Errand>({
    phase: "idle",
    nextAt: performance.now() + 4000 + Math.random() * 12000,
    waypoints: [],
    i: 0,
    pos: null,
    stayUntil: 0,
    text: "",
  });
  const canWander = peer.bucket === "done" && !positionOverride;
  useTick((ticker) => {
    const t = performance.now();
    const dt = Math.min(ticker.deltaMS / 1000, 0.05);
    const e = errand.current;
    if (!canWander) {
      if (e.phase !== "idle") Object.assign(e, { phase: "idle", pos: null });
    } else if (e.phase === "idle" && t > e.nextAt) {
      const pick = ERRANDS[Math.floor(Math.random() * ERRANDS.length)];
      const home = basePos;
      e.waypoints = [{ ...home }, { x: home.x, y: WALK_Y }, { x: pick.x, y: WALK_Y }];
      Object.assign(e, { phase: "go", i: 0, pos: { ...home }, text: pick.text });
    } else if (e.phase === "go" && walkAlong(e, dt)) {
      Object.assign(e, { phase: "stay", stayUntil: t + DWELL_MS });
    } else if (e.phase === "stay" && t > e.stayUntil) {
      e.waypoints = [...e.waypoints].reverse();
      e.waypoints[e.waypoints.length - 1] = { ...basePos };
      Object.assign(e, { phase: "back", i: 0 });
    } else if (e.phase === "back" && walkAlong(e, dt)) {
      Object.assign(e, { phase: "idle", pos: null, nextAt: t + 10000 + Math.random() * 20000 });
    }
    setNow(t);
  });
  const e = errand.current;
  const walking = e.phase === "go" || e.phase === "back";
  const pos = e.pos ?? basePos;
  // 몸 흔들림: 작업 중 = 타자(빠르고 잔잔), 대기 = 통통 튐, 걷기 = 걸음, 그 외 = 숨쉬기
  const bob =
    peer.bucket === "working"
      ? Math.sin(now / 70) * 1.6
      : isNeedsYou
        ? -Math.abs(Math.sin(now / 180)) * 9
        : walking
          ? -Math.abs(Math.sin(now / 90)) * 4
          : Math.sin(now / 700) * 1.2;
  // 말풍선 문구
  const bubble =
    e.phase === "stay"
      ? e.text
      : isNeedsYou
        ? "🙋 답 기다려요"
        : peer.bucket === "working"
          ? shortTask(peer.currentTask)
          : peer.bucket === "ended"
            ? "💤"
            : walking
              ? ""
              : "😌 휴식 중";
  const bubbleAlpha = isNeedsYou ? 0.65 + 0.35 * Math.abs(Math.sin(now / 300)) : 1;
  const bubbleW = Math.max(80, bubble.length * 30 + 40); // 2x 단위(0.5 배율 컨테이너)
  const drawSpeech = useCallback(
    (g: Graphics) => {
      g.clear();
      g.roundRect(-bubbleW / 2, -30, bubbleW, 56, 16);
      g.fill({ color: isNeedsYou ? 0xfbbf24 : 0xffffff, alpha: 0.96 });
      g.moveTo(-12, 26);
      g.lineTo(12, 26);
      g.lineTo(0, 42);
      g.closePath();
      g.fill({ color: isNeedsYou ? 0xfbbf24 : 0xffffff, alpha: 0.96 });
    },
    [bubbleW, isNeedsYou],
  );

  const drawShadow = useCallback(
    (g: Graphics) => {
      g.clear();
      // Status disc under the feet (stays grounded while the body bobs).
      g.ellipse(0, 4, BODY_W / 2 + 4, 7);
      g.fill({ color: accent, alpha: isNeedsYou ? 0.55 : 0.32 });
    },
    [accent, isNeedsYou],
  );

  // 세션마다 고정된 생김새(로컬 커스텀)
  const look = lookFor(peer.sessionId);
  const drawBody = useCallback(
    (g: Graphics) => {
      g.clear();
      drawCharacter(g, look, accent, isNeedsYou);
    },
    [look, accent, isNeedsYou],
  );

  const drawTodoBar = useCallback(
    (g: Graphics) => {
      g.clear();
      const w = 46;
      const h = 6;
      const ratio = peer.todoTotal > 0 ? peer.todoDone / peer.todoTotal : 0;
      g.roundRect(-w / 2, 0, w, h, 3);
      g.fill({ color: 0x0f172a });
      g.roundRect(-w / 2, 0, w, h, 3);
      g.stroke({ color: 0x334155, width: 1 });
      if (ratio > 0) {
        g.roundRect(-w / 2, 0, Math.max(3, w * ratio), h, 3);
        g.fill({ color: accent });
      }
    },
    [peer.todoDone, peer.todoTotal, accent],
  );

  const drawBadge = useCallback((g: Graphics) => {
    g.clear();
    g.roundRect(0, 0, 26, 16, 8);
    g.fill({ color: 0x111827 });
    g.roundRect(0, 0, 26, 16, 8);
    g.stroke({ color: 0xf59e0b, width: 1.5, alpha: 0.9 });
  }, []);

  // Office-style nameplate behind the project label.
  const shortLabel =
    peer.label.length > 16 ? `${peer.label.slice(0, 15)}…` : peer.label;
  const plateW = shortLabel.length * 12 + 22; // 2x units (container scaled 0.5)
  const drawPlate = useCallback(
    (g: Graphics) => {
      g.clear();
      g.roundRect(-plateW / 2, -15, plateW, 28, 7);
      g.fill({ color: 0x1e1e1e, alpha: 0.88 });
      g.roundRect(-plateW / 2, -15, plateW, 28, 7);
      g.stroke({ color: accent, width: 1.5, alpha: 0.65 });
    },
    [plateW, accent],
  );

  const handleTap = useCallback(
    (e: {
      client?: { x: number; y: number };
      global?: { x: number; y: number };
    }) => {
      // DOM client coords so the popover lands under the cursor.
      const p = e.client ?? e.global ?? { x: 0, y: 0 };
      onActivate(peer, { x: p.x, y: p.y });
    },
    [onActivate, peer],
  );

  return (
    <pixiContainer
      x={pos.x}
      y={pos.y}
      zIndex={pos.y}
      alpha={alpha}
      eventMode="static"
      cursor="pointer"
      onPointerTap={handleTap}
    >
      <pixiGraphics draw={drawShadow} />

      {/* 말풍선(작업 내용 · 대기 · 심부름) */}
      {bubble && (
        <pixiContainer y={NAMEPLATE_Y - 40 + bob - (peer.slotIndex % 2 ? 30 : 0)} scale={0.5} alpha={bubbleAlpha}>
          <pixiGraphics draw={drawSpeech} />
          <pixiText
            text={bubble}
            anchor={0.5}
            resolution={2}
            style={{ fontFamily: "Apple SD Gothic Neo, Pretendard, Noto Sans KR, sans-serif", fontSize: 30, fill: 0x111827, fontWeight: "bold" }}
          />
        </pixiContainer>
      )}

      <pixiContainer y={bob}>
        <pixiGraphics draw={drawBody} />

        {/* Sunglasses — 선글라스 액세서리인 캐릭터만 */}
        {sunglassesTexture && look.accessory === "sunglasses" && (
          <pixiSprite
            texture={sunglassesTexture}
            anchor={0.5}
            x={0}
            y={HEAD_CY + 1}
            scale={{ x: 0.03, y: 0.034 }}
            tint={0x000000}
          />
        )}

        {/* Headset — 헤드셋 액세서리인 캐릭터만 */}
        {headsetTexture && look.accessory === "headset" && (
          <pixiSprite
            texture={headsetTexture}
            anchor={0.5}
            x={0}
            y={HEAD_CY}
            scale={{ x: 0.56, y: 0.57 }}
          />
        )}
      </pixiContainer>

      {/* Project nameplate */}
      <pixiContainer y={NAMEPLATE_Y} scale={0.5}>
        <pixiGraphics draw={drawPlate} />
        <pixiText
          text={shortLabel}
          anchor={0.5}
          resolution={2}
          style={{
            fontFamily: "monospace",
            fontSize: 20,
            fill: 0xffffff,
            fontWeight: "bold",
          }}
        />
      </pixiContainer>

      {/* Subagent count badge */}
      {peer.subagentCount > 0 && (
        <pixiContainer x={BODY_W / 2 - 2} y={-BODY_H + 4}>
          <pixiGraphics draw={drawBadge} />
          <pixiContainer x={13} y={8} scale={0.5}>
            <pixiText
              text={`+${peer.subagentCount}`}
              anchor={0.5}
              resolution={2}
              style={{
                fontFamily: "monospace",
                fontSize: 18,
                fill: 0xf59e0b,
                fontWeight: "bold",
              }}
            />
          </pixiContainer>
        </pixiContainer>
      )}

      {/* Todo progress bar */}
      {peer.todoTotal > 0 && (
        <pixiContainer y={TODO_PROGRESS_Y}>
          <pixiContainer x={0} y={0} scale={0.5}>
            <pixiText
              text={`${peer.todoDone}/${peer.todoTotal}`}
              anchor={{ x: 0.5, y: 0 }}
              resolution={2}
              style={{
                fontFamily: "monospace",
                fontSize: 14,
                fill: 0x94a3b8,
              }}
            />
          </pixiContainer>
          <pixiContainer y={8}>
            <pixiGraphics draw={drawTodoBar} />
          </pixiContainer>
        </pixiContainer>
      )}
    </pixiContainer>
  );
}

export const CommandCenterPeer = memo(CommandCenterPeerComponent);
