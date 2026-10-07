"use client";

// (로컬 커스텀) Command Center 아래 채팅 패널 — 휴대폰에서 맥의 Claude Code 에게 일 시키기.
// 새 대화(허용 폴더) 또는 기존 세션 이어서(--resume). 응답은 1초마다 받아 온다.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Session } from "@/hooks/useSessions";
import { isClaudeSessionId, isNewKey, registerChatInput, useChatStore, type ChatMsg } from "./chatApi";

const LIVE_CONFIRM =
  "이 세션은 지금 Orca/터미널에 열려 있을 수 있어요. 같이 쓰면 대화가 갈라질 수 있어요. 보낼까요?";
const EMPTY: ChatMsg[] = [];

function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function sessionTitle(s: Session): string {
  const name = s.displayName || s.label || s.id.slice(0, 8);
  return s.projectName && s.projectName !== name ? `${name} · ${s.projectName}` : name;
}

function Message({ m }: { m: ChatMsg }): ReactNode {
  switch (m.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-lg rounded-br-sm bg-sky-700 px-3 py-2 text-sm text-white whitespace-pre-wrap break-words">
            {m.text}
          </div>
        </div>
      );
    case "text":
      return (
        <div className="flex justify-start">
          <div className="max-w-[92%] rounded-lg rounded-bl-sm bg-slate-800 px-3 py-2 text-sm text-slate-100 whitespace-pre-wrap break-words">
            {m.text}
          </div>
        </div>
      );
    case "tool":
      return <div className="truncate px-1 font-mono text-[11px] text-slate-500">🔧 {m.text}</div>;
    case "tool_result":
      return (
        <details className="px-1 font-mono text-[11px] text-slate-600">
          <summary className="cursor-pointer select-none truncate">↳ {m.text.split("\n")[0]}</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words text-slate-500">{m.text}</pre>
        </details>
      );
    case "status":
      return <div className="text-center font-mono text-[10px] text-slate-600">— {m.text} —</div>;
    case "result":
      return <div className="px-1 font-mono text-[11px] text-emerald-500/80">✓ {m.text}</div>;
    case "error":
      return <div className="px-1 text-xs text-rose-400 whitespace-pre-wrap break-words">⚠ {m.text}</div>;
  }
}

export function ChatPanel({ sessions }: { sessions: Session[] }): ReactNode {
  const target = useChatStore((s) => s.target);
  const conv = useChatStore((s) => (s.target ? s.conversations[s.target] : undefined));
  const folders = useChatStore((s) => s.folders);
  const disabled = useChatStore((s) => s.disabled);
  const error = useChatStore((s) => s.error);
  const collapsed = useChatStore((s) => s.collapsed);
  const { setTarget, setCollapsed, loadFolders, send, stop } = useChatStore.getState();
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  const messages = conv?.messages ?? EMPTY;
  const running = conv?.running ?? false;

  // 새 메시지가 오면 맨 아래로
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, running, collapsed]);

  // 실제 Claude 세션만(직접 추가한 캐릭터 제외), 최근 것부터
  const sessionOptions = useMemo(
    () =>
      sessions
        .filter((s) => isClaudeSessionId(s.id))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 40),
    [sessions],
  );
  const targetIsSession = !!target && !isNewKey(target);
  const targetKnown = !target || isNewKey(target) || sessionOptions.some((s) => s.id === target);

  const submit = () => {
    const text = draft.trim();
    if (!text || running || !target) return;
    // 터미널에서 지금 쓰는 세션일 수 있으면 한 번 묻는다(세션마다 한 번)
    if (!isNewKey(target) && !conv?.bornHere && !useChatStore.getState().confirmed[target]) {
      const live = sessions.find((s) => s.id === target)?.status === "active";
      if (live) {
        if (!window.confirm(LIVE_CONFIRM)) return;
        useChatStore.getState().confirm(target);
      }
    }
    setDraft("");
    void send(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    // 휴대폰(터치)에선 Enter = 줄바꿈, 보내기는 버튼으로
    if (window.matchMedia("(pointer: coarse)").matches) return;
    e.preventDefault();
    submit();
  };

  return (
    <div
      className={`flex flex-col flex-1 min-h-0 md:flex-none rounded-lg border border-slate-800 bg-slate-900 overflow-hidden ${
        collapsed ? "md:h-auto" : "md:h-72"
      }`}
    >
      {/* 헤더: 대상 고르기 */}
      <div className="flex items-center gap-2 border-b border-slate-800 px-2 py-1.5 shrink-0">
        <span className="text-xs font-bold text-sky-400 whitespace-nowrap">💬 Claude</span>
        <select
          value={target ?? ""}
          onChange={(e) => setTarget(e.target.value)}
          disabled={!!disabled}
          className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-base md:text-xs text-white focus:border-sky-500 focus:outline-none"
        >
          {!target && <option value="">대상을 고르세요</option>}
          <optgroup label="새 대화">
            {folders.map((f) => (
              <option key={f.path} value={`new:${f.path}`}>
                새 대화 · {f.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="이어서 하기">
            {!targetKnown && target && <option value={target}>방금 대화 · {target.slice(0, 8)}</option>}
            {sessionOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.status === "active" ? "● " : ""}
                {sessionTitle(s)}
              </option>
            ))}
          </optgroup>
        </select>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="hidden md:inline-flex rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
          title={collapsed ? "펼치기" : "접기"}
        >
          {collapsed ? "▲" : "▼"}
        </button>
      </div>

      <div className={`flex flex-col flex-1 min-h-0 ${collapsed ? "md:hidden" : ""}`}>
        {targetIsSession && (
          <div className="shrink-0 border-b border-slate-800 px-3 py-1 text-[11px] text-amber-400/80">
            Orca/터미널에 열린 창에는 이 대화가 안 보여요
            {conv?.cwd ? <span className="text-slate-500"> · {folderName(conv.cwd)}</span> : null}
          </div>
        )}

        {/* 메시지 */}
        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1.5">
          {messages.length === 0 && !disabled && (
            <div className="py-4 text-center text-xs text-slate-600">
              {target && isNewKey(target)
                ? `${folderName(target.slice(4))} 폴더에서 새로 시작해요`
                : "말을 걸면 맥에서 Claude 가 일해요"}
            </div>
          )}
          {messages.map((m) => (
            <Message key={m.id} m={m} />
          ))}
          {running && (
            <div className="flex items-center gap-2 px-1 text-xs text-sky-400">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
              작업 중…
            </div>
          )}
        </div>

        {/* 입력 */}
        {disabled ? (
          <div className="shrink-0 border-t border-slate-800 px-3 py-3 text-sm text-amber-300">{disabled}</div>
        ) : (
          <div className="shrink-0 border-t border-slate-800 p-2">
            {error && <div className="mb-1 text-xs text-rose-400">{error}</div>}
            <div className="flex items-end gap-2">
              <textarea
                ref={registerChatInput}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                rows={2}
                maxLength={8000}
                placeholder={running ? "끝나면 이어서 보낼 수 있어요" : "Claude 에게 시킬 일"}
                className="min-w-0 flex-1 resize-none rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-base text-white placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
              />
              {running ? (
                <button
                  type="button"
                  onClick={() => void stop()}
                  className="shrink-0 rounded-md bg-rose-600 px-3 py-2 text-sm font-bold text-white hover:bg-rose-500"
                >
                  멈춤
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={!draft.trim() || !target}
                  className="shrink-0 rounded-md bg-sky-600 px-3 py-2 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-40"
                >
                  보내기
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
