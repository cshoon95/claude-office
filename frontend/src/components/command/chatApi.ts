// (로컬 커스텀) 휴대폰에서 Claude 에게 말 걸기 — backend /api/v1/chat
// 대화는 대상별로 모은다: 이어서 하는 세션은 세션 id, 새 대화는 "new:<폴더>" 로 두었다가
// 첫 응답에서 세션 id 가 오면 그 id 아래로 옮기고 대상도 바꾼다(다음 말은 --resume 으로 이어짐).
import { create } from "zustand";
import { apiFetch } from "@/utils/api";

const PATH = "/api/v1/chat";
const STORE_KEY = "pixel-office-chat";
const COLLAPSE_KEY = "pixel-office-chat-collapsed";
const MAX_CONVS = 20;
const MAX_MSGS = 300;
const POLL_MS = 1000;
const MAX_POLL_FAILURES = 20;

export type ChatKind = "user" | "status" | "text" | "tool" | "tool_result" | "result" | "error";

export interface ChatMsg {
  id: string;
  kind: ChatKind;
  text: string;
  ts: number;
}

export interface Conversation {
  key: string;
  cwd: string | null;
  messages: ChatMsg[];
  runId: string | null;
  running: boolean;
  lastSeq: number;
  updated: number;
  bornHere?: boolean; // 이 채팅창에서 새로 시작한 세션(터미널에 열려 있을 리 없음)
}

export interface ChatFolder {
  name: string;
  path: string;
}

interface RunEvent {
  seq: number;
  kind: Exclude<ChatKind, "user">;
  text: string;
  ts: number;
}

interface RunView {
  run_id: string;
  status: "running" | "done" | "error" | "stopped";
  session_id: string | null;
  cwd: string;
  prompt: string;
  events?: RunEvent[];
}

interface ChatStore {
  target: string | null;
  conversations: Record<string, Conversation>;
  folders: ChatFolder[];
  disabled: string | null; // 서버 스위치가 꺼져 있을 때의 안내
  error: string | null;
  collapsed: boolean;
  confirmed: Record<string, true>; // 터미널과 같이 써도 된다고 한 번 확인받은 세션
  histories: Record<string, ChatMsg[]>; // 터미널·Orca 에서 나눈 지난 대화(저장 안 함, 서버에서 다시 읽음)
  loadHistory: (sessionId: string) => Promise<void>;
  confirm: (sessionId: string) => void;
  setTarget: (key: string) => void;
  setCollapsed: (v: boolean) => void;
  loadFolders: () => Promise<void>;
  send: (prompt: string) => Promise<void>;
  stop: () => Promise<void>;
  attachRunning: (sessionId: string) => Promise<void>;
}

export const isNewKey = (key: string) => key.startsWith("new:");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 진짜 Claude Code 세션 id 인가(직접 추가한 캐릭터는 아님) */
export const isClaudeSessionId = (id: string) => UUID_RE.test(id);

// ---------------------------------------------------------------------------
// 저장(localStorage) — 실패해도 화면은 돌아가야 한다
// ---------------------------------------------------------------------------

function loadSaved(): { target: string | null; conversations: Record<string, Conversation>; collapsed: boolean } {
  const out = { target: null as string | null, conversations: {} as Record<string, Conversation>, collapsed: false };
  if (typeof window === "undefined") return out;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const j = JSON.parse(raw) as { target?: string | null; conversations?: Record<string, Conversation> };
      out.target = j.target ?? null;
      out.conversations = j.conversations ?? {};
    }
    out.collapsed = localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    // 저장소를 못 쓰면 빈 상태로 시작
  }
  return out;
}

function save(target: string | null, conversations: Record<string, Conversation>): void {
  try {
    const kept = Object.values(conversations)
      .sort((a, b) => b.updated - a.updated)
      .slice(0, MAX_CONVS)
      .map((c) => ({ ...c, messages: c.messages.slice(-MAX_MSGS) }));
    localStorage.setItem(STORE_KEY, JSON.stringify({ target, conversations: Object.fromEntries(kept.map((c) => [c.key, c])) }));
  } catch {
    // 용량 초과·사생활 모드 — 이번 화면에서만 유지
  }
}

