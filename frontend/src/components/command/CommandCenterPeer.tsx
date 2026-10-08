"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTick } from "@pixi/react";
import { Assets, type Container, Graphics, Rectangle, type Sprite, Texture } from "pixi.js";
import type { Position } from "@/types";
import { useMotionStore, selectMotionPos } from "@/systems/commandCenterMotion";
import { ZONE_BY_KEY, TOP_WALL_H, EXIT_DOOR_X } from "./layout";
import type { Activity, CommandPeer } from "./useCommandCenterPeers";

// ── 휴식 칸 놀이(로컬 커스텀) ──
const ACT_LABEL: Record<Activity, string> = {
  run: "🏃 달리기", jump: "🤸 점프", pushup: "💪 팔굽혀펴기", ball: "🏀 드리블",
  dance: "🕺 춤", stretch: "🧘 스트레칭", sleep: "💤 낮잠",
};
const ACT_ICON: Record<Activity, string> = {
  run: "🏃", jump: "🤸", pushup: "💪", ball: "🏀", dance: "🕺", stretch: "🧘", sleep: "💤",
};

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

// ── 3D 복셀 캐릭터(크로시 로드 느낌): 상자마다 앞면 + 밝은 윗면 + 어두운 옆면 ──
const DEPTH = 7; // 윗면/옆면이 보이는 깊이(오른쪽 위 방향)
function lighten(c: number, k: number): number {
  const f = (v: number) => Math.min(255, Math.round(v + (255 - v) * k));
  return (f((c >> 16) & 255) << 16) | (f((c >> 8) & 255) << 8) | f(c & 255);
}
function box(g: Graphics, x: number, y: number, w: number, h: number, c: number, d = DEPTH): void {
  // 윗면
  g.poly([x, y, x + d, y - d, x + w + d, y - d, x + w, y]); g.fill({ color: lighten(c, 0.28) });
  // 옆면(오른쪽)
  g.poly([x + w, y, x + w + d, y - d, x + w + d, y + h - d, x + w, y + h]); g.fill({ color: shade(c, 0.68) });
  // 앞면 + 아래쪽 살짝 그늘
  g.rect(x, y, w, h); g.fill({ color: c });
  g.rect(x, y + h - 2, w, 2); g.fill({ color: shade(c, 0.85) });
  // 외곽선(얇게)
  g.poly([x, y, x + d, y - d, x + w + d, y - d, x + w + d, y + h - d, x + w, y + h, x, y + h]);
  g.stroke({ color: 0x15161c, width: 1, alpha: 0.55 });
}

