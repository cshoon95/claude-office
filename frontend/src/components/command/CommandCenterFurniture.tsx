"use client";

import { memo, useCallback, type ReactNode } from "react";
import { Graphics, type Texture } from "pixi.js";
import type { OfficeTextures } from "@/hooks/useOfficeTextures";
import { useExitStore, selectDoorOpen } from "@/systems/exitAnimation";
import {
  ZONES,
  DESK_SLOTS,
  EXIT_DOOR_BASE_Y,
  EXIT_DOOR_X,
  slotPosition,
  type ZoneDef,
} from "./layout";

// ============================================================================
// DESK WORKSTATION (Needs-you / Working) — composed from real office sprites.
// ============================================================================

type DeskItem =
  "mug" | "lamp" | "penholder" | "8ball" | "rubiks" | "duck" | "thermos";
const ITEM_SEQUENCE: DeskItem[] = [
  "lamp",
  "mug",
  "8ball",
  "rubiks",
  "penholder",
  "duck",
  "thermos",
  "lamp",
];

function accessory(
  t: OfficeTextures,
  item: DeskItem,
): { tex: Texture | null; scale: number; y: number } {
  switch (item) {
    case "mug":
      return { tex: t.coffeeMug, scale: 0.016, y: 26 };
    case "lamp":
      return { tex: t.deskLamp, scale: 0.23, y: 22 };
    case "penholder":
      return { tex: t.penHolder, scale: 0.14, y: 24 };
    case "8ball":
      return { tex: t.magic8Ball, scale: 0.1, y: 26 };
    case "rubiks":
      return { tex: t.rubiksCube, scale: 0.1, y: 26 };
    case "duck":
      return { tex: t.rubberDuck, scale: 0.1, y: 26 };
    case "thermos":
      return { tex: t.thermos, scale: 0.24, y: 24 };
  }
}

function DeskComponent({
  x,
  y,
  slot,
  textures: t,
}: {
  x: number;
  y: number;
  slot: number;
  textures: OfficeTextures;
}): ReactNode {
  const acc = accessory(t, ITEM_SEQUENCE[slot % ITEM_SEQUENCE.length]);
  return (
    <pixiContainer x={x} y={y} zIndex={y - 2}>
      {t.chair && (
        <pixiSprite
          texture={t.chair}
          anchor={{ x: 0.5, y: 1 }}
          x={0}
          y={8}
          scale={0.088}
        />
      )}
      {t.desk && (
        <pixiSprite
          texture={t.desk}
          anchor={{ x: 0.5, y: 0 }}
          x={0}
          y={10}
          scale={0.066}
        />
      )}
      {t.keyboard && (
        <pixiSprite
          texture={t.keyboard}
          anchor={0.5}
          x={0}
          y={24}
          scale={0.026}
        />
      )}
      {t.monitor && (
        <pixiSprite
          texture={t.monitor}
          anchor={{ x: 0.5, y: 1 }}
          x={-30}
          y={20}
          scale={0.052}
        />
      )}
      {acc.tex && (
        <pixiSprite
          texture={acc.tex}
          anchor={{ x: 0.5, y: 1 }}
          x={32}
          y={acc.y}
          scale={acc.scale}
        />
      )}
    </pixiContainer>
  );
}
const Desk = memo(DeskComponent);

// ============================================================================
// LOUNGE COUCH (Done) — drawn; the lounge has no work desks.
// ============================================================================