// ---------------------------------------------------------------------------
// 요청
// ---------------------------------------------------------------------------

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  // 모든 채팅 요청에 붙인다(서버가 GET 도 이 헤더 없으면 거절 — 다른 사이트가 대화를 못 읽게)
  const headers: Record<string, string> = { "X-Pixel-Office": "1" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await apiFetch(`${PATH}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (!r.ok) {
    // 본문은 한 번만 읽는다(json() 실패 뒤 text() 는 이미 소비된 본문이라 못 읽음)
    const raw = await r.text().catch(() => "");
    let detail = raw;
    let code: string | undefined;
    try {
      const d = (JSON.parse(raw) as { detail?: unknown }).detail;
      if (typeof d === "string") detail = d;
      else if (d && typeof d === "object" && "message" in d) {
        detail = String((d as { message: unknown }).message);
        code = (d as { code?: string }).code;
      } else if (d !== undefined) detail = JSON.stringify(d);
    } catch {
      // JSON 이 아니면 원문 그대로
    }
    throw Object.assign(new Error(detail || `요청 실패 (${r.status})`), { status: r.status, code });
  }
  return (await r.json()) as T;
}

type ApiError = Error & { status?: number; code?: string };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
// 서버 스위치가 꺼짐 — 문구가 아니라 code 로 알아본다
const isOff = (e: unknown) => (e as ApiError).code === "chat_off";

// 실행 id → 지금 그 실행이 붙어 있는 대화 키(새 대화가 세션 id 로 옮겨가면 바뀐다)
const runKey = new Map<string, string>();
const polling = new Set<string>();

function emptyConv(key: string, cwd: string | null): Conversation {
  return { key, cwd, messages: [], runId: null, running: false, lastSeq: 0, updated: Date.now() };
}

const saved = loadSaved();

export const useChatStore = create<ChatStore>()((set, get) => {
  const update = (key: string, fn: (c: Conversation) => Conversation) => {
    const { conversations, target } = get();
    const cur = conversations[key] ?? emptyConv(key, null);
    const next = { ...conversations, [key]: { ...fn(cur), updated: Date.now() } };
    set({ conversations: next });
    save(target, next);
  };

  // 새 대화에 세션 id 가 생기면 그 id 아래로 옮긴다
  const moveTo = (oldKey: string, sessionId: string) => {
    const { conversations, target } = get();
    const old = conversations[oldKey];
    if (!old || oldKey === sessionId) return;
    const merged: Conversation = {
      ...old,
      key: sessionId,
      bornHere: true,
      messages: [...(conversations[sessionId]?.messages ?? []), ...old.messages],
    };
    const next = { ...conversations, [sessionId]: merged };
    delete next[oldKey];
    for (const [rid, k] of runKey) if (k === oldKey) runKey.set(rid, sessionId);
    const newTarget = target === oldKey ? sessionId : target;
    set({ conversations: next, target: newTarget });
    save(newTarget, next);
  };

  const poll = async (runId: string) => {
    if (polling.has(runId)) return;
    polling.add(runId);
    let failures = 0;
    try {
      for (;;) {
        const key = runKey.get(runId);
        if (!key) return;
        const after = get().conversations[key]?.lastSeq ?? 0;
        let view: RunView;
        try {
          view = await call<RunView>("GET", `/runs/${runId}?after=${after}`);
        } catch (e) {
          const status = (e as ApiError).status;
          failures += 1;
          // 401·403·404 는 기다려도 안 풀린다 — 바로 멈춘다. 그 밖(끊김 등)은 점점 늦춰 20번까지
          const fatal = status === 401 || status === 403 || status === 404;
          if (fatal || failures >= MAX_POLL_FAILURES) {
            const text =
              status === 401
                ? "토큰이 없어요: 맥에서 office.sh lan url 주소로 다시 여세요"
                : fatal
                  ? errText(e)
                  : `응답을 못 받아 그만 기다려요 (${errText(e)})`;
            update(key, (c) => ({
              ...c,
              running: false,
              messages: [...c.messages, { id: `x:${runId}:${Date.now()}`, kind: "error", text, ts: Date.now() }],
            }));
            if (isOff(e)) set({ disabled: errText(e) });
            runKey.delete(runId);
            return;
          }
          await new Promise((r) => setTimeout(r, Math.min(POLL_MS * 2 ** failures, 15000)));
          continue;
        }
        failures = 0;
        const events = view.events ?? [];
        const done = view.status !== "running";
        update(key, (c) => ({
          ...c,
          cwd: c.cwd ?? view.cwd,
          lastSeq: events.length ? events[events.length - 1].seq : c.lastSeq,
          running: !done,
          runId: done ? null : c.runId,
          messages: [
            ...c.messages,
            ...events.map((ev) => ({ id: `${runId}:${ev.seq}`, kind: ev.kind, text: ev.text, ts: ev.ts })),
          ],
        }));
        if (view.session_id && isNewKey(key)) moveTo(key, view.session_id);
        if (done) {
          runKey.delete(runId);
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } finally {
      polling.delete(runId);
    }
  };

  // 새로고침 뒤: 돌던 실행은 다시 이어 받는다
  queueMicrotask(() => {
    for (const c of Object.values(get().conversations)) {
      if (c.running && c.runId) {
        runKey.set(c.runId, c.key);
        void poll(c.runId);
      }
    }
  });

  return {
    target: saved.target,
    conversations: saved.conversations,
    folders: [],
    disabled: null,
    error: null,
    collapsed: saved.collapsed,
    confirmed: {},
    histories: {},

    loadHistory: async (sessionId) => {
      if (!isClaudeSessionId(sessionId)) return;
      try {
        const h = await call<ChatMsg[]>("GET", `/history?session_id=${encodeURIComponent(sessionId)}`);
        const prev = get().histories[sessionId];
        // 바뀐 게 없으면 다시 그리지 않는다
        if (prev && prev.length === h.length && prev[prev.length - 1]?.id === h[h.length - 1]?.id) return;
        set({ histories: { ...get().histories, [sessionId]: h } });
      } catch {
        // 기록을 못 읽어도 채팅은 된다
      }
    },

    confirm: (sessionId) => set({ confirmed: { ...get().confirmed, [sessionId]: true } }),

    setTarget: (key) => {
      set({ target: key, error: null });
      save(key, get().conversations);
      if (!isNewKey(key)) {
        void get().attachRunning(key);
        void get().loadHistory(key);
      }
    },

    setCollapsed: (v) => {
      set({ collapsed: v });
      try {
        localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
      } catch {
        // 무시
      }
    },

    loadFolders: async () => {
      try {
        const folders = await call<ChatFolder[]>("GET", "/folders");
        set({ folders, disabled: null });
        const { target } = get();
        if (!target && folders.length) set({ target: `new:${folders[0].path}` });
      } catch (e) {
        if (isOff(e)) set({ disabled: errText(e) });
        else set({ error: `폴더 목록을 못 불러왔어요 (${errText(e)})` });
      }
    },

    send: async (prompt) => {
      const key = get().target;
      if (!key || !prompt.trim()) return;
      const conv = get().conversations[key];
      if (conv?.running) return;
      const body = isNewKey(key) ? { prompt, cwd: key.slice(4) } : { prompt, resume_session_id: key };
      set({ error: null });
      update(key, (c) => ({
        ...c,
        cwd: c.cwd ?? (isNewKey(key) ? key.slice(4) : null),
        messages: [...c.messages, { id: `u:${Date.now()}`, kind: "user", text: prompt, ts: Date.now() }],
      }));
      try {
        const view = await call<RunView>("POST", "/runs", body);
        update(key, (c) => ({ ...c, runId: view.run_id, running: true, lastSeq: 0, cwd: view.cwd }));
        runKey.set(view.run_id, key);
        void poll(view.run_id);
      } catch (e) {
        if (isOff(e)) set({ disabled: errText(e) });
        update(key, (c) => ({
          ...c,
          messages: [...c.messages, { id: `e:${Date.now()}`, kind: "error", text: errText(e), ts: Date.now() }],
        }));
      }
    },

    stop: async () => {
      const key = get().target;
      const runId = key ? get().conversations[key]?.runId : null;
      if (!runId) return;
      try {
        await call("POST", `/runs/${runId}/stop`);
      } catch (e) {
        set({ error: errText(e) });
      }
    },

    // 다른 기기에서 시작해 아직 도는 실행이 있으면 이 화면에도 붙인다
    attachRunning: async (sessionId) => {
      if (get().conversations[sessionId]?.running) return;
      try {
        const runs = await call<RunView[]>("GET", `/runs?session_id=${encodeURIComponent(sessionId)}`);
        const live = runs.find((r) => r.status === "running");
        if (!live || runKey.has(live.run_id)) return;
        update(sessionId, (c) => ({
          ...c,
          runId: live.run_id,
          running: true,
          lastSeq: 0,
          messages: [...c.messages, { id: `u:${live.run_id}`, kind: "user", text: live.prompt, ts: Date.now() }],
        }));
        runKey.set(live.run_id, sessionId);
        void poll(live.run_id);
      } catch {
        // 조용히 넘어간다(꺼져 있으면 loadFolders 쪽에서 안내)
      }
    },
  };
});

export interface SkillInfo {
  name: string;
  description: string;
}

/** 쓸 수 있는 /스킬 목록(전역·플러그인 + 세션 폴더의 프로젝트 스킬) */
export function fetchSkills(sessionId?: string | null): Promise<SkillInfo[]> {
  const q = sessionId && isClaudeSessionId(sessionId) ? `?session_id=${encodeURIComponent(sessionId)}` : "";
  return call<SkillInfo[]>("GET", `/skills${q}`);
}

// PeerPopup → 채팅 입력칸. iOS 는 사용자 탭 안에서 바로 focus 해야 키보드가 뜬다.
let inputEl: HTMLTextAreaElement | null = null;
export function registerChatInput(el: HTMLTextAreaElement | null): void {
  inputEl = el;
}

export function focusChatInput(): void {
  const focus = () => {
    if (!inputEl) return;
    inputEl.focus({ preventScroll: true });
    inputEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  focus();
  requestAnimationFrame(focus);
}

export function chatWith(sessionId: string): void {
  const s = useChatStore.getState();
  s.setTarget(sessionId);
  s.setCollapsed(false);
  focusChatInput();
}
