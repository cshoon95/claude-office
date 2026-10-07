"""(로컬 커스텀) 휴대폰에서 Claude 에게 말 걸기 — Command Center 아래 채팅 패널.

맥에서 Claude Code 를 헤드리스(`claude -p … --output-format stream-json`)로 돌리고,
나오는 줄들을 간단한 이벤트로 바꿔 메모리에 쌓는다. 화면은 1초마다 가져간다.
- 새 대화: 허용 폴더(~/orca/projects, ~/src 바로 아래 폴더)에서만 시작
- 이어서: 사무실 DB 의 세션(id = Claude 세션 UUID)을 `--resume` 으로
- 권한: bypassPermissions(사용자가 직접 고른 설정). 그래서 켜고 끄는 스위치가 있다:
  ~/.claude-office/chat 파일이 있을 때만 동작한다.
헤드리스 Claude 도 훅이 돌므로 캐릭터는 저절로 나타나고 움직인다.
"""

import asyncio
import contextlib
import glob
import json
import os
import shutil
import signal
import time
import uuid
from collections import OrderedDict
from collections.abc import Coroutine
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, cast
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.database import get_db
from app.db.models import SessionRecord

OFF_MSG = "휴대폰 명령이 꺼져 있어요 (~/.claude-office/chat)"
MAX_RUNS_KEPT = 30
MAX_CONCURRENT = 3
MAX_EVENTS = 2000
MAX_ERRORS = 200  # 오류(stderr 포함)는 따로 센다
MAX_BYTES = 2 * 1024 * 1024  # 실행 하나에 쌓는 글자 총량
OMITTED = "출력이 너무 많아 생략"
RUN_TIMEOUT_S = 30 * 60
STOP_GRACE_S = 3
TEXT_MAX = 20000
TOOL_MAX = 200
RESULT_MAX = 300
ERROR_MAX = 1000
# 스트림 한 줄(도구 결과 포함)이 길 수 있다 — 기본 64KB 로는 readline 이 터진다
STREAM_LIMIT = 64 * 1024 * 1024


def _flag_path() -> Path:
    return Path(os.environ.get("CLAUDE_OFFICE_CHAT_FLAG") or Path.home() / ".claude-office/chat")


def _roots() -> list[Path]:
    """허용 폴더의 뿌리. 테스트는 CLAUDE_OFFICE_CHAT_ROOTS(os.pathsep 구분)로 바꾼다."""
    raw = os.environ.get("CLAUDE_OFFICE_CHAT_ROOTS")
    if raw:
        return [Path(p).expanduser() for p in raw.split(os.pathsep) if p]
    return [Path.home() / "orca/projects", Path.home() / "src"]


def _folders() -> list[dict[str, str]]:
    """뿌리 바로 아래 폴더만(숨김 제외). 자유 입력 경로는 받지 않는다."""
    out: list[dict[str, str]] = []
    for root in _roots():
        try:
            children = sorted(root.iterdir(), key=lambda p: p.name)
        except OSError:
            continue
        for p in children:
            if p.name.startswith(".") or not p.is_dir():
                continue
            out.append({"name": f"{root.name}/{p.name}", "path": str(p)})
    return out


async def _guard(request: Request) -> None:
    """스위치가 꺼져 있으면 전부 거절. GET 포함 모든 요청에 CSRF·읽기 방어:
    X-Pixel-Office 헤더(교차 출처면 preflight 강제) + Origin 이 있으면 Host 와 같거나
    개발용 CORS 허용 목록(make dev 의 :3000)에 있어야 한다."""
    if not _flag_path().exists():
        raise HTTPException(status_code=403, detail=OFF_MSG)
    if request.headers.get("x-pixel-office") != "1":
        raise HTTPException(status_code=403, detail="X-Pixel-Office 헤더가 필요해요")
    origin = request.headers.get("origin")
    if origin is not None:
        host = (request.headers.get("host") or "").lower()
        same = urlparse(origin).netloc.lower() == host
        if not same and origin.rstrip("/") not in get_settings().BACKEND_CORS_ORIGINS:
            raise HTTPException(status_code=403, detail="다른 사이트에서 온 요청은 받지 않아요")


