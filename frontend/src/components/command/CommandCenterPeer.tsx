"use client";

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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

// ── 캐릭터 꾸미기: 16비트 레트로 픽셀 스프라이트(14×20 도트, 1도트 = 3px) ──
// 세션 id 해시로 셔츠·피부·머리 모양·머리색·소품이 정해진다(같은 세션은 늘 같은 모습). 팔레트는 PICO-8 계열.
const PX = 3;
const SHIRTS = [0xff004d, 0x29adff, 0x00e436, 0xffa300, 0x7e2553, 0x83769c, 0xff77a8, 0x008751, 0xab5236, 0x1d2b53, 0x5fcde4, 0xd95763];
const SKINS = [0xffccaa, 0xf2b48c, 0xd99a6c, 0xab7650, 0x7a4b2e];
const HAIRS = [0x2b1d14, 0x5f3a1e, 0xab5236, 0xffd166, 0x1d1d2b, 0xff77a8, 0xc2c3c7, 0x4b7bd6];
type HairStyle = "short" | "long" | "spiky" | "bun" | "bald" | "side";
const HAIR_STYLES: HairStyle[] = ["short", "long", "spiky", "bun", "bald", "side"];
type Accessory = "none" | "cap" | "beanie" | "crown" | "glasses" | "sunglasses" | "bow" | "headphones";
const ACCESSORIES: Accessory[] = ["none", "none", "cap", "beanie", "crown", "glasses", "sunglasses", "bow", "headphones"];
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

function shade(c: number, k: number): number {
  const r = Math.round(((c >> 16) & 255) * k), g = Math.round(((c >> 8) & 255) * k), b = Math.round((c & 255) * k);
  return (Math.min(255, r) << 16) | (Math.min(255, g) << 8) | Math.min(255, b);
}

// 기본 몸(앞모습). o 외곽선 · h 머리 · s 피부 · S 피부그늘 · e 눈 · m 입 · c 셔츠 · C 셔츠그늘 · w 칼라 · k 벨트 · p 바지 · b 신발
const BASE = [
  "....oooooo....",
  "...ohhhhhho...",
  "..ohhhhhhhho..",
  "..ohhhhhhhho..",
  "..ohhssssshho.",
  "..osesssseso..",
  "..ossssssssо..".replace("о", "o"),
  "..osssmmssso..",
  "...oSSSSSSo...",
  "....oCwwCo....",
  ".occcccccccco.",
  ".occcccccccco.",
  "oscccccccccCso",
  ".oCCCCCCCCCCo.",
  "..okkkkkkkko..",
  "..oppppppppo..",
  "..opppoopppo..",
  "..opppoopppo..",
  "..obbboobbbo..",
  "..oooo..oooo..",
].map((r) => r.padEnd(14, ".").slice(0, 14).split(""));

