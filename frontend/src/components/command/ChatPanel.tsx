"use client";

// (로컬 커스텀) Command Center 아래 채팅 패널 — 휴대폰에서 맥의 Claude Code 에게 일 시키기.
// 새 대화(허용 폴더) 또는 기존 세션 이어서(--resume). 응답은 1초마다 받아 온다.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Session } from "@/hooks/useSessions";
import {
  fetchSkills,
  focusChatInput,
  isClaudeSessionId,
  isNewKey,
  registerChatInput,
  useChatStore,
  type ChatMsg,
  type SkillInfo,
} from "./chatApi";
import { HighlightLayer, RichText, SkillChip, skillFromTool, usedSkills } from "./skillText";

const LIVE_CONFIRM =
  "이 세션은 지금 Orca/터미널에 열려 있을 수 있어요. 같이 쓰면 대화가 갈라질 수 있어요. 보낼까요?";
const EMPTY: ChatMsg[] = [];
const HISTORY_POLL_MS = 3000;

const SCRATCH = "빈 대화"; // 서버 /chat/folders 맨 앞(레포 없이 아무거나 물어보는 폴더)

function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function sessionTitle(s: Session): string {
  const name = s.displayName || s.label || s.id.slice(0, 8);
  return s.projectName && s.projectName !== name ? `${name} · ${s.projectName}` : name;
}

function Message({ m, known }: { m: ChatMsg; known: Set<string> | null }): ReactNode {
  switch (m.kind) {
    case "user":
      return (
        <div className="flex justify-end pl-8">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-gradient-to-br from-sky-600 to-indigo-600 px-3.5 py-2 text-sm leading-relaxed text-white shadow-md shadow-indigo-950/40 whitespace-pre-wrap break-words">
            <RichText text={m.text} known={known} />
          </div>
        </div>
      );
    case "text":
      return (
        <div className="flex items-start gap-2 pr-6">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-orange-500/15 text-[13px] text-orange-300 ring-1 ring-orange-400/40">
            ✳
          </span>
          <div className="max-w-[92%] rounded-2xl rounded-tl-md border border-slate-700/60 bg-slate-800/70 px-3.5 py-2 text-sm leading-relaxed text-slate-100 whitespace-pre-wrap break-words">
            <RichText text={m.text} known={known} />
          </div>
        </div>
      );
    case "tool": {
      const skill = skillFromTool(m.text);
      if (skill)
        return (
          <div className="ml-8 inline-flex items-center gap-1.5 rounded-md bg-violet-500/15 px-2 py-1 font-mono text-[11px] text-violet-200 ring-1 ring-violet-400/40">
            ⚡ 스킬 실행 <b className="text-violet-100">/{skill}</b>
          </div>
        );
      const i = m.text.indexOf(":");
      const name = i > 0 ? m.text.slice(0, i) : m.text;
      const arg = i > 0 ? m.text.slice(i + 1).trim() : "";
      return (
        <div className="ml-8 flex min-w-0 items-baseline gap-1.5 border-l-2 border-slate-700 pl-2 font-mono text-[11px]">
          <span className="text-emerald-400/90">⏺</span>
          <span className="shrink-0 font-semibold text-slate-300">{name}</span>
          <span className="truncate text-slate-500">{arg}</span>
        </div>
      );
    }
    case "tool_result":
      return (
        <details className="ml-8 pl-2 font-mono text-[11px] text-slate-600">
          <summary className="cursor-pointer select-none truncate">⎿ {m.text.split("\n")[0]}</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words text-slate-500">{m.text}</pre>
        </details>
      );
    case "status":
      return (
        <div className="flex justify-center">
          <span className="rounded-full bg-slate-800/80 px-2.5 py-0.5 font-mono text-[10px] text-slate-500">{m.text}</span>
        </div>
      );
    case "result":
      return (
        <div className="ml-8 inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px] text-emerald-300/90 ring-1 ring-emerald-500/30">
          ✓ {m.text}
        </div>
      );
    case "error":
      return (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-300 whitespace-pre-wrap break-words">
          ⚠ {m.text}
        </div>
      );
  }
}

/** 커서 바로 앞이 "/글자" 면 그 글자(자동완성 검색어) */
function slashQuery(text: string, caret: number): { q: string; start: number } | null {
  const m = /(^|\s)\/([\w.:-]*)$/.exec(text.slice(0, caret));
  return m ? { q: m[2].toLowerCase(), start: caret - m[2].length - 1 } : null;
}

