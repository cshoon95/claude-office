"""(로컬 커스텀) 휴대폰 채팅(/api/v1/chat) 테스트 — 진짜 claude 대신 가짜 스크립트를 돌린다."""

import asyncio
import json
import os
import signal
import sys
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import pytest_asyncio

from app.api.routes import chat
from app.db.database import get_db
from app.db.models import SessionRecord
from app.main import app

H = {"X-Pixel-Office": "1"}

FAKE_OK = """
import json, os, sys
open(os.environ["FAKE_ARGS_OUT"], "w").write(json.dumps({
    "argv": sys.argv[1:], "cwd": os.getcwd(), "stdin": sys.stdin.read(),
    "has_token": "CLAUDE_OFFICE_LAN_TOKEN" in os.environ,
}))
lines = [
    {"type": "system", "subtype": "init", "session_id": "11111111-2222-3333-4444-555555555555"},
    {"type": "assistant", "message": {"content": [{"type": "text", "text": "안녕\\n둘째 줄"}]}},
    {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Bash", "input": {"command": "ls -la"}}]}},
    {"type": "user", "message": {"content": [
        {"type": "tool_result", "content": "x" * 1000}]}},
    {"type": "result", "subtype": "success", "is_error": False, "duration_ms": 1234,
     "num_turns": 2, "total_cost_usd": 0.0123, "result": "안녕"},
]
for d in lines:
    print(json.dumps(d), flush=True)
print("경고 한 줄", file=sys.stderr, flush=True)
"""

FAKE_SLOW = """
import json, sys, time
sys.stdin.read()
print(json.dumps({"type": "system", "subtype": "init", "session_id": "s"}), flush=True)
time.sleep(30)
"""


def _script(tmp: Path, body: str) -> str:
    p = tmp / "fake-claude"
    p.write_text(f"#!{sys.executable}\n{body}")
    p.chmod(0o755)
    return str(p)


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    (home / "projects" / "alpha").mkdir(parents=True)
    (home / "projects" / ".hidden").mkdir()
    (home / "projects" / "file.txt").write_text("x")
    (home / "src" / "beta").mkdir(parents=True)
    flag = home / "chat-flag"
    flag.write_text("")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CLAUDE_OFFICE_CHAT_FLAG", str(flag))
    monkeypatch.setenv("CLAUDE_OFFICE_CHAT_ROOTS", f"{home / 'projects'}:{home / 'src'}")
    monkeypatch.setenv("CLAUDE_OFFICE_CLAUDE_BIN", _script(tmp_path, FAKE_OK))
    monkeypatch.setenv("FAKE_ARGS_OUT", str(tmp_path / "args.json"))
    monkeypatch.setenv("CLAUDE_OFFICE_LAN_TOKEN", "secret")
    chat._runs.clear()  # pyright: ignore[reportPrivateUsage]
    return home


@pytest_asyncio.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def _wait(client: httpx.AsyncClient, run_id: str) -> dict[str, Any]:
    for _ in range(100):
        r = await client.get(f"/api/v1/chat/runs/{run_id}", headers=H)
        body = r.json()
        if body["status"] != "running":
            return body
        await asyncio.sleep(0.1)
    raise AssertionError("run did not finish")


async def test_kill_switch_off(env: Path, client: httpx.AsyncClient) -> None:
    (env / "chat-flag").unlink()
    r = await client.get("/api/v1/chat/folders", headers=H)
    assert r.status_code == 403
    assert "꺼져" in r.json()["detail"]
    r = await client.post("/api/v1/chat/runs", json={"prompt": "hi"}, headers=H)
    assert r.status_code == 403


async def test_folders_allowlist(env: Path, client: httpx.AsyncClient) -> None:
    r = await client.get("/api/v1/chat/folders", headers=H)
    assert r.status_code == 200
    assert [f["name"] for f in r.json()] == ["projects/alpha", "src/beta"]