function spriteFor(L: Look, frame: number): { grid: string[][]; extra: Array<[number, number, string]> } {
  const g = BASE.map((r) => r.slice());
  const extra: Array<[number, number, string]> = []; // 머리 위(음수 행) 도트
  const set = (r: number, c: number, v: string) => { if (r >= 0 && r < g.length && c >= 0 && c < 14) g[r][c] = v; else extra.push([r, c, v]); };
  // 머리 모양
  if (L.style === "bald") { for (let c = 3; c <= 10; c++) for (const r of [1, 2, 3]) if (g[r][c] === "h") set(r, c, r === 1 ? "h" : "s"); set(4, 3, "s"); set(4, 4, "s"); set(4, 9, "s"); set(4, 10, "s"); }
  if (L.style === "long") { for (let r = 4; r <= 10; r++) { set(r, 2, "h"); set(r, 11, "h"); set(r, 1, "o"); set(r, 12, "o"); } }
  if (L.style === "side") { for (let r = 4; r <= 6; r++) set(r, 3, "h"); set(3, 4, "h"); }
  if (L.style === "spiky") { set(-1, 4, "o"); set(-1, 6, "o"); set(-1, 8, "o"); set(0, 4, "h"); set(0, 6, "h"); set(0, 8, "h"); set(-2, 4, "o"); set(-2, 6, "o"); set(-2, 8, "o"); }
  if (L.style === "bun") { for (let c = 5; c <= 8; c++) { set(-1, c, "h"); set(-2, c, "o"); } set(-1, 4, "o"); set(-1, 9, "o"); }
  // 소품
  if (L.accessory === "cap") { for (let r = 0; r <= 3; r++) for (let c = 2; c <= 11; c++) if ("hs".includes(g[r][c])) set(r, c, "c"); for (let c = 3; c <= 13; c++) set(4, c, c >= 11 ? "C" : g[4][c] === "o" ? "o" : "C"); }
  if (L.accessory === "beanie") { for (let r = 0; r <= 3; r++) for (let c = 2; c <= 11; c++) if ("hs".includes(g[r][c])) set(r, c, r === 3 ? "w" : "R"); set(-1, 6, "w"); set(-1, 7, "w"); }
  if (L.accessory === "crown") { for (const c of [4, 6, 7, 9]) set(-1, c, "Y"); for (let c = 4; c <= 9; c++) set(0, c, "Y"); }
  if (L.accessory === "glasses") { set(5, 3, "o"); set(5, 5, "o"); set(5, 8, "o"); set(5, 10, "o"); set(5, 6, "o"); set(5, 7, "o"); }
  if (L.accessory === "sunglasses") { for (let c = 3; c <= 10; c++) set(5, c, "K"); }
  if (L.accessory === "bow") { set(1, 10, "P"); set(1, 12, "P"); set(0, 11, "P"); set(2, 11, "P"); set(1, 11, "Q"); }
  if (L.accessory === "headphones") { for (let r = 3; r <= 6; r++) { set(r, 1, "K"); set(r, 12, "K"); } for (let c = 3; c <= 10; c++) set(-1, c, "K"); set(0, 2, "K"); set(0, 11, "K"); }
  if (L.tie) { set(10, 6, "k"); set(10, 7, "k"); set(11, 6, "k"); set(11, 7, "k"); set(12, 6, "k"); }
  if (L.cheeks) { set(6, 3, "r"); set(6, 10, "r"); }
  // 걷기·타자 프레임: 다리/손을 번갈아
  if (frame === 1) { g[18][3] = "o"; g[18][4] = "b"; g[19][3] = "."; g[19][4] = "o"; g[12][1] = "c"; g[11][1] = "s"; }
  if (frame === 2) { g[18][9] = "o"; g[18][10] = "b"; g[19][10] = "."; g[19][9] = "o"; g[12][12] = "c"; g[11][12] = "s"; }
  return { grid: g, extra };
}

function drawCharacter(g: Graphics, L: Look, accent: number, loud: boolean, frame = 0): void {
  const OUT = 0x1a1c2c;
  const pal: Record<string, number> = {
    o: OUT, h: L.hair, s: L.skin, S: shade(L.skin, 0.82), e: OUT, m: 0x7e2553,
    c: L.shirt, C: shade(L.shirt, 0.72), w: 0xfff1e8, k: 0x2b2b3a, p: 0x3b4a7a, b: 0x2a1d1d,
    R: 0xd62f3a, Y: 0xffd23f, K: 0x111111, P: 0xff77a8, Q: 0xd6336c, r: 0xff8fa3,
  };
  const { grid, extra } = spriteFor(L, frame);
  const x0 = -7 * PX, y0 = -20 * PX;
  // 상태 테두리(발밑 그림자는 drawShadow에서): 작업 상태색으로 1도트 바깥 후광
  for (let r = 0; r < grid.length; r++) for (let c = 0; c < 14; c++) {
    const v = grid[r][c];
    if (v === ".") continue;
    g.rect(x0 + c * PX, y0 + r * PX, PX, PX); g.fill({ color: pal[v] ?? OUT });
  }
  for (const [r, c, v] of extra) { g.rect(x0 + c * PX, y0 + r * PX, PX, PX); g.fill({ color: pal[v] ?? OUT }); }
  if (loud) { g.rect(x0 - PX, y0 - PX * 3, PX * 16, PX * 24); g.stroke({ color: accent, width: 2, alpha: 0.9 }); }
}

