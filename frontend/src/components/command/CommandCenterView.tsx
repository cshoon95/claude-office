"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState, type ReactNode } from "react";
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

  const [popup, setPopup] = useState<PeerPopupState | null>(null);
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

        {/* Canvas */}
        <div className="flex-grow border border-slate-800 rounded-lg shadow-2xl bg-slate-900 overflow-hidden relative min-h-0">
          <CommandCenterCanvas
            peers={peers}
            counts={counts}
            overflow={overflow}
            summary={summary}
            onPeerActivate={handlePeerActivate}
          />
        </div>
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