router = APIRouter(prefix="/chat", tags=["chat"], dependencies=[Depends(_guard)])


# ---------------------------------------------------------------------------
# claude 실행 파일·환경
# ---------------------------------------------------------------------------


def _ver_key(p: str) -> tuple[int, ...]:
    name = Path(p).parents[1].name.lstrip("v")  # ~/.nvm/versions/node/v20.19.0/bin/claude
    try:
        return tuple(int(x) for x in name.split("."))
    except ValueError:
        return (0,)


def _claude_bin() -> str | None:
    """서버는 nvm 없는 PATH 로 떠 있을 수 있어서 여러 곳을 찾아본다."""
    env_bin = os.environ.get("CLAUDE_OFFICE_CLAUDE_BIN")
    if env_bin:
        return env_bin if os.access(env_bin, os.X_OK) else None
    found = shutil.which("claude")
    if found:
        return found
    home = Path.home()
    nvm = sorted(glob.glob(str(home / ".nvm/versions/node/*/bin/claude")), key=_ver_key)
    for c in [*reversed(nvm), str(home / ".local/bin/claude"), "/opt/homebrew/bin/claude"]:
        if os.access(c, os.X_OK):
            return c
    return None


def _child_env(bin_path: str) -> dict[str, str]:
    """LAN 토큰은 빼고, claude(node 스크립트) 옆 폴더를 PATH 맨 앞에.
    CLAUDE_OFFICE_API_KEY 는 남긴다 — 헤드리스 claude 의 훅이 사무실로 이벤트를 보낼 때 쓴다."""
    env = dict(os.environ)
    env.pop("CLAUDE_OFFICE_LAN_TOKEN", None)
    # 서버가 Claude Code 안에서 켜졌으면 중첩 실행으로 막힐 수 있다
    env.pop("CLAUDECODE", None)
    env.pop("CLAUDE_CODE_ENTRYPOINT", None)
    # 서버의 uv 가상환경이 작업 폴더의 python 을 가리지 않게
    venv = env.pop("VIRTUAL_ENV", None)
    parts = [p for p in env.get("PATH", "").split(os.pathsep) if p]
    if venv:
        parts = [p for p in parts if p != str(Path(venv) / "bin")]
    bin_dir = str(Path(bin_path).parent)
    env["PATH"] = os.pathsep.join([bin_dir, *[p for p in parts if p != bin_dir]])
    return env


def _transcript_cwd(session_id: str) -> str | None:
    """~/.claude/projects/*/<세션>.jsonl 에서 처음 나오는 cwd. --resume 은 그 폴더에서 해야 한다."""
    base = Path(os.environ.get("CLAUDE_OFFICE_CLAUDE_PROJECTS") or Path.home() / ".claude/projects")
    files = sorted(
        glob.glob(str(base / "*" / f"{session_id}.jsonl")),
        key=lambda f: os.path.getmtime(f),
        reverse=True,
    )
    for f in files:
        try:
            with open(f, encoding="utf-8", errors="replace") as fh:
                for i, line in enumerate(fh):
                    if i >= 2000:
                        break
                    if '"cwd"' not in line:
                        continue
                    try:
                        cwd = _obj(json.loads(line)).get("cwd")
                    except json.JSONDecodeError:
                        continue
                    if isinstance(cwd, str) and cwd:
                        return cwd
        except OSError:
            continue
    return None


# ---------------------------------------------------------------------------
# 실행 기록(메모리)
# ---------------------------------------------------------------------------