// 말풍선 줄바꿈: 한 줄 14자, 최대 3줄
function wrap3(text: string, per = 14, max = 3): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  const lines: string[] = [];
  for (let i = 0; i < t.length && lines.length < max; i += per) lines.push(t.slice(i, i + per));
  if (t.length > per * max) lines[max - 1] = lines[max - 1].slice(0, per - 1) + "…";
  return lines;
}

function shortTask(s: string | null): string {
  if (!s) return "💻 작업 중";
  return `▶ ${s.replace(/\s+/g, " ").trim()}`;
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
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) return;
    document.fonts.load('26px "Galmuri11"').then(() => setFontReady(true)).catch(() => {});
  }, []);
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
  const lines = bubble ? wrap3(bubble) : [];
  const maxLen = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const bubbleW = Math.max(90, maxLen * 26 + 36); // 2x 단위(0.5 배율 컨테이너)
  const bubbleH = lines.length * 32 + 22;
  const drawSpeech = useCallback(
    (g: Graphics) => {
      g.clear();
      const fill = isNeedsYou ? 0xffd23f : 0xfff1e8, ink = 0x1a1c2c, s4 = 4;
      const x = -bubbleW / 2, y = -bubbleH;
      // 도트 박스: 모서리 1칸 깎기 + 두꺼운 외곽선 + 아래 그림자
      g.rect(x + s4, y + s4 * 2, bubbleW, bubbleH); g.fill({ color: ink, alpha: 0.35 });
      g.rect(x + s4, y, bubbleW - s4 * 2, bubbleH); g.rect(x, y + s4, bubbleW, bubbleH - s4 * 2); g.fill({ color: ink });
      g.rect(x + s4 * 2, y + s4, bubbleW - s4 * 4, bubbleH - s4 * 2); g.rect(x + s4, y + s4 * 2, bubbleW - s4 * 2, bubbleH - s4 * 4); g.fill({ color: fill });
      // 꼬리(계단)
      for (let i = 0; i < 3; i++) { g.rect(-s4 * (3 - i), y + bubbleH - s4 + i * s4, s4 * (6 - i * 2), s4); g.fill({ color: ink }); }
      for (let i = 0; i < 2; i++) { g.rect(-s4 * (2 - i), y + bubbleH - s4 * 2 + i * s4, s4 * (4 - i * 2), s4); g.fill({ color: fill }); }
    },
    [bubbleW, bubbleH, isNeedsYou],
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

      {/* 말풍선(작업 내용 · 대기 · 심부름) — 레트로 도트 박스, 최대 3줄 */}
      {lines.length > 0 && (
        <pixiContainer y={NAMEPLATE_Y - 14 + bob - (peer.slotIndex % 2 ? 40 : 0)} scale={0.5} alpha={bubbleAlpha}>
          <pixiGraphics draw={drawSpeech} />
          <pixiText
            key={fontReady ? "f1" : "f0"}
            text={lines.join("\n")}
            anchor={{ x: 0.5, y: 1 }}
            y={-14}
            resolution={2}
            style={{ fontFamily: "Galmuri11, Galmuri9, Apple SD Gothic Neo, sans-serif", fontSize: 26, lineHeight: 32, fill: 0x1a1c2c, align: "center" }}
          />
        </pixiContainer>
      )}

      <pixiContainer y={bob}>
        <pixiGraphics draw={drawBody} />
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