export function ChatPanel({ sessions }: { sessions: Session[] }): ReactNode {
  const target = useChatStore((s) => s.target);
  const conv = useChatStore((s) => (s.target ? s.conversations[s.target] : undefined));
  const folders = useChatStore((s) => s.folders);
  const disabled = useChatStore((s) => s.disabled);
  const error = useChatStore((s) => s.error);
  const collapsed = useChatStore((s) => s.collapsed);
  const history = useChatStore((s) => (s.target ? s.histories[s.target] : undefined)) ?? EMPTY;
  const { setTarget, setCollapsed, loadFolders, loadHistory, send, stop } = useChatStore.getState();
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  // 쓸 수 있는 스킬(세션이면 그 폴더의 프로젝트 스킬까지)
  const skillKey = target && !isNewKey(target) ? target : null;
  useEffect(() => {
    let alive = true;
    fetchSkills(skillKey)
      .then((l) => alive && setSkills(l))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [skillKey]);
  const known = useMemo(() => (skills.length ? new Set(skills.map((k) => k.name)) : null), [skills]);

  // "/" 자동완성
  const sq = caret < 0 ? null : slashQuery(draft, caret);
  const suggestions = useMemo(() => {
    if (!sq) return [];
    const q = sq.q;
    const hit = skills.filter((k) => k.name.toLowerCase().includes(q));
    hit.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)));
    return hit.slice(0, 7);
  }, [sq?.q, skills]); // eslint-disable-line react-hooks/exhaustive-deps
  const showSuggest = suggestions.length > 0;
  const choose = (name: string) => {
    if (!sq) return;
    const next = `${draft.slice(0, sq.start)}/${name} ${draft.slice(caret)}`;
    const pos = sq.start + name.length + 2;
    setDraft(next);
    setPick(0);
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };
  const draftSkills = usedSkills(draft, known);


  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  const running = conv?.running ?? false;
  // 지난 대화(기록 파일) + 여기서 보낸 것 중 기록에 아직 안 들어간 것.
  // --resume 실행도 같은 기록 파일에 쌓이므로, 기록의 마지막 시각 이후 것만 덧붙인다.
  const messages = useMemo(() => {
    const local = conv?.messages ?? EMPTY;
    if (!history.length) return local;
    const last = history[history.length - 1].ts;
    return [...history, ...local.filter((m) => m.ts > last)];
  }, [history, conv?.messages]);

  // ↑/↓ 로 이 대화에서 보낸 프롬프트 다시 불러오기(터미널처럼). 최신 것부터, 연속 중복은 하나로
  const sent = useMemo(() => {
    const out: string[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.kind === "user" && m.text !== out[out.length - 1]) out.push(m.text);
    }
    return out;
  }, [messages]);
  // -1 = 지금 쓰는 글. 대상을 바꾸면 처음부터(다른 대상의 위치는 무시)
  const [recallAt, setRecallAt] = useState<{ key: string | null; i: number }>({ key: null, i: -1 });
  const recall = recallAt.key === target ? recallAt.i : -1;
  const setRecall = (i: number) => setRecallAt({ key: target, i });
  const [stash, setStash] = useState("");
  const recallTo = (i: number) => {
    const text = i < 0 ? stash : sent[i];
    setRecall(i);
    setDraft(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.setSelectionRange(text.length, text.length);
      setCaret(text.length);
    });
  };

  // 세션을 보고 있는 동안 기록을 3초마다 새로 읽는다(터미널에서 진행 중인 대화도 따라 보이게)
  useEffect(() => {
    if (!target || isNewKey(target) || collapsed) return;
    void loadHistory(target);
    const t = setInterval(() => void loadHistory(target), HISTORY_POLL_MS);
    return () => clearInterval(t);
  }, [target, collapsed, loadHistory]);

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
  const scratch = folders.find((f) => f.name === SCRATCH);
  const isScratchTarget = !!scratch && target === `new:${scratch.path}`;
  const startBlank = () => {
    if (!scratch) return;
    setTarget(`new:${scratch.path}`);
    setCollapsed(false);
    focusChatInput();
  };
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
    setRecall(-1);
    void send(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSuggest && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = suggestions.length;
        setPick((p) => (p + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        choose(suggestions[Math.min(pick, suggestions.length - 1)].name);
        return;
      }
      if (e.key === "Escape") {
        setCaret(-1);
        return;
      }
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.nativeEvent.isComposing && !e.shiftKey) {
      const el = e.currentTarget;
      const before = el.value.slice(0, el.selectionStart);
      const after = el.value.slice(el.selectionEnd);
      // 커서가 첫 줄(↑)·마지막 줄(↓)에 있을 때만 — 여러 줄 글 안에서는 원래대로 줄 이동.
      // 불러온 글을 고치지 않았으면 줄 위치와 상관없이 계속 넘긴다
      const browsing = recall >= 0 && draft === sent[recall];
      if (e.key === "ArrowUp" && (browsing || !before.includes("\n")) && recall < sent.length - 1) {
        e.preventDefault();
        if (recall < 0) setStash(draft);
        recallTo(recall + 1);
        return;
      }
      if (e.key === "ArrowDown" && (browsing || !after.includes("\n")) && recall >= 0) {
        e.preventDefault();
        recallTo(recall - 1);
        return;
      }
    }
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    // 휴대폰(터치)에선 Enter = 줄바꿈, 보내기는 버튼으로
    if (window.matchMedia("(pointer: coarse)").matches) return;
    e.preventDefault();
    submit();
  };

  const cwd =
    conv?.cwd ??
    (target && isNewKey(target) ? target.slice(4) : sessions.find((x) => x.id === target)?.projectRoot ?? null);

  return (
    <div
      className={`flex flex-col flex-1 min-h-0 md:flex-none overflow-hidden rounded-xl border border-slate-700/70 bg-[#0a0e17] shadow-2xl shadow-black/40 ring-1 ring-white/5 ${
        collapsed ? "md:h-auto" : "md:h-80"
      }`}
    >
      {/* 제목줄: 신호등 + 대상 고르기 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 bg-gradient-to-b from-slate-800/80 to-slate-900/80 px-2.5 py-1.5">
        <div className="hidden sm:flex items-center gap-1.5 pr-1">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </div>
        <span className="whitespace-nowrap font-mono text-xs font-bold text-orange-300">✳ claude</span>
        <select
          value={target ?? ""}
          onChange={(e) => setTarget(e.target.value)}
          disabled={!!disabled}
          className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950/70 px-2 py-1 font-mono text-base md:text-xs text-slate-100 focus:border-orange-400/70 focus:outline-none"
        >
          {!target && <option value="">대상을 고르세요</option>}
          <optgroup label="새 대화">
            {folders.map((f) => (
              <option key={f.path} value={`new:${f.path}`}>
                {f.name === SCRATCH ? "빈 대화 (레포 없이 아무거나)" : `새 대화 · ${f.name}`}
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
        {scratch && (
          <button
            type="button"
            onClick={startBlank}
            disabled={!!disabled}
            className="shrink-0 rounded-md bg-orange-500/90 px-2.5 py-1 text-xs font-bold text-white shadow-sm hover:bg-orange-400 disabled:opacity-40"
            title="레포와 상관없이 새 대화"
          >
            ＋ 새 대화
          </button>
        )}
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
        {/* 경로 줄 */}
        {(cwd || targetIsSession) && (
          <div className="flex shrink-0 items-center gap-2 border-b border-slate-800/80 bg-slate-950/40 px-3 py-1 font-mono text-[11px]">
            {cwd && <span className="truncate text-slate-400">📁 {cwd.replace(/^\/Users\/[^/]+/, "~")}</span>}
            {targetIsSession && (
              <span className="ml-auto shrink-0 text-amber-400/70">터미널 창엔 여기서 한 말이 안 보여요</span>
            )}
          </div>
        )}

        {/* 메시지 */}
        <div
          ref={listRef}
          className="flex-1 min-h-0 space-y-2 overflow-y-auto bg-[radial-gradient(ellipse_at_top,rgba(56,189,248,0.06),transparent_60%)] px-3 py-3"
        >
          {messages.length === 0 && !disabled && (
            <div className="flex flex-col items-center gap-1 py-6 text-center">
              <span className="text-2xl text-orange-300/80">✳</span>
              <span className="text-xs text-slate-500">
                {isScratchTarget
                  ? "아무거나 물어보세요 · / 를 치면 스킬 목록이 나와요"
                  : target && isNewKey(target)
                  ? `${folderName(target.slice(4))} 폴더에서 새로 시작해요`
                  : "말을 걸면 맥에서 Claude 가 일해요"}
              </span>
            </div>
          )}
          {messages.map((m) => (
            <Message key={m.id} m={m} known={known} />
          ))}
          {running && (
            <div className="ml-8 flex items-center gap-2 font-mono text-xs text-orange-300">
              <span className="inline-block animate-spin">✳</span>
              작업 중…
            </div>
          )}
        </div>

        {/* 입력 */}
        {disabled ? (
          <div className="shrink-0 border-t border-slate-800 px-3 py-3 text-sm text-amber-300">{disabled}</div>
        ) : (
          <div className="relative shrink-0 border-t border-slate-800 bg-slate-950/60 p-2">
            {error && <div className="mb-1 text-xs text-rose-400">{error}</div>}

            {/* 스킬 자동완성 */}
            {showSuggest && (
              <div className="absolute bottom-full left-2 right-2 z-20 mb-1 overflow-hidden rounded-lg border border-violet-500/40 bg-slate-900/95 shadow-xl backdrop-blur">
                <div className="border-b border-slate-800 px-3 py-1 text-[10px] text-slate-500">⚡ 스킬 · ↑↓ 고르기 · Tab/Enter 넣기</div>
                {suggestions.map((k, i) => (
                  <button
                    key={k.name}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(k.name);
                    }}
                    className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left ${
                      i === pick ? "bg-violet-500/20" : "hover:bg-slate-800"
                    }`}
                  >
                    <span className="shrink-0 font-mono text-xs font-semibold text-violet-200">/{k.name}</span>
                    <span className="truncate text-[11px] text-slate-500">{k.description}</span>
                  </button>
                ))}
              </div>
            )}

            {/* 이 글에 들어간 스킬 */}
            {draftSkills.length > 0 && (
              <div className="mb-1.5 flex flex-wrap items-center gap-1 text-[11px] text-slate-400">
                <span>사용할 명령</span>
                {draftSkills.map((k) => k && <SkillChip key={k.name} name={k.name} state={k.state} />)}
                {draftSkills.some((k) => k?.state === "unknown") && (
                  <span className="text-amber-300/80">· ? 는 설치된 스킬이 아니라 그냥 글로 전달돼요</span>
                )}
              </div>
            )}

            <div className="flex items-end gap-2">
              <div className="relative min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 focus-within:border-orange-400/60 focus-within:ring-2 focus-within:ring-orange-400/15">
                <span className="pointer-events-none absolute left-2.5 top-2 font-mono text-base leading-6 text-orange-400">❯</span>
                <div
                  ref={layerRef}
                  aria-hidden
                  className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words py-2 pl-7 pr-2.5 text-base leading-6 text-transparent"
                >
                  <HighlightLayer text={draft} known={known} />
                </div>
                <textarea
                  ref={(el) => {
                    inputRef.current = el;
                    registerChatInput(el);
                  }}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setCaret(e.target.selectionStart);
                    setRecall(-1);
                    setPick(0);
                  }}
                  onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                  onBlur={() => setCaret(-1)}
                  onScroll={(e) => {
                    if (layerRef.current) layerRef.current.scrollTop = e.currentTarget.scrollTop;
                  }}
                  onKeyDown={onKeyDown}
                  rows={2}
                  maxLength={8000}
                  placeholder={running ? "끝나면 이어서 보낼 수 있어요" : "Claude 에게 시킬 일  ·  / 스킬"}
                  className="relative block w-full resize-none bg-transparent py-2 pl-7 pr-2.5 text-base leading-6 text-slate-100 caret-orange-400 placeholder:text-slate-600 focus:outline-none"
                />
              </div>
              {running ? (
                <button
                  type="button"
                  onClick={() => void stop()}
                  className="shrink-0 rounded-lg bg-rose-600 px-3.5 py-2.5 text-sm font-bold text-white hover:bg-rose-500"
                >
                  멈춤
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={!draft.trim() || !target}
                  className="shrink-0 rounded-lg bg-gradient-to-br from-orange-500 to-rose-500 px-3.5 py-2.5 text-sm font-bold text-white shadow-md shadow-rose-950/40 hover:brightness-110 disabled:opacity-40"
                >
                  보내기
                </button>
              )}
            </div>
            <div className="mt-1 hidden md:block px-1 text-[10px] text-slate-600">
              Enter 보내기 · Shift+Enter 줄바꿈 · ↑↓ 지난 프롬프트 · / 스킬 목록
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