@dataclass
class Run:
    id: str
    key: str  # "session:<id>" | "new:<path>" — 같은 대상에 동시에 두 번 못 돌게
    cwd: str
    prompt: str
    resume_session_id: str | None
    session_id: str | None = None
    status: str = "running"  # running | done | error | stopped
    started_at: float = field(default_factory=time.time)
    ended_at: float | None = None
    events: list[dict[str, Any]] = field(default_factory=lambda: [])
    proc: asyncio.subprocess.Process | None = None
    stopping: bool = False
    had_error: bool = False
    task: asyncio.Task[None] | None = None
    n_errors: int = 0
    n_bytes: int = 0
    omitted: bool = False

    def add(self, kind: str, text: str, limit: int, force: bool = False) -> None:
        """이벤트 추가. 개수(일반·오류 따로)·총량을 넘으면 '생략' 한 줄만 남기고 버린다.
        force 는 실행 끝맺음 표시(멈춤·종료 코드 등, 실행당 몇 개뿐)에만 쓴다."""
        if len(text) > limit:
            text = text[:limit] + "…"
        size = len(text.encode())
        if not force:
            over = (
                self.n_bytes + size > MAX_BYTES
                or (kind == "error" and self.n_errors >= MAX_ERRORS)
                or (kind != "error" and len(self.events) - self.n_errors >= MAX_EVENTS)
            )
            if over:
                if not self.omitted:
                    self.omitted = True
                    self._append("error", OMITTED)
                return
            self.n_bytes += size
            if kind == "error":
                self.n_errors += 1
        self._append(kind, text)

    def _append(self, kind: str, text: str) -> None:
        self.events.append(
            {"seq": len(self.events) + 1, "kind": kind, "text": text, "ts": int(time.time() * 1000)}
        )

    def summary(self) -> dict[str, Any]:
        last = next((e["text"] for e in reversed(self.events) if e["kind"] == "text"), "")
        return {
            "run_id": self.id,
            "status": self.status,
            "session_id": self.session_id,
            "resume_session_id": self.resume_session_id,
            "cwd": self.cwd,
            "prompt": self.prompt,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "event_count": len(self.events),
            "last_text": last[:200],
        }


_runs: "OrderedDict[str, Run]" = OrderedDict()
_bg: set[asyncio.Task[None]] = set()  # 3초 뒤 강제 종료 확인 작업(GC 로 사라지지 않게)


def _prune() -> None:
    """끝난 실행만 오래된 순으로 지워 최근 30개를 남긴다."""
    for rid in list(_runs):
        if len(_runs) <= MAX_RUNS_KEPT:
            break
        if _runs[rid].status != "running":
            del _runs[rid]


def _running() -> list[Run]:
    return [r for r in _runs.values() if r.status == "running"]


# ---------------------------------------------------------------------------
# stream-json → 간단한 이벤트
# ---------------------------------------------------------------------------


def _obj(x: Any) -> dict[str, Any]:
    return cast(dict[str, Any], x) if isinstance(x, dict) else {}


def _items(x: Any) -> list[dict[str, Any]]:
    return [_obj(c) for c in cast(list[Any], x)] if isinstance(x, list) else []


def _tool_summary(name: str, raw_input: Any) -> str:
    inp = _obj(raw_input)
    if name == "Bash" and inp.get("command"):
        return f"Bash: {str(inp['command'])[:TOOL_MAX]}"
    for k in ("file_path", "notebook_path", "path", "pattern", "url", "query", "description"):
        if inp.get(k):
            return f"{name}: {str(inp[k])[:TOOL_MAX]}"
    compact = json.dumps(inp, ensure_ascii=False, separators=(",", ":"))
    return f"{name}: {compact[:TOOL_MAX]}" if inp else name


def _result_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    texts = [str(c.get("text", "")) for c in _items(content) if c.get("type") == "text"]
    return "\n".join(texts).strip() or "(결과)"


def _handle_line(run: Run, raw: str) -> None:
    raw = raw.strip()
    if not raw:
        return
    try:
        d = _obj(json.loads(raw))
    except json.JSONDecodeError:
        run.add("error", raw, ERROR_MAX)
        return
    t = d.get("type")
    if t == "system" and d.get("subtype") == "init":
        if d.get("session_id"):
            run.session_id = str(d["session_id"])
        run.add("status", "세션 시작", 100)
    elif t == "assistant":
        for c in _items(_obj(d.get("message")).get("content")):
            if c.get("type") == "text" and str(c.get("text", "")).strip():
                run.add("text", str(c["text"]), TEXT_MAX)
            elif c.get("type") == "tool_use":
                summary = _tool_summary(str(c.get("name", "?")), c.get("input"))
                run.add("tool", summary, TOOL_MAX + 40)
    elif t == "user":
        for c in _items(_obj(d.get("message")).get("content")):
            if c.get("type") == "tool_result":
                text = _result_text(c.get("content"))
                run.add("tool_result", ("⚠ " if c.get("is_error") else "") + text, RESULT_MAX)
    elif t == "result":
        if d.get("session_id"):
            run.session_id = run.session_id or str(d["session_id"])
        parts = ["완료" if not d.get("is_error") else "실패"]
        dur, turns, cost = d.get("duration_ms"), d.get("num_turns"), d.get("total_cost_usd")
        if isinstance(dur, (int, float)):
            parts.append(f"{dur / 1000:.1f}초")
        if isinstance(turns, int):
            parts.append(f"{turns}턴")
        if isinstance(cost, (int, float)):
            parts.append(f"${cost:.4f}")
        run.add("result", " · ".join(parts), 200)
        if d.get("is_error"):
            run.had_error = True
            run.add("error", str(d.get("result") or d.get("subtype") or "실패"), ERROR_MAX)


