"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CANVAS_WIDTH, CANVAS_HEIGHT } from "@/constants/canvas";
import { SessionSidebar } from "@/components/layout/SessionSidebar";
import { useTranslation } from "@/hooks/useTranslation";
import { useOverviewWebSocket } from "@/hooks/useOverviewWebSocket";
import {
  useOverviewStore,
  selectOverviewConnected,
} from "@/stores/overviewStore";
import { useNavigationStore } from "@/stores/navigationStore";
import type { Session } from "@/hooks/useSessions";
import {
  useCommandCenterPeers,
  type CommandPeer,
} from "./useCommandCenterPeers";
import { PeerPopup, type PeerPopupState } from "./PeerPopup";
import { ZONE_BY_KEY, ZONE_ORDER } from "./layout";
import { sessionMatchesFloor } from "./sessionMatchesFloor";
import { ManualTaskModal } from "./ManualTaskModal";
import { useManualStore } from "./manualApi";
import { isClaudeSessionId, useChatStore } from "./chatApi";

// (로컬 커스텀) 채팅은 localStorage 에서 대화를 되살리므로 클라이언트에서만 그린다
const ChatPanel = dynamic(
  () => import("./ChatPanel").then((m) => ({ default: m.ChatPanel })),
  { ssr: false },
);

const DEFAULT_TITLE = "Claude Office Visualizer";

function CommandCenterLoading(): ReactNode {
  const { t } = useTranslation();
  return (
    <div className="w-full h-full bg-slate-900 animate-pulse flex items-center justify-center text-white font-mono text-center">
      {t("commandCenter.initializing")}
    </div>
  );
}

// Canvas is PixiJS/WebGL — load client-side only.
const CommandCenterCanvas = dynamic(
  () =>
    import("./CommandCenterCanvas").then((m) => ({
      default: m.CommandCenterCanvas,
    })),
  {
    ssr: false,
    loading: () => <CommandCenterLoading />,
  },
);

export interface CommandCenterViewProps {
  sessions: Session[];
  sessionsLoading: boolean;
  sessionId: string;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  onSessionSelect: (id: string) => Promise<void>;
  onDeleteSession: (session: Session) => void;
  onRenameSession: (sessionId: string, newName: string) => Promise<void>;
}

