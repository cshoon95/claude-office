#!/usr/bin/env python3
"""내가 직접 관리하는 일 — Claude Code 세션이 아니어도 오피스(Command Center)에 캐릭터로 띄운다.

저장: ~/.claude-office/manual-tasks.json
상태: 진행(작업 중 칸) · 대기(내 차례/막힘 → NEEDS YOU 칸) · 완료(DONE 칸, 소파에서 쉼)

사용:
  task.py add "모으미 출시 준비" [진행|대기|완료] ["메모(말풍선에 보임)"]
  task.py set "모으미 출시 준비" 대기 ["디자인 시안 회신 기다림"]
  task.py done "모으미 출시 준비"          # = set … 완료
  task.py rm "모으미 출시 준비"            # 오피스에서 퇴근
  task.py list
  task.py sync                            # 서버 재시작 뒤 전부 다시 띄우기(office.sh start가 자동 호출)

원리: claude-office 훅 CLI(claude-office-hook)에 가짜 세션 이벤트를 보낸다.
  진행 = session_start + user_prompt_submit(메모가 말풍선) · 대기 = permission_request · 완료 = stop · 삭제 = session_end
"""
from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid

STORE = os.path.expanduser("~/.claude-office/manual-tasks.json")
PROJECTS = os.path.expanduser("~/.claude/projects")
STATUS = {"진행": "doing", "작업": "doing", "doing": "doing", "대기": "waiting", "막힘": "waiting", "waiting": "waiting",
          "완료": "done", "끝": "done", "done": "done", "종료": "ended", "ended": "ended",
          # Command Center 칸 이름으로도 받는다
          "working": "doing", "needs_you": "waiting"}
LABEL = {"doing": "진행", "waiting": "대기", "done": "완료", "ended": "종료"}


def load() -> list[dict]:
    """파일이 없을 때만 빈 목록. 깨진 JSON 은 덮어쓰지 않도록 에러로 끝낸다(할 일 유실 방지)."""
    if not os.path.exists(STORE):
        return []
    with open(STORE, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"{STORE} 형식이 이상해요(목록이 아님)")
    return data


def save(tasks: list[dict]) -> None:
    """임시 파일에 쓰고 바꿔치기(쓰는 도중 다른 프로세스가 반쪽 JSON을 읽지 않게)."""
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(STORE), prefix=".manual-tasks.", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(tasks, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STORE)


def slug(name: str) -> str:
    """프로젝트 이름(캐릭터 이름표). 경로 구분자는 빼서 이름표가 잘리지 않게."""
    clean = name.replace("/", "-").replace("\\", "-")
    return "📌" + "-".join(clean.split())


def hook(event: str, t: dict, **extra) -> None:
    payload = {
        "session_id": t["id"],
        "hook_event_name": event,
        "cwd": os.path.expanduser("~"),
        # 이름표는 transcript 경로의 projects/<이름> 에서 나온다(파일은 없어도 됨)
        "transcript_path": os.path.join(PROJECTS, slug(t["name"]), t["id"] + ".jsonl"),
        **extra,
    }
    try:
        r = subprocess.run(["claude-office-hook", event], input=json.dumps(payload, ensure_ascii=False),
                           text=True, capture_output=True, timeout=20)
    except FileNotFoundError:
        # 저장은 이미 됐다. 화면 반영만 실패 → 서버를 켤 때 sync 로 다시 띄워진다
        print(f"  ! claude-office-hook 을 찾지 못함(PATH) — '{event}' 화면 반영 건너뜀", file=sys.stderr)
        return
    except subprocess.TimeoutExpired:
        print(f"  ! {event} 시간 초과", file=sys.stderr)
        return
    if r.returncode != 0 or "Traceback" in (r.stderr or ""):
        print(f"  ! {event} 실패: {r.stderr.strip()[:200]}", file=sys.stderr)


def push(t: dict) -> None:
    """현재 상태를 오피스에 반영."""
    note = t.get("note") or t["name"]
    hook("session_start", t, source="manual")
    if t["status"] == "doing":
        hook("user_prompt_submit", t, prompt=note)
    elif t["status"] == "waiting":
        hook("user_prompt_submit", t, prompt=note)
        hook("permission_request", t, tool_name="내 확인 필요", tool_input={"note": note})
    elif t["status"] == "done":
        hook("user_prompt_submit", t, prompt=note)
        hook("stop", t, stop_hook_active=False)
    else:  # ended: ENDED 칸으로(잠시 뒤 화면에서 사라짐, 목록에는 남음)
        hook("user_prompt_submit", t, prompt=note)
        hook("stop", t, stop_hook_active=False)
        hook("session_end", t, reason="manual")