def _signal_group(proc: asyncio.subprocess.Process, sig: int) -> None:
    """새 세션(start_new_session)으로 띄웠으니 pgid == pid. Bash 도구가 띄운 손자까지 함께."""
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, sig)


async def _terminate(proc: asyncio.subprocess.Process) -> None:
    """SIGTERM → 3초 기다렸다가 그룹 전체 SIGKILL(남은 손자 정리 포함)."""
    _signal_group(proc, signal.SIGTERM)
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(proc.wait(), STOP_GRACE_S)
    _signal_group(proc, signal.SIGKILL)


async def shutdown_runs() -> None:
    """서버가 꺼질 때 돌던 claude 들을 그룹째 정리(main.py lifespan)."""
    procs = [r.proc for r in _running() if r.proc is not None]
    for r in _running():
        r.stopping = True
    await asyncio.gather(*(_terminate(p) for p in procs), return_exceptions=True)


async def _drive(run: Run) -> None:
    proc = run.proc
    assert proc is not None and proc.stdout is not None and proc.stderr is not None
    out, err = proc.stdout, proc.stderr

    async def read_out() -> None:
        while line := await out.readline():
            _handle_line(run, line.decode(errors="replace"))

    async def read_err() -> None:
        while line := await err.readline():
            text = line.decode(errors="replace").strip()
            if text:
                run.add("error", text, ERROR_MAX)

    try:
        await asyncio.wait_for(asyncio.gather(read_out(), read_err(), proc.wait()), RUN_TIMEOUT_S)
    except TimeoutError:
        await _terminate(proc)
        run.add("error", "30분이 지나 멈췄어요", ERROR_MAX, force=True)
        run.had_error = True
    except Exception as e:  # 읽기 실패해도 실행 기록은 끝맺는다
        await _terminate(proc)
        run.add("error", f"읽기 실패: {e}", ERROR_MAX, force=True)
        run.had_error = True
    finally:
        if run.stopping:
            run.status = "stopped"
            run.add("status", "멈춤", 100, force=True)
        elif run.had_error or proc.returncode not in (0, None):
            run.status = "error"
            if proc.returncode not in (0, None) and not run.had_error:
                msg = f"claude 가 종료 코드 {proc.returncode} 로 끝났어요"
                run.add("error", msg, 200, force=True)
        else:
            run.status = "done"
        run.ended_at = time.time()
        run.proc = None


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


class RunCreate(BaseModel):
    prompt: str = Field(min_length=1, max_length=8000)
    cwd: str | None = None
    resume_session_id: str | None = None

    @model_validator(mode="after")
    def _one_target(self) -> "RunCreate":
        if bool(self.cwd) == bool(self.resume_session_id):
            raise ValueError("cwd 와 resume_session_id 중 하나만 주세요")
        if not self.prompt.strip():
            raise ValueError("내용이 비어 있어요")
        return self


@router.get("/folders")
async def list_folders() -> list[dict[str, str]]:
    return _folders()