export function CommandCenterView({
  sessions,
  sessionsLoading,
  sessionId,
  isCollapsed,
  onToggleCollapsed,
  onSessionSelect,
  onDeleteSession,
  onRenameSession,
}: CommandCenterViewProps): ReactNode {
  const { t } = useTranslation();
  // Connect to /ws/overview for as long as this view is mounted.
  useOverviewWebSocket({ enabled: true });
  const connected = useOverviewStore(selectOverviewConnected);

  const { peers, counts, overflow, summary } = useCommandCenterPeers(sessions);

  // (로컬 커스텀) 확인 필요 수를 탭 제목에 — Pixel Office.app 이 읽어 독 배지로 띄운다
  const needsYou = counts.needs_you ?? 0;
  useEffect(() => {
    document.title = needsYou > 0 ? `(${needsYou}) Pixel Office` : DEFAULT_TITLE;
  }, [needsYou]);
  useEffect(() => () => { document.title = DEFAULT_TITLE; }, []);

  const [popup, setPopup] = useState<PeerPopupState | null>(null);
  // (로컬 커스텀) 캔버스 상자를 사무실 비율에 맞춰 칸 안에 꽉 차게(contain) 잰다
  const [canvasBox, setCanvasBox] = useState<{ width: number; height: number } | null>(null);
  const slotObserver = useRef<ResizeObserver | null>(null);
  // 콜백 ref — 칸이 나중에 마운트돼도(로딩 뒤) 관찰을 건다
  const canvasSlotRef = useCallback((el: HTMLDivElement | null) => {
    slotObserver.current?.disconnect();
    slotObserver.current = null;
    if (!el) return;
    const ratio = CANVAS_WIDTH / CANVAS_HEIGHT;
    const ro = new ResizeObserver(([entry]) => {
      const { width: w, height: h } = entry.contentRect;
      if (w <= 0 || h <= 0) return;
      const width = Math.floor(Math.min(w, h * ratio));
      const height = Math.floor(width / ratio);
      setCanvasBox((b) => (b && b.width === width && b.height === height ? b : { width, height }));
    });
    ro.observe(el);
    slotObserver.current = ro;
  }, []);
  const [addOpen, setAddOpen] = useState(false);
  const refreshManual = useManualStore((s) => s.refresh);
  useEffect(() => {
    void refreshManual();
    const t = setInterval(() => void refreshManual(), 10000);
    return () => clearInterval(t);
  }, [refreshManual]);

  // Click a peer → open its popover (choose: open terminal, or drill in).
  const handlePeerActivate = useCallback(
    (peer: CommandPeer, screen: { x: number; y: number }) => {
      setPopup({ peer, x: screen.x, y: screen.y });
      // (로컬 커스텀) 누른 세션의 대화를 아래 채팅창에 바로 띄운다
      if (isClaudeSessionId(peer.sessionId)) {
        const chat = useChatStore.getState();
        if (chat.target !== peer.sessionId) chat.setTarget(peer.sessionId);
        chat.setCollapsed(false);
      }
    },
    [],
  );

  // Drill into a session: select it, then land in its floor (if configured) or
  // the single office view. Await the select so the target view mounts on the
  // new session instead of reading the old one for a frame.
  const handleDrillIn = useCallback(
    async (sid: string) => {
      await onSessionSelect(sid);
      const nav = useNavigationStore.getState();
      const session = sessions.find((s) => s.id === sid);
      const floor = session
        ? nav.buildingConfig?.floors.find((f) =>
            sessionMatchesFloor(session, f),
          )
        : undefined;
      if (floor) {
        nav.goToFloor(floor.id);
      } else {
        nav.goToSingle();
      }
    },
    [onSessionSelect, sessions],
  );

  return (
    <div className="flex-grow flex gap-2 overflow-hidden min-h-0">
      <div className="hidden md:flex">{/* (로컬 커스텀) 휴대폰에선 사이드바 숨김 */}
      <SessionSidebar
        sessions={sessions}
        sessionsLoading={sessionsLoading}
        sessionId={sessionId}
        isCollapsed={isCollapsed}
        onToggleCollapsed={onToggleCollapsed}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        onRenameSession={onRenameSession}
      />
      </div>

      <div className="flex-grow flex flex-col gap-2 min-h-0 min-w-0">
        {/* Summary bar */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 rounded-lg border border-slate-800 bg-slate-900 shrink-0">
          <span className="text-sm font-bold text-white tracking-tight">
            {t("commandCenter.title")}
          </span>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 flex-grow">
            {ZONE_ORDER.map((key) => {
              const zone = ZONE_BY_KEY[key];
              return (
                <span
                  key={key}
                  className="flex items-center gap-1.5 text-xs font-mono text-slate-300"
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: zone.cssColor }}
                  />
                  {counts[key] ?? 0} {t(zone.labelKey)}
                </span>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold text-white bg-sky-600 hover:bg-sky-500 transition-colors whitespace-nowrap"
          >
            ＋ 캐릭터 추가
          </button>
          <span
            className={`flex items-center gap-1.5 text-xs font-mono ${
              connected ? "text-emerald-400" : "text-rose-500"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                connected ? "bg-emerald-400 animate-pulse" : "bg-rose-500"
              }`}
            />
            {connected ? t("header.connected") : t("header.disconnected")}
          </span>
        </div>

        {/* Canvas — (로컬 커스텀) 좁은 화면(휴대폰·창 앱)에선 사무실 비율(5:4)대로 폭을 꽉 채우고
            남는 높이를 채팅에 준다. 높이가 모자라면 비율을 지킨 채 가운데로 줄인다 —
            캔버스가 상자와 같은 비율이라 잘리지도, 옆이 비지도 않는다(클릭 위치도 정확). */}
        <div
          ref={canvasSlotRef}
          className="w-full aspect-[5/4] shrink min-h-0 md:aspect-auto md:flex-grow flex justify-center"
        >
          <div
            className="border border-slate-800 rounded-lg shadow-2xl bg-slate-900 overflow-hidden relative"
            style={canvasBox ?? { width: "100%", height: "100%" }}
          >
            <CommandCenterCanvas
              peers={peers}
              counts={counts}
              overflow={overflow}
              summary={summary}
              onPeerActivate={handlePeerActivate}
            />
          </div>
        </div>

        {/* (로컬 커스텀) Claude 에게 말 걸기 */}
        <ChatPanel sessions={sessions} />
      </div>

      {addOpen && <ManualTaskModal open onClose={() => setAddOpen(false)} />}
      <PeerPopup
        key={popup?.peer.sessionId ?? "none"}
        popup={popup}
        onClose={() => setPopup(null)}
        onDrillIn={handleDrillIn}
      />
    </div>
  );
}
