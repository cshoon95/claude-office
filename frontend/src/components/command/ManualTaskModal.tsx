"use client";

// (로컬 커스텀) 캐릭터 추가 모달 — 이름·메모·처음 놓을 칸을 직접 입력
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ZONE_BY_KEY, ZONE_ORDER, type ZoneKey } from "./layout";
import { manualApi } from "./manualApi";

const ZONE_KO: Record<ZoneKey, string> = { needs_you: "내 차례", working: "작업 중", done: "완료", ended: "종료" };
export { ZONE_KO };

export function ManualTaskModal({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [bucket, setBucket] = useState<ZoneKey>("working");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });

  // 입력값 초기화는 부모가 열 때마다 새로 마운트(key)해서 처리한다 — 여기선 포커스·Esc 만
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => nameRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => { clearTimeout(timer); window.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError("이름을 적어 주세요"); return; }
    setBusy(true); setError("");
    try {
      await manualApi.create(name.trim(), note.trim(), bucket);
      onClose();
    } catch (err) {
      setError(`추가하지 못했어요: ${String(err).slice(0, 120)}`);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[95] bg-black/60 flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form onSubmit={submit} className="w-full max-w-sm bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl p-5 space-y-4" role="dialog" aria-label="캐릭터 추가">
        <div>
          <h2 className="text-white font-bold text-base">캐릭터 추가</h2>
          <p className="text-neutral-400 text-xs mt-1">Claude Code가 아니어도, 내가 붙잡고 있는 일을 사무실에 띄워요.</p>
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-neutral-300">이름</span>
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="예: 모으미 출시 준비"
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-sky-500" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-neutral-300">메모 (말풍선에 보여요, 선택)</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} rows={2} placeholder="예: 스토어 스크린샷 정리"
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-sky-500 resize-none" />
        </label>
        <fieldset className="space-y-1">
          <legend className="text-xs text-neutral-300 mb-1">어느 칸에 둘까요</legend>
          <div className="grid grid-cols-2 gap-2">
            {ZONE_ORDER.map((k) => {
              const z = ZONE_BY_KEY[k];
              const on = bucket === k;
              return (
                <button type="button" key={k} onClick={() => setBucket(k)} aria-pressed={on}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold border transition-colors ${on ? "text-white" : "text-neutral-300 border-neutral-700 hover:border-neutral-500"}`}
                  style={on ? { borderColor: z.cssColor, backgroundColor: `${z.cssColor}33` } : undefined}>
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: z.cssColor }} />
                  {ZONE_KO[k]}
                </button>
              );
            })}
          </div>
        </fieldset>
        {error && <p className="text-rose-400 text-xs">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="flex-1 py-2 rounded-lg text-xs font-bold text-neutral-300 bg-neutral-800 hover:bg-neutral-700">취소</button>
          <button type="submit" disabled={busy} className="flex-1 py-2 rounded-lg text-xs font-bold text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-50">{busy ? "추가 중…" : "사무실에 추가"}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
