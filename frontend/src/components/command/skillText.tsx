// (로컬 커스텀) 채팅 글 속 /스킬 을 알아보고 칩으로 보여 주기
import type { ReactNode } from "react";

// 앞이 줄 처음·공백·괄호이고, 뒤에 / 가 이어지지 않는 것만(/Users/... 같은 경로 제외)
const SKILL_RE = /(^|[\s(（])\/([A-Za-z0-9][\w.:-]*)(?![\w/])/g;

// Claude Code 내장 명령 — 스킬은 아니지만 명령이니 따로 표시
const BUILTIN = new Set([
  "clear", "compact", "help", "model", "cost", "context", "init", "review", "status",
  "config", "memory", "resume", "remote-control", "agents", "mcp", "hooks", "permissions",
]);

export type SkillState = "skill" | "builtin" | "unknown";

export interface TextPart {
  text: string;
  skill?: { name: string; state: SkillState };
}

export function skillState(name: string, known: Set<string> | null): SkillState {
  if (BUILTIN.has(name)) return "builtin";
  // 목록을 아직 못 받았으면 일단 스킬로 본다
  if (!known || known.has(name)) return "skill";
  // "ghost" 처럼 플러그인 접두사 없이 써도 하나만 맞으면 스킬
  for (const k of known) if (k.endsWith(`:${name}`)) return "skill";
  return "unknown";
}

export function splitSkills(text: string, known: Set<string> | null): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(SKILL_RE)) {
    const start = (m.index ?? 0) + m[1].length;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: `/${m[2]}`, skill: { name: m[2], state: skillState(m[2], known) } });
    last = start + m[2].length + 1;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function usedSkills(text: string, known: Set<string> | null): TextPart["skill"][] {
  const seen = new Map<string, TextPart["skill"]>();
  for (const p of splitSkills(text, known)) if (p.skill) seen.set(p.skill.name, p.skill);
  return [...seen.values()];
}

const CHIP: Record<SkillState, string> = {
  skill: "bg-violet-500/25 text-violet-100 ring-1 ring-violet-400/60",
  builtin: "bg-sky-400/20 text-sky-100 ring-1 ring-sky-300/50",
  unknown: "bg-amber-500/20 text-amber-100 ring-1 ring-amber-400/60",
};
const ICON: Record<SkillState, string> = { skill: "⚡", builtin: "⌘", unknown: "?" };

export function SkillChip({ name, state }: { name: string; state: SkillState }): ReactNode {
  return (
    <span
      className={`mx-0.5 inline-flex items-center gap-0.5 rounded px-1 font-mono text-[0.9em] font-semibold ${CHIP[state]}`}
      title={state === "unknown" ? "설치된 스킬 목록에 없어요" : state === "builtin" ? "Claude Code 내장 명령" : "스킬"}
    >
      <span className="text-[0.8em]">{ICON[state]}</span>/{name}
    </span>
  );
}

/** 말풍선 안 글 — /스킬 은 칩으로 */
export function RichText({ text, known }: { text: string; known: Set<string> | null }): ReactNode {
  return splitSkills(text, known).map((p, i) =>
    p.skill ? <SkillChip key={i} name={p.skill.name} state={p.skill.state} /> : <span key={i}>{p.text}</span>,
  );
}

/** 입력칸 뒤에 깔아 /스킬 부분만 배경색을 칠한다(글자는 textarea 가 그린다) */
export function HighlightLayer({ text, known }: { text: string; known: Set<string> | null }): ReactNode {
  const BG: Record<SkillState, string> = {
    skill: "bg-violet-500/40",
    builtin: "bg-sky-400/30",
    unknown: "bg-amber-500/35",
  };
  return (
    <>
      {splitSkills(text, known).map((p, i) =>
        p.skill ? (
          <mark key={i} className={`rounded-sm text-transparent ${BG[p.skill.state]}`}>
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
      {"​"}
    </>
  );
}

/** 도구 줄 "Skill: {"skill":"x",...}" → 스킬 이름 */
export function skillFromTool(summary: string): string | null {
  if (!summary.startsWith("Skill:")) return null;
  const rest = summary.slice(6).trim();
  try {
    const j = JSON.parse(rest) as { skill?: unknown };
    if (typeof j.skill === "string") return j.skill;
  } catch {
    // JSON 이 아니면 그대로 이름
  }
  return rest.split(/\s/)[0] || null;
}