function CouchComponent({ x, y }: { x: number; y: number }): ReactNode {
  const draw = useCallback((g: Graphics) => {
    g.clear();
    const w = 92;
    const seatY = 6;
    // Shadow.
    g.ellipse(0, seatY + 22, w / 2, 8);
    g.fill({ color: 0x000000, alpha: 0.22 });
    // Backrest.
    g.roundRect(-w / 2, seatY - 26, w, 22, 8);
    g.fill({ color: 0x3f5468 });
    // Seat base.
    g.roundRect(-w / 2, seatY - 8, w, 26, 8);
    g.fill({ color: 0x4a6378 });
    // Arms.
    g.roundRect(-w / 2 - 6, seatY - 14, 14, 30, 6);
    g.fill({ color: 0x37485a });
    g.roundRect(w / 2 - 8, seatY - 14, 14, 30, 6);
    g.fill({ color: 0x37485a });
    // Cushions.
    g.roundRect(-w / 2 + 8, seatY - 20, w / 2 - 12, 16, 5);
    g.fill({ color: 0x577089 });
    g.roundRect(4, seatY - 20, w / 2 - 12, 16, 5);
    g.fill({ color: 0x577089 });
  }, []);
  return (
    <pixiContainer x={x} y={y} zIndex={y - 2}>
      <pixiGraphics draw={draw} />
    </pixiContainer>
  );
}
const Couch = memo(CouchComponent);

// ============================================================================
// EXIT (Ended) — the elevator doorway agents leave through. Reuses the office
// elevator sprites + a drawn EXIT sign.
// ============================================================================

const DOOR_PANEL_X = 50;
const DOOR_PANEL_Y = -59;

function ExitDoorComponent({
  textures: t,
}: {
  textures: OfficeTextures;
}): ReactNode {
  const cx = EXIT_DOOR_X;
  const baseY = EXIT_DOOR_BASE_Y;
  // Open the doors while an agent is stepping out.
  const doorOpen = useExitStore(selectDoorOpen);

  const drawSign = useCallback((g: Graphics) => {
    g.clear();
    g.roundRect(-34, -12, 68, 24, 4);
    g.fill({ color: 0x14532d });
    g.roundRect(-34, -12, 68, 24, 4);
    g.stroke({ color: 0x22c55e, width: 2 });
  }, []);

  const drawDoor = useCallback((g: Graphics) => {
    g.clear();
    // Frame.
    g.roundRect(-52, -150, 104, 150, 6);
    g.fill({ color: 0x2b2f36 });
    g.roundRect(-52, -150, 104, 150, 6);
    g.stroke({ color: 0x4a5260, width: 3 });
    // Door panels.
    g.rect(-42, -140, 40, 138);
    g.fill({ color: 0x3a4250 });
    g.rect(2, -140, 40, 138);
    g.fill({ color: 0x3a4250 });
    g.rect(-2, -140, 4, 138);
    g.fill({ color: 0x20242b });
  }, []);

  return (
    <pixiContainer x={cx} y={baseY} zIndex={baseY - 4}>
      {t.elevatorFrame ? (
        <pixiSprite
          texture={t.elevatorFrame}
          anchor={{ x: 0.5, y: 1 }}
          x={0}
          y={4}
          scale={0.26}
        />
      ) : (
        <pixiGraphics draw={drawDoor} />
      )}
      {/* Closed doors — slide away (hidden) while someone is exiting */}
      {t.elevatorDoor && !doorOpen && (
        <>
          <pixiSprite
            texture={t.elevatorDoor}
            anchor={{ x: 0, y: 0.5 }}
            x={-DOOR_PANEL_X}
            y={DOOR_PANEL_Y}
            scale={{ x: 0.09, y: 0.183 }}
          />
          <pixiSprite
            texture={t.elevatorDoor}
            anchor={{ x: 1, y: 0.5 }}
            x={DOOR_PANEL_X}
            y={DOOR_PANEL_Y}
            scale={{ x: 0.09, y: 0.183 }}
          />
        </>
      )}
      {/* EXIT sign above the doorway */}
      <pixiContainer y={-168}>
        <pixiGraphics draw={drawSign} />
        <pixiContainer scale={0.5}>
          <pixiText
            text="EXIT"
            anchor={0.5}
            resolution={2}
            style={{
              fontFamily: "monospace",
              fontSize: 26,
              fill: 0x4ade80,
              fontWeight: "bold",
            }}
          />
        </pixiContainer>
      </pixiContainer>
    </pixiContainer>
  );
}
const ExitDoor = memo(ExitDoorComponent);

// ============================================================================
// (로컬 커스텀) GYM — 휴식 칸 바닥: 트랙·매트·농구 골대·덤벨
// ============================================================================