def find(tasks: list[dict], name: str) -> dict | None:
    name = " ".join(name.split())
    if not name:
        return None
    for t in tasks:
        if t["name"] == name:
            return t
    hits = [t for t in tasks if name in t["name"]]
    return hits[0] if len(hits) == 1 else None


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 1
    cmd, args = argv[0], argv[1:]
    tasks = load()
    if cmd == "json":
        print(json.dumps(tasks, ensure_ascii=False)); return 0
    if cmd == "add-json":  # add-json 이름 상태 메모
        name, status, note = " ".join(args[0].split()), STATUS.get(args[1], "doing"), (args[2] if len(args) > 2 else "")
        if not name:
            print(json.dumps({"error": "empty name"})); return 2
        t = {"id": str(uuid.uuid4()), "name": name, "status": status, "note": note, "updated": time.strftime("%Y-%m-%d %H:%M")}
        tasks.append(t); save(tasks); push(t); print(json.dumps(t, ensure_ascii=False)); return 0
    if cmd == "set-json":  # set-json ID '{"status":..,"note":..,"name":..}' — 준 키만 바꾼다
        t = next((x for x in tasks if x["id"] == args[0]), None)
        if not t:
            print(json.dumps({"error": "not found"})); return 1
        patch = json.loads(args[1]) if len(args) > 1 else {}
        if "status" in patch:
            if patch["status"] not in LABEL:
                print(json.dumps({"error": "bad status"})); return 2
            t["status"] = patch["status"]
        if "note" in patch:
            t["note"] = str(patch["note"])
        if patch.get("name"):
            t["name"] = " ".join(str(patch["name"]).split())
        t["updated"] = time.strftime("%Y-%m-%d %H:%M"); save(tasks); push(t); print(json.dumps(t, ensure_ascii=False)); return 0
    if cmd in ("set-id", "rm-id"):
        t = next((x for x in tasks if x["id"] == args[0]), None)
        if not t:
            print(json.dumps({"error": "not found"})); return 1
        if cmd == "rm-id":
            hook("session_end", t, reason="manual"); tasks.remove(t); save(tasks); print(json.dumps({"ok": True})); return 0
        # set-id ID 상태 [메모] [이름] — 빈 문자열이면 그대로
        if len(args) > 1 and args[1]: t["status"] = STATUS.get(args[1], t["status"])
        if len(args) > 2 and args[2] != "__KEEP__": t["note"] = args[2]
        if len(args) > 3 and args[3]: t["name"] = args[3]
        t["updated"] = time.strftime("%Y-%m-%d %H:%M"); save(tasks); push(t); print(json.dumps(t, ensure_ascii=False)); return 0
    if cmd == "list":
        if not tasks:
            print("등록된 일이 없어요. task.py add \"이름\" 진행 \"메모\"")
        for t in tasks:
            print(f"- [{LABEL[t['status']]}] {t['name']}" + (f" — {t['note']}" if t.get("note") else ""))
        return 0
    if cmd == "sync":
        for t in tasks:
            push(t)
        print(f"{len(tasks)}개 다시 띄움")
        return 0
    if not args:
        print("이름을 적어 주세요", file=sys.stderr)
        return 1
    name = args[0]
    if cmd == "add":
        if find(tasks, name) and find(tasks, name)["name"] == name:
            cmd = "set"
        else:
            status = STATUS.get(args[1], "doing") if len(args) > 1 else "doing"
            t = {"id": str(uuid.uuid4()), "name": name, "status": status, "note": args[2] if len(args) > 2 else "", "updated": time.strftime("%Y-%m-%d %H:%M")}
            tasks.append(t)
            save(tasks)
            push(t)
            print(f"추가: [{LABEL[status]}] {name}")
            return 0
    t = find(tasks, name)
    if not t:
        print(f"'{name}' 일을 못 찾았어요. task.py list 로 확인", file=sys.stderr)
        return 1
    if cmd in ("set", "add"):
        if len(args) > 1:
            if args[1] not in STATUS:
                print(f"상태는 진행/대기/완료 중 하나: {args[1]}", file=sys.stderr)
                return 1
            t["status"] = STATUS[args[1]]
        if len(args) > 2:
            t["note"] = args[2]
    elif cmd == "done":
        t["status"] = "done"
    elif cmd == "rm":
        hook("session_end", t, reason="manual")
        tasks.remove(t)
        save(tasks)
        print(f"삭제: {t['name']}")
        return 0
    else:
        print(__doc__)
        return 1
    t["updated"] = time.strftime("%Y-%m-%d %H:%M")
    save(tasks)
    push(t)
    print(f"[{LABEL[t['status']]}] {t['name']}" + (f" — {t['note']}" if t.get("note") else ""))
    return 0


def locked_main(argv: list[str]) -> int:
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    with open(STORE + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return main(argv)


if __name__ == "__main__":
    sys.exit(locked_main(sys.argv[1:]))