async def test_csrf_header_and_origin(env: Path, client: httpx.AsyncClient) -> None:
    body = {"prompt": "hi", "cwd": str(env / "projects" / "alpha")}
    r = await client.post("/api/v1/chat/runs", json=body)
    assert r.status_code == 403
    r = await client.post(
        "/api/v1/chat/runs", json=body, headers={**H, "Origin": "http://evil.example"}
    )
    assert r.status_code == 403


async def test_target_validation(env: Path, client: httpx.AsyncClient) -> None:
    url = "/api/v1/chat/runs"
    r = await client.post(url, json={"prompt": "hi", "cwd": str(env)}, headers=H)
    assert r.status_code == 400
    r = await client.post(url, json={"prompt": "hi", "cwd": "/etc"}, headers=H)
    assert r.status_code == 400
    r = await client.post(url, json={"prompt": "hi"}, headers=H)
    assert r.status_code == 422
    both = {"prompt": "hi", "cwd": str(env / "projects" / "alpha"), "resume_session_id": "x"}
    r = await client.post(url, json=both, headers=H)
    assert r.status_code == 422
    r = await client.post(url, json={"prompt": "hi", "resume_session_id": "nope"}, headers=H)
    assert r.status_code == 422
    unknown = {"prompt": "hi", "resume_session_id": str(uuid.uuid4())}
    r = await client.post(url, json=unknown, headers=H)
    assert r.status_code == 404


async def test_happy_path_new_folder(env: Path, tmp_path: Path, client: httpx.AsyncClient) -> None:
    cwd = env / "projects" / "alpha"
    r = await client.post(
        "/api/v1/chat/runs",
        json={"prompt": "안녕", "cwd": str(cwd)},
        headers={**H, "Origin": "http://test"},
    )
    assert r.status_code == 200, r.text
    run_id = r.json()["run_id"]
    body = await _wait(client, run_id)
    assert body["status"] == "done"
    assert body["session_id"] == "11111111-2222-3333-4444-555555555555"
    kinds = [e["kind"] for e in body["events"]]
    assert kinds[:5] == ["status", "text", "tool", "tool_result", "result"]
    assert "error" in kinds  # stderr 줄
    ev = {e["kind"]: e["text"] for e in body["events"]}
    assert ev["text"] == "안녕\n둘째 줄"
    assert ev["tool"] == "Bash: ls -la"
    assert len(ev["tool_result"]) <= chat.RESULT_MAX + 1
    assert "1.2초" in ev["result"] and "$0.0123" in ev["result"]

    args = json.loads((tmp_path / "args.json").read_text())
    assert args["argv"][0] == "-p" and "안녕" not in args["argv"]
    assert args["stdin"] == "안녕"
    assert "bypassPermissions" in args["argv"] and "--resume" not in args["argv"]
    assert Path(args["cwd"]).resolve() == cwd.resolve()
    assert args["has_token"] is False

    # after= 로 이어 받기
    r = await client.get(f"/api/v1/chat/runs/{run_id}", params={"after": 3}, headers=H)
    assert [e["seq"] for e in r.json()["events"]][0] == 4
    # 세션별 목록
    r = await client.get("/api/v1/chat/runs", params={"session_id": body["session_id"]}, headers=H)
    assert [x["run_id"] for x in r.json()] == [run_id]


async def test_resume_session(env: Path, tmp_path: Path, client: httpx.AsyncClient) -> None:
    sid = str(uuid.uuid4())
    proj = env / "src" / "beta"
    async for db in get_db():
        db.add(SessionRecord(id=sid, project_root=str(proj)))
        await db.commit()
    r = await client.post(
        "/api/v1/chat/runs", json={"prompt": "계속", "resume_session_id": sid}, headers=H
    )
    assert r.status_code == 200, r.text
    body = await _wait(client, r.json()["run_id"])
    assert body["status"] == "done"
    args = json.loads((tmp_path / "args.json").read_text())
    assert args["argv"][-2:] == ["--resume", sid]
    assert Path(args["cwd"]).resolve() == proj.resolve()