function GymFloorComponent({ zone }: { zone: ZoneDef }): ReactNode {
  const draw = useCallback(
    (g: Graphics) => {
      g.clear();
      const cx = zone.x + zone.w / 2;
      const top = zone.y + 60;
      const bottom = zone.y + zone.h - 30;
      // 러닝 트랙(세로로 긴 타원 두 줄)
      const rx = zone.w / 2 - 26;
      const ry = (bottom - top) / 2;
      const cy = (top + bottom) / 2;
      g.ellipse(cx, cy, rx, ry);
      g.stroke({ color: 0xc2410c, width: 14, alpha: 0.35 });
      g.ellipse(cx, cy, rx, ry);
      g.stroke({ color: 0xffffff, width: 1.5, alpha: 0.35 });
      g.ellipse(cx, cy, rx - 14, ry - 14);
      g.stroke({ color: 0xffffff, width: 1, alpha: 0.18 });
      // 요가 매트(놀이 자리 밑)
      for (let i = 0; i < 6; i++) {
        const p = slotPosition(zone, i);
        g.roundRect(p.x - 34, p.y - 8, 68, 20, 5);
        g.fill({ color: [0x7c3aed, 0x0ea5e9, 0x10b981, 0xf43f5e, 0xf59e0b, 0x6366f1][i], alpha: 0.28 });
      }
      // 농구 골대(오른쪽 위)
      const hx = zone.x + zone.w - 44;
      const hy = top + 30;
      g.rect(hx + 14, hy - 4, 5, 70);
      g.fill({ color: 0x6b7280 });
      g.roundRect(hx - 14, hy - 30, 40, 28, 3);
      g.fill({ color: 0xf8fafc });
      g.roundRect(hx - 14, hy - 30, 40, 28, 3);
      g.stroke({ color: 0xef4444, width: 2 });
      g.ellipse(hx + 6, hy, 12, 4);
      g.stroke({ color: 0xf97316, width: 3 });
      // 덤벨 두 개(왼쪽 아래)
      for (const [dx, dy] of [[0, 0], [30, 12]]) {
        const x = zone.x + 34 + dx;
        const y = bottom - 40 + dy;
        g.rect(x, y, 22, 4);
        g.fill({ color: 0x9ca3af });
        g.roundRect(x - 6, y - 5, 8, 14, 2);
        g.roundRect(x + 20, y - 5, 8, 14, 2);
        g.fill({ color: 0x374151 });
      }
    },
    [zone],
  );
  return <pixiGraphics draw={draw} zIndex={-1} />;
}

const GymFloor = memo(GymFloorComponent);

// ============================================================================
// FURNITURE LAYER (static — drawn once, never follows agents)
// ============================================================================

function zoneFurniture(zone: ZoneDef, textures: OfficeTextures): ReactNode[] {
  if (zone.kind === "exit") {
    return [<ExitDoor key={`${zone.key}-exit`} textures={textures} />];
  }
  if (zone.kind === "gym") {
    return [
      <GymFloor key={`${zone.key}-gym`} zone={zone} />,
      <ExitDoor key={`${zone.key}-exit`} textures={textures} />,
    ];
  }
  const items: ReactNode[] = [];
  for (let slot = 0; slot < DESK_SLOTS; slot++) {
    const p = slotPosition(zone, slot);
    if (zone.kind === "lounge") {
      items.push(<Couch key={`${zone.key}-${slot}`} x={p.x} y={p.y} />);
    } else {
      items.push(
        <Desk
          key={`${zone.key}-${slot}`}
          x={p.x}
          y={p.y}
          slot={slot}
          textures={textures}
        />,
      );
    }
  }
  return items;
}

interface CommandCenterFurnitureProps {
  textures: OfficeTextures;
}

export function CommandCenterFurniture({
  textures,
}: CommandCenterFurnitureProps): ReactNode {
  return (
    <pixiContainer sortableChildren={true}>
      {ZONES.flatMap((zone) => zoneFurniture(zone, textures))}
    </pixiContainer>
  );
}