function drawCharacter(g: Graphics, L: Look, accent: number, loud: boolean, frame = 0): void {
  const ox = -DEPTH / 2; // 깊이만큼 왼쪽으로 당겨 가운데 맞춤
  const pants = 0x3b4a7a, shoe = 0x2a2230, ink = 0x15161c;
  const legA = frame === 1 ? -3 : 0, legB = frame === 2 ? -3 : 0;  // 걸음
  const armA = frame === 1 ? -3 : 0, armB = frame === 2 ? -3 : 0;  // 타자
  // 다리(뒤 → 앞 순서로)
  box(g, ox - 10, -13 + legA, 9, 13 - legA, pants, 5);
  box(g, ox + 1, -13 + legB, 9, 13 - legB, pants, 5);
  box(g, ox - 10, -4 + legA, 9, 4, shoe, 5);
  box(g, ox + 1, -4 + legB, 9, 4, shoe, 5);
  // 긴 머리(뒤쪽)
  if (L.style === "long") { box(g, ox - 14, -54, 28, 26, L.hair, 6); }
  // 몸통
  box(g, ox - 12, -33, 24, 21, L.shirt);
  g.poly([ox - 5, -33, ox + 5, -33, ox, -27]); g.fill({ color: 0xfff1e8 }); // 칼라
  if (L.tie) { g.poly([ox, -29, ox - 2.5, -26, ox, -16, ox + 2.5, -26]); g.fill({ color: ink }); }
  else { g.rect(ox - 8, -24, 16, 2); g.fill({ color: lighten(L.shirt, 0.35) }); }
  // 팔 + 손
  box(g, ox - 18, -32 + armA, 6, 15, L.shirt, 5); box(g, ox - 18, -18 + armA, 6, 5, L.skin, 5);
  box(g, ox + 12, -32 + armB, 6, 15, L.shirt, 5); box(g, ox + 12, -18 + armB, 6, 5, L.skin, 5);
  // 머리(큰 정육면체)
  box(g, ox - 12, -57, 24, 22, L.skin, 9);
  // 머리카락
  switch (L.style) {
    case "short": case "long": box(g, ox - 13, -62, 26, 8, L.hair, 9); box(g, ox - 13, -55, 4, 6, L.hair, 3); break;
    case "side": box(g, ox - 13, -62, 26, 8, L.hair, 9); box(g, ox - 13, -55, 11, 5, L.hair, 3); break;
    case "spiky": box(g, ox - 13, -61, 26, 6, L.hair, 9); for (const dx of [-11, -4, 3]) box(g, ox + dx, -67, 6, 6, L.hair, 6); break;
    case "bun": box(g, ox - 13, -61, 26, 7, L.hair, 9); box(g, ox - 5, -71, 10, 9, L.hair, 7); break;
    case "bald": break;
  }
  // 얼굴(앞면에)
  const fy = -47;
  if (L.accessory === "sunglasses") { g.rect(ox - 10, fy - 2, 20, 6); g.fill({ color: ink }); g.rect(ox - 8, fy - 1, 5, 2); g.fill({ color: 0x5f6b7a }); }
  else {
    g.rect(ox - 7, fy - 1, 3, 5); g.rect(ox + 4, fy - 1, 3, 5); g.fill({ color: ink });
    g.rect(ox - 6, fy - 1, 1, 1); g.rect(ox + 5, fy - 1, 1, 1); g.fill({ color: 0xffffff });
  }
  g.rect(ox - 3, fy + 7, 6, 2); g.fill({ color: 0x8a3b3b });
  if (L.cheeks) { g.rect(ox - 10, fy + 5, 4, 2); g.rect(ox + 6, fy + 5, 4, 2); g.fill({ color: 0xff8fa3, alpha: 0.75 }); }
  // 소품
  switch (L.accessory) {
    case "cap": box(g, ox - 13, -64, 26, 9, L.shirt, 9); box(g, ox - 4, -57, 18, 3, shade(L.shirt, 0.85), 4); break;
    case "beanie": box(g, ox - 13, -66, 26, 12, 0xd62f3a, 9); box(g, ox - 13, -57, 26, 3, 0xfff1e8, 9); box(g, ox - 3, -72, 6, 5, 0xfff1e8, 5); break;
    case "crown": box(g, ox - 10, -66, 20, 5, 0xffd23f, 7); for (const dx of [-10, -2, 6]) box(g, ox + dx, -71, 4, 5, 0xffd23f, 4); break;
    case "glasses": g.rect(ox - 9, fy - 3, 7, 8); g.rect(ox + 2, fy - 3, 7, 8); g.stroke({ color: ink, width: 1.5 }); g.rect(ox - 2, fy, 4, 1.5); g.fill({ color: ink }); break;
    case "bow": box(g, ox + 7, -66, 9, 6, 0xff77a8, 5); box(g, ox + 10, -65, 3, 4, 0xd6336c, 3); break;
    case "headphones": box(g, ox - 16, -52, 5, 10, 0x2b2b3a, 4); box(g, ox + 12, -52, 5, 10, 0x2b2b3a, 4); box(g, ox - 14, -66, 28, 3, 0x2b2b3a, 9); break;
    default: break;
  }
  // 대기 중이면 상태색 테두리로 강조
  if (loud) { g.roundRect(ox - 22, -76, 46 + DEPTH, 80, 10); g.stroke({ color: accent, width: 2.5, alpha: 0.9 }); }
}


// ── Pixel Agents 캐릭터(MIT, pixel-agents-hq/pixel-agents · 원화 JIK-A-4 Metro City) ──
// char_N.png = 16×32 프레임 7열 × 3행(정면·뒷면·옆면). 정면 0~2 걷기, 3 대기, 4 손들기, 5~6 타자.
const PA_SHEETS = 6;
const paFrames = new Map<number, Texture[]>();
const paLoading = new Map<number, Promise<Texture[]>>();
function loadPaFrames(n: number): Promise<Texture[]> {
  const hit = paLoading.get(n);
  if (hit) return hit;
  const pr = Assets.load<Texture>(`/sprites/pixel-agents/char_${n}.png`).then((tex) => {
    tex.source.scaleMode = "nearest";
    const frames: Texture[] = [];
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 7; col++)
        frames.push(new Texture({ source: tex.source, frame: new Rectangle(col * 16, row * 32, 16, 32) }));
    paFrames.set(n, frames);
    return frames;
  });
  paLoading.set(n, pr);
  pr.catch(() => paLoading.delete(n)); // 실패는 캐시하지 않음(다음에 다시 시도)
  return pr;
}
function sheetFor(id: string): number {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h % PA_SHEETS;
}