@router.post("/runs")
async def create_run(
    body: RunCreate, db: Annotated[AsyncSession, Depends(get_db)]
) -> dict[str, Any]:
    resume: str | None = None
    if body.resume_session_id:
        try:
            resume = str(uuid.UUID(body.resume_session_id))
        except ValueError:
            raise HTTPException(status_code=422, detail="세션 id 형식이 아니에요") from None
        rec = await db.get(SessionRecord, resume)
        if rec is None:
            raise HTTPException(status_code=404, detail="그 세션을 찾지 못했어요")
        # project_root 는 git 루트(또는 없음)라 실제 작업 폴더와 다를 수 있다 — 대화 기록의 cwd 우선
        real = _transcript_cwd(resume) or rec.project_root
        try:
            resolved = Path(real).expanduser().resolve() if real else None
        except OSError:
            resolved = None
        home = Path.home().resolve()
        if resolved is None or not resolved.is_dir() or not resolved.is_relative_to(home):
            raise HTTPException(status_code=400, detail="세션 폴더가 없거나 홈 폴더 밖이에요")
        cwd, key = str(resolved), f"session:{resume}"
        busy = any(r.key == key or r.session_id == resume for r in _running())
    else:
        want = Path(body.cwd or "").expanduser()
        allowed = {str(Path(f["path"]).resolve()): f["path"] for f in _folders()}
        try:
            match = allowed.get(str(want.resolve()))
        except OSError:
            match = None
        if match is None:
            raise HTTPException(status_code=400, detail="허용된 폴더가 아니에요")
        cwd, key = match, f"new:{str(Path(match).resolve())}"
        busy = any(r.key == key for r in _running())
    if busy:
        raise HTTPException(status_code=409, detail="이 대상은 이미 작업 중이에요")
    if len(_running()) >= MAX_CONCURRENT:
        raise HTTPException(
            status_code=429, detail=f"동시에 {MAX_CONCURRENT}개까지만 돌릴 수 있어요"
        )

    bin_path = _claude_bin()
    if not bin_path:
        raise HTTPException(status_code=500, detail="claude 실행 파일을 찾지 못했어요")
    # 프롬프트는 stdin 으로 — "-" 로 시작해도 옵션으로 읽히지 않게
    args = [
        bin_path,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
    ]
    if resume:
        args += ["--resume", resume]

    # 띄우기(await) 전에 먼저 등록해 둔다 — 그 사이 들어온 요청도 바쁨·동시 개수에 걸리게
    run = Run(id=uuid.uuid4().hex, key=key, cwd=cwd, prompt=body.prompt, resume_session_id=resume)
    _runs[run.id] = run
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=cwd,
            env=_child_env(bin_path),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=STREAM_LIMIT,
            start_new_session=True,  # 멈출 때 그룹째(손자 프로세스까지) 끄려고
        )
    except OSError as e:
        del _runs[run.id]
        raise HTTPException(status_code=500, detail=f"claude 실행 실패: {e}") from None
    run.proc = proc
    _prune()
    run.task = asyncio.create_task(_drive(run))
    assert proc.stdin is not None
    with contextlib.suppress(BrokenPipeError, ConnectionResetError):
        proc.stdin.write(body.prompt.encode())
        await proc.stdin.drain()
    proc.stdin.close()
    if run.stopping:  # 띄우는 사이에 멈춤을 눌렀다
        _spawn_bg(_terminate(proc))
    return run.summary()


@router.get("/runs")
async def list_runs(session_id: str | None = None) -> list[dict[str, Any]]:
    runs = reversed(_runs.values())
    if session_id:
        runs = (r for r in runs if session_id in (r.session_id, r.resume_session_id))
    return [r.summary() for r in runs]


@router.get("/runs/{run_id}")
async def get_run(run_id: str, after: int = 0) -> dict[str, Any]:
    run = _runs.get(run_id)
    if run is None:
        raise HTTPException(
            status_code=404, detail="그 실행 기록이 없어요(서버가 다시 켜졌을 수 있어요)"
        )
    return {**run.summary(), "events": [e for e in run.events if e["seq"] > after]}


@router.post("/runs/{run_id}/stop")
async def stop_run(run_id: str) -> dict[str, Any]:
    run = _runs.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="그 실행 기록이 없어요")
    if run.status == "running" and not run.stopping:
        run.stopping = True
        if run.proc is not None:
            _spawn_bg(_terminate(run.proc))
    return run.summary()


def _spawn_bg(coro: Coroutine[Any, Any, None]) -> None:
    t = asyncio.create_task(coro)
    _bg.add(t)
    t.add_done_callback(_bg.discard)
