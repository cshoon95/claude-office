"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Terminal, ArrowRight } from "lucide-react";
import { useAttentionStore } from "@/stores/attentionStore";
import { useTranslation } from "@/hooks/useTranslation";
import { ZONE_BY_KEY } from "./layout";
import type { CommandPeer } from "./useCommandCenterPeers";
import { ZONE_ORDER } from "./layout";
import { manualApi, useManualStore } from "./manualApi";
import { ZONE_KO } from "./ManualTaskModal";

const POPUP_WIDTH = 260;
const POPUP_MARGIN = 16;

export interface PeerPopupState {
  peer: CommandPeer;
  x: number;
  y: number;
}

interface PeerPopupProps {
  popup: PeerPopupState | null;
  onClose: () => void;
  onDrillIn: (sessionId: string) => void;
}

/**
 * Cross-session peer popover. Unlike the office {@link AgentPopup} (bound to the
 * active session's game store), this takes the peer's own session id, so the
 * "open terminal" action always targets exactly that one agent's terminal.
 */
export function PeerPopup({
  popup,
  onClose,
  onDrillIn,
}: PeerPopupProps): ReactNode {
  const { t } = useTranslation();
  const focusAgentTerminal = useAttentionStore((s) => s.focusAgentTerminal);
  const manual = useManualStore((s) => (popup ? s.tasks[popup.peer.sessionId] : undefined));
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState("");
  // 다른 캐릭터를 열면 부모가 key 를 바꿔 새로 마운트하므로 메모 초안·오류는 자동 초기화
  // 버튼 동작 공통: 실패하면 팝업을 닫지 않고 이유를 보여준다
  const act = async (fn: () => Promise<void>, after?: () => void) => {
    setBusy(true); setActErr("");
    try { await fn(); after?.(); onClose(); }
    catch (e) { setActErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!popup) return;
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [popup, handleKeyDown]);

  if (!popup) return null;
  if (typeof document === "undefined") return null;

  const { peer } = popup;
  const zone = ZONE_BY_KEY[peer.bucket];

  // Viewport-clamped positioning.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = popup.x + 16;
  let y = popup.y - 40;
  if (x + POPUP_WIDTH > vw - POPUP_MARGIN) x = popup.x - POPUP_WIDTH - 16;
  if (y + 220 > vh - POPUP_MARGIN) y = vh - 220 - POPUP_MARGIN;
  if (y < POPUP_MARGIN) y = POPUP_MARGIN;

  const handleFocusTerminal = () => {
    // peer.sessionId is this agent's own terminal — focus exactly that one.
    void focusAgentTerminal(peer.sessionId, null);
    onClose();
  };

  const handleDrill = () => {
    onDrillIn(peer.sessionId);
    onClose();
  };

  const content = (
    <div
      className="fixed inset-0 z-[90]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="absolute bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl p-4"
        style={{ left: x, top: y, width: POPUP_WIDTH }}
      >
        <div className="flex items-center gap-2 mb-3">
          <div
            className="w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: zone.cssColor }}
          />
          <span className="text-white font-bold text-sm truncate flex-1">
            {peer.label}
          </span>
        </div>

        <div className="text-[12px] text-neutral-400 space-y-1 mb-3">
          <div>
            <span className="text-neutral-600">
              {t("attention.popup.state")}:
            </span>{" "}
            {`${zone.emoji} ${t(zone.labelKey)}`}
            {peer.state ? ` (${peer.state})` : ""}
          </div>
          {peer.currentTask && (
            <div className="truncate">
              <span className="text-neutral-600">
                {t("attention.popup.task")}:
              </span>{" "}
              {peer.currentTask}
            </div>
          )}
          {peer.todoTotal > 0 && (
            <div>
              <span className="text-neutral-600">
                {t("commandCenter.popup.todos")}:
              </span>{" "}
              {peer.todoDone}/{peer.todoTotal}
            </div>
          )}
          {peer.subagentCount > 0 && (
            <div>
              <span className="text-neutral-600">
                {t("commandCenter.popup.employees")}:
              </span>{" "}
              {peer.subagentCount}
            </div>
          )}
        </div>

        {manual ? (
          <div className="space-y-2">
            <div className="text-[11px] text-neutral-500">칸 옮기기</div>
            <div className="grid grid-cols-2 gap-1.5">
              {ZONE_ORDER.map((k) => {
                const z = ZONE_BY_KEY[k];
                const on = manual.bucket === k;
                return (
                  <button key={k} disabled={busy || on}
                    onClick={() => act(() => manualApi.update(manual.id, { bucket: k }))}
                    className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-bold border ${on ? "text-white" : "text-neutral-300 border-neutral-700 hover:border-neutral-500"} disabled:cursor-default`}
                    style={on ? { borderColor: z.cssColor, backgroundColor: `${z.cssColor}33` } : undefined}>
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: z.cssColor }} />
                    {ZONE_KO[k]}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-1.5">
              <input value={noteDraft ?? manual.note} onChange={(e) => setNoteDraft(e.target.value)} maxLength={200} placeholder="메모(말풍선)"
                className="flex-1 min-w-0 bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1 text-[11px] text-white focus:outline-none focus:border-sky-500" />
              <button disabled={busy || noteDraft === null}
                onClick={() => act(() => manualApi.update(manual.id, { note: noteDraft ?? "" }), () => setNoteDraft(null))}
                className="px-2 rounded-md text-[11px] font-bold text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-40">저장</button>
            </div>
            <button disabled={busy}
              onClick={() => act(() => manualApi.remove(manual.id))}
              className="w-full py-1.5 rounded-md text-[11px] font-bold text-rose-300 bg-rose-500/15 hover:bg-rose-500/25">사무실에서 빼기</button>
            {actErr && <p className="text-[11px] text-rose-400 break-words">{actErr}</p>}
          </div>
        ) : (
        <div className="flex gap-2">
          <button
            onClick={handleFocusTerminal}
            className="flex-1 flex items-center justify-center gap-1.5 bg-blue-500 hover:bg-blue-600 text-white text-xs font-bold py-1.5 px-3 rounded-lg transition-colors"
          >
            <Terminal size={13} />
            {t("commandCenter.popup.terminal")}
          </button>
          <button
            onClick={handleDrill}
            className="flex-1 flex items-center justify-center gap-1.5 bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 text-xs font-bold py-1.5 px-3 rounded-lg transition-colors"
          >
            <ArrowRight size={13} />
            {t("commandCenter.popup.drillIn")}
          </button>
        </div>
        )}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