// 말풍선 줄바꿈: 한 줄 14자, 최대 3줄
function wrap3(text: string, per = 12, max = 3): string[] {
  const t = Array.from(text.replace(/\s+/g, " ").trim()); // 코드포인트 단위(이모지 서로게이트 안 자르게)
  const lines: string[] = [];
  for (let i = 0; i < t.length && lines.length < max; i += per) lines.push(t.slice(i, i + per).join(""));
  if (t.length > per * max) lines[max - 1] = Array.from(lines[max - 1]).slice(0, per - 1).join("") + "…";
  return lines;
}

// 마지막 질문 — 태그·[Image #N]·[Pasted text] 같은 첨부 표시는 빼고
function cleanTask(s: string | null): string {
  if (!s) return "";
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/\[(Image|Pasted text)[^\]]*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shortTask(s: string | null): string {
  return `▶ ${cleanTask(s) || "작업 중"}`;
}

// Body geometry (compact relative to the office BossSprite).
const BODY_W = 40;
const BODY_H = 58;
const NAMEPLATE_Y = -BODY_H - 58;
const TODO_PROGRESS_Y = NAMEPLATE_Y + 9;
const BUBBLE_Y = NAMEPLATE_Y - 22;
// 렌더마다 새 객체를 만들지 않게(텍스트 스타일 재적용 방지)
const BUBBLE_ANCHOR = { x: 0.5, y: 1 };
const SPRITE_ANCHOR = { x: 0.5, y: 1 };
const BUBBLE_STYLE = { fontFamily: "Galmuri11, Galmuri9, Apple SD Gothic Neo, sans-serif", fontSize: 26, lineHeight: 32, fill: 0x1a1c2c, align: "center" as const };
const NAME_STYLE = { fontFamily: "monospace", fontSize: 20, fill: 0xffffff, fontWeight: "bold" as const };

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

  // ── 살아 있는 느낌(로컬 커스텀) ──
  // 성능: 매 프레임 바뀌는 값(흔들림·깜빡임·걷는 위치·스프라이트 프레임)은 pixi 객체에 직접 넣고,
  // React 는 말풍선 문구/심부름 단계가 바뀔 때만 다시 그린다(피어마다 60fps 재렌더 방지).
  // 화면에 필요한 심부름 상태(단계·문구)만 state 로 — 나머지 진행 상황은 ref
  const [view, setView] = useState<{ phase: ErrandPhase; text: string }>({ phase: "idle", text: "" });
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) return;
    document.fonts.load('26px "Galmuri11"').then(() => setFontReady(true)).catch(() => {});
  }, []);
  const errand = useRef<Errand | null>(null);
  useEffect(() => {
    // 첫 심부름은 4~16초 뒤(렌더 중에 시간·난수를 쓰지 않도록 마운트 때 초기화)
    errand.current = {
      phase: "idle", nextAt: performance.now() + 4000 + Math.random() * 12000,
      waypoints: [], i: 0, pos: null, stayUntil: 0, text: "",
    };
  }, []);
  const rootRef = useRef<Container | null>(null);
  const bodyRef = useRef<Container | null>(null);
  const bubbleRef = useRef<Container | null>(null);
  const spriteRef = useRef<Sprite | null>(null);
  const canWander = peer.bucket === "done" && !positionOverride;
  // tick 이 읽는 최신 값(콜백은 한 번만 등록)
  const live = useRef({
    bucket: peer.bucket, basePos, canWander, frames: null as Texture[] | null,
    activity: peer.activity, phase: 0,
  });
  useLayoutEffect(() => {
    live.current.bucket = peer.bucket;
    live.current.basePos = basePos;
    live.current.canWander = canWander;
    live.current.activity = peer.activity;
  });
  useEffect(() => {
    live.current.phase = Math.random() * 10; // 같은 놀이라도 박자가 다르게
  }, []);
  const ballRef = useRef<Graphics | null>(null);

  const tick = useCallback((ticker: { deltaMS: number }) => {
    const t = performance.now();
    const dt = Math.min(ticker.deltaMS / 1000, 0.05);
    const L = live.current;
    const e = errand.current;
    if (!e) return;
    const before = e.phase;
    if (!L.canWander) {
      if (e.phase !== "idle") Object.assign(e, { phase: "idle", pos: null });
    } else if (e.phase === "idle" && t > e.nextAt) {
      const pick = ERRANDS[Math.floor(Math.random() * ERRANDS.length)];
      const home = L.basePos;
      e.waypoints = [{ ...home }, { x: home.x, y: WALK_Y }, { x: pick.x, y: WALK_Y }];
      Object.assign(e, { phase: "go", i: 0, pos: { ...home }, text: pick.text });
    } else if (e.phase === "go" && walkAlong(e, dt)) {
      Object.assign(e, { phase: "stay", stayUntil: t + DWELL_MS });
    } else if (e.phase === "stay" && t > e.stayUntil) {
      e.waypoints = [...e.waypoints].reverse();
      e.waypoints[e.waypoints.length - 1] = { ...L.basePos };
      Object.assign(e, { phase: "back", i: 0 });
    } else if (e.phase === "back" && walkAlong(e, dt)) {
      Object.assign(e, { phase: "idle", pos: null, nextAt: t + 10000 + Math.random() * 20000 });
    }
    if (e.phase !== before) setView({ phase: e.phase, text: e.text }); // 말풍선 문구가 바뀌는 순간만 재렌더

    const walkingNow = e.phase === "go" || e.phase === "back";
    // 몸 흔들림: 작업 중 = 타자(빠르고 잔잔), 대기 = 통통 튐, 걷기 = 걸음, 그 외 = 숨쉬기
    let bobNow =
      L.bucket === "working"
        ? Math.sin(t / 70) * 1.6
        : L.bucket === "needs_you"
          ? -Math.abs(Math.sin(t / 180)) * 9
          : walkingNow
            ? -Math.abs(Math.sin(t / 90)) * 4
            : Math.sin(t / 700) * 1.2;
    // 정면 행: 걷기 0-1-2-1, 작업 중 타자 5-6, 대기 4(손들기), 그 외 0 · 옆면 행은 14~
    let col = walkingNow
      ? [0, 1, 2, 1][Math.floor(t / 140) % 4]
      : L.bucket === "working"
        ? 5 + (Math.floor(t / 260) % 2)
        : L.bucket === "needs_you"
          ? 4
          : 0;
    let ox = 0, oy = 0, rot = 0, flip = 1, lying = false, ballY: number | null = null;
    if (L.bucket === "ended") {
      const ph = L.phase;
      switch (L.activity) {
        case "run": {
          const a = t / 900 + ph;
          ox = Math.cos(a) * 46; oy = Math.sin(a) * 34;
          flip = Math.sin(a) > 0 ? -1 : 1;
          col = 14 + [0, 1, 2, 1][Math.floor(t / 90) % 4];
          bobNow = -Math.abs(Math.sin(t / 90)) * 5;
          break;
        }
        case "jump": {
          const s = Math.abs(Math.sin(t / 230 + ph));
          bobNow = -s * 24; col = s > 0.35 ? 4 : 0;
          break;
        }
        case "pushup":
          lying = true; rot = -Math.PI / 2; bobNow = -Math.abs(Math.sin(t / 320 + ph)) * 7;
          break;
        case "ball": {
          const s = Math.abs(Math.sin(t / 190 + ph));
          ballY = -6 - (1 - s) * 34; bobNow = -s * 2; col = 4;
          break;
        }
        case "dance": {
          const beat = Math.floor((t + ph * 1000) / 360);
          bobNow = -Math.abs(Math.sin(t / 180)) * 9; flip = beat % 2 ? -1 : 1;
          col = beat % 4 < 2 ? 4 : 14 + (beat % 3);
          break;
        }
        case "stretch":
          rot = Math.sin(t / 650 + ph) * 0.38; col = 4; bobNow = 0;
          break;
        case "sleep":
          lying = true; rot = -Math.PI / 2; bobNow = Math.sin(t / 900) * 1.5;
          break;
      }
    }
    if (bodyRef.current) {
      bodyRef.current.y = bobNow;
      bodyRef.current.x = lying ? 46 : 0;
      bodyRef.current.rotation = rot;
    }
    if (ballRef.current) {
      ballRef.current.visible = ballY !== null;
      if (ballY !== null) ballRef.current.y = ballY;
    }
    if (bubbleRef.current) {
      bubbleRef.current.y = BUBBLE_Y + (lying ? 30 : Math.min(bobNow, 0) * 0.4);
      bubbleRef.current.alpha = L.bucket === "needs_you" ? 0.65 + 0.35 * Math.abs(Math.sin(t / 300)) : 1;
    }
    const base = e.pos ?? L.basePos;
    const p = { x: base.x + ox, y: base.y + oy };
    if (rootRef.current && (rootRef.current.x !== p.x || rootRef.current.y !== p.y)) {
      rootRef.current.x = p.x;
      rootRef.current.y = p.y;
      rootRef.current.zIndex = p.y;
    }
    const frames = L.frames;
    if (frames && spriteRef.current) {
      if (spriteRef.current.texture !== frames[col]) spriteRef.current.texture = frames[col];
      const sx = 3.6 * flip;
      if (spriteRef.current.scale.x !== sx) spriteRef.current.scale.x = sx;
    }
  }, []);
  useTick(tick);

  const walking = view.phase === "go" || view.phase === "back";
  const pos = basePos; // 걷는 동안의 위치는 tick 에서 직접 옮긴다
  // 말풍선 문구
  // (로컬 커스텀) 말풍선은 항상 마지막 질문 — 쉬는 중·심부름 중에도
  const lastAsk = cleanTask(peer.currentTask);
  const bubble = isNeedsYou
    ? "❓ 확인 필요"
    : peer.bucket === "working"
      ? shortTask(peer.currentTask)
      : peer.bucket === "ended"
        ? lastAsk
          ? `✓ ${lastAsk}`
          : ACT_LABEL[peer.activity]
        : lastAsk
          ? `✓ ${lastAsk}`
          : view.phase === "stay"
            ? view.text
            : walking
              ? ""
              : "😌 휴식 중";
  const lines = bubble ? wrap3(bubble) : [];
  const maxLen = lines.reduce((m, l) => Math.max(m, Array.from(l).length), 0);
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
  const sheet = sheetFor(peer.sessionId);
  const [paState, setPaState] = useState<{ sheet: number; frames: Texture[] } | null>(() => {
    const f = paFrames.get(sheet);
    return f ? { sheet, frames: f } : null;
  });
  const paTex = paState && paState.sheet === sheet ? paState.frames : null;
  useLayoutEffect(() => {
    live.current.frames = paTex;
  }, [paTex]);
  useEffect(() => {
    if (paTex) return;
    let alive = true;
    loadPaFrames(sheet).then((f) => alive && setPaState({ sheet, frames: f })).catch(() => {});
    return () => { alive = false; };
  }, [sheet, paTex]);
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
  const baseLabel =
    peer.label.length > 16 ? `${peer.label.slice(0, 15)}…` : peer.label;
  const shortLabel = peer.bucket === "ended" ? `${ACT_ICON[peer.activity]} ${baseLabel}` : baseLabel;
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

  const drawBall = useCallback((g: Graphics) => {
    g.clear();
    g.circle(0, 0, 7);
    g.fill({ color: 0xf97316 });
    g.circle(0, 0, 7);
    g.stroke({ color: 0x7c2d12, width: 1.5 });
    g.moveTo(-7, 0).lineTo(7, 0);
    g.stroke({ color: 0x7c2d12, width: 1 });
  }, []);

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

  const paTexture = paTex ? paTex[0] : null; // 실제 프레임은 tick 에서 바꾼다

  return (
    <pixiContainer
      ref={rootRef}
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
        <pixiContainer ref={bubbleRef} y={BUBBLE_Y} scale={0.8}>
          <pixiGraphics draw={drawSpeech} />
          <pixiText
            key={fontReady ? "f1" : "f0"}
            text={lines.join("\n")}
            anchor={BUBBLE_ANCHOR}
            y={-14}
            resolution={2}
            style={BUBBLE_STYLE}
          />
        </pixiContainer>
      )}

      <pixiContainer ref={bodyRef}>
        {paTexture ? (
          <pixiSprite ref={spriteRef} texture={paTexture} anchor={SPRITE_ANCHOR} y={6} scale={3.6} roundPixels />
        ) : (
          <pixiGraphics draw={drawBody} />
        )}
      </pixiContainer>

      {/* 드리블 공(휴식 칸) */}
      <pixiGraphics
        ref={ballRef}
        x={24}
        visible={false}
        draw={drawBall}
      />

      {/* Project nameplate */}
      <pixiContainer y={NAMEPLATE_Y} scale={0.75}>
        <pixiGraphics draw={drawPlate} />
        <pixiText
          text={shortLabel}
          anchor={0.5}
          resolution={2}
          style={NAME_STYLE}
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