async def test_resume_outside_home_rejected(env: Path, client: httpx.AsyncClient) -> None:
    sid = str(uuid.uuid4())
    async for db in get_db():
        db.add(SessionRecord(id=sid, project_root="/tmp"))
        await db.commit()
    r = await client.post(
        "/api/v1/chat/runs", json={"prompt": "x", "resume_session_id": sid}, headers=H
    )
    assert r.status_code == 400


async def test_stop_and_busy(
    env: Path, tmp_path: Path, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CLAUDE_OFFICE_CLAUDE_BIN", _script(tmp_path, FAKE_SLOW))
    body = {"prompt": "x", "cwd": str(env / "projects" / "alpha")}
    r = await client.post("/api/v1/chat/runs", json=body, headers=H)
    assert r.status_code == 200
    run_id = r.json()["run_id"]
    # 같은 폴더에 또 시작하면 409
    r = await client.post("/api/v1/chat/runs", json=body, headers=H)
    assert r.status_code == 409
    r = await client.post(f"/api/v1/chat/runs/{run_id}/stop", headers=H)
    assert r.status_code == 200
    done = await _wait(client, run_id)
    assert done["status"] == "stopped"


async def test_get_requires_header(env: Path, client: httpx.AsyncClient) -> None:
    r = await client.get("/api/v1/chat/folders")
    assert r.status_code == 403
    r = await client.get("/api/v1/chat/runs")
    assert r.status_code == 403
    # 개발용(:3000) 출처는 허용, 낯선 출처는 거절
    ok = await client.get("/api/v1/chat/runs", headers={**H, "Origin": "http://localhost:3000"})
    assert ok.status_code == 200
    bad = await client.get("/api/v1/chat/runs", headers={**H, "Origin": "http://evil.example"})
    assert bad.status_code == 403


async def test_prompt_starting_with_dash(
    env: Path, tmp_path: Path, client: httpx.AsyncClient
) -> None:
    prompt = "--help 같은 말로 시작"
    body = {"prompt": prompt, "cwd": str(env / "projects" / "alpha")}
    r = await client.post("/api/v1/chat/runs", json=body, headers=H)
    assert r.status_code == 200, r.text
    done = await _wait(client, r.json()["run_id"])
    assert done["status"] == "done"
    args = json.loads((tmp_path / "args.json").read_text())
    assert prompt not in args["argv"]
    assert args["stdin"] == prompt


async def test_stop_kills_process_group(
    env: Path, tmp_path: Path, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CLAUDE_OFFICE_CLAUDE_BIN", _script(tmp_path, FAKE_SLOW))
    calls: list[tuple[int, int]] = []
    real_killpg = os.killpg

    def spy(pgid: int, sig: int) -> None:
        calls.append((pgid, sig))
        real_killpg(pgid, sig)

    monkeypatch.setattr(chat.os, "killpg", spy)
    body = {"prompt": "x", "cwd": str(env / "projects" / "alpha")}
    r = await client.post("/api/v1/chat/runs", json=body, headers=H)
    run_id = r.json()["run_id"]
    pid = chat._runs[run_id].proc.pid  # pyright: ignore[reportPrivateUsage, reportOptionalMemberAccess]
    assert os.getpgid(pid) == pid  # 새 세션 = 자기 그룹
    await client.post(f"/api/v1/chat/runs/{run_id}/stop", headers=H)
    assert (await _wait(client, run_id))["status"] == "stopped"
    assert (pid, signal.SIGTERM) in calls


def test_event_caps() -> None:
    run = chat.Run(id="r", key="k", cwd="/", prompt="p", resume_session_id=None)
    for _ in range(chat.MAX_ERRORS + 50):
        run.add("error", "e", 100)
    errors = [e for e in run.events if e["kind"] == "error"]
    assert len(errors) == chat.MAX_ERRORS + 1  # + 생략 한 줄
    assert errors[-1]["text"] == chat.OMITTED

    big = chat.Run(id="r2", key="k", cwd="/", prompt="p", resume_session_id=None)
    for _ in range(200):
        big.add("text", "x" * 20000, chat.TEXT_MAX)
    assert big.n_bytes <= chat.MAX_BYTES
    assert [e["text"] for e in big.events].count(chat.OMITTED) == 1
