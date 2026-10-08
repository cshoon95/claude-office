"""(로컬 커스텀) 확인 필요 질문 내용 · 휴대폰 푸시(ntfy) · Tailscale 접속 테스트."""

import asyncio
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from app.api import middleware
from app.core import notifier
from app.core.room_orchestrator import build_overview
from app.core.state_machine import StateMachine
from app.main import app
from app.models.agents import BossState
from app.models.events import EventAdapter, EventType

SID = "11111111-2222-3333-4444-555555555555"

ASK_INPUT = {
    "questions": [
        {
            "question": "어느 쪽으로 할까요?",
            "header": "방향",
            "multiSelect": False,
            "options": [
                {"label": "A안", "description": "a"},
                {"label": "B안", "description": "b"},
                {"label": "C안", "description": "c"},
                {"label": "D안", "description": "d"},
                {"label": "E안", "description": "e"},
            ],
        },
        {"question": "두 번째?", "header": "x", "options": []},
    ]
}


def _ev(event_type: EventType, **data: Any):
    return EventAdapter.validate_python(
        {"event_type": event_type, "session_id": SID, "timestamp": datetime.now(UTC), "data": data}
    )


# ---------------------------------------------------------------- (A) 질문 내용


def test_pending_question_from_ask_user_question_and_cleared():
    sm = StateMachine()
    sm.transition(_ev(EventType.PRE_TOOL_USE, tool_name="AskUserQuestion", tool_input=ASK_INPUT))
    assert sm.boss_state == BossState.WAITING_PERMISSION
    assert sm.boss_pending_question == (
        "어느 쪽으로 할까요?\n① A안  ② B안  ③ C안  ④ D안 (+1개 질문 더)"
    )

    entry = build_overview({SID: sm}).entries[0]
    assert entry.bucket == "needs_you"
    dumped = entry.model_dump(by_alias=True)
    assert dumped["pendingQuestion"] == sm.boss_pending_question

    sm.transition(_ev(EventType.POST_TOOL_USE, tool_name="AskUserQuestion"))
    assert sm.boss_pending_question is None
    assert build_overview({SID: sm}).entries[0].pending_question is None


def test_pending_question_plan_and_permission():
    sm = StateMachine()
    sm.transition(_ev(EventType.PRE_TOOL_USE, tool_name="ExitPlanMode", tool_input={}))
    assert sm.boss_pending_question == "📋 계획 승인 요청"
    sm.transition(_ev(EventType.USER_PROMPT_SUBMIT, prompt="ok"))
    assert sm.boss_pending_question is None

    sm.transition(_ev(EventType.PERMISSION_REQUEST, tool_name="Bash"))
    assert sm.boss_pending_question == "🔐 권한 요청: Bash"
    sm.transition(_ev(EventType.STOP))
    assert sm.boss_pending_question is None


def test_pending_question_trimmed():
    sm = StateMachine()
    long_q = {"questions": [{"question": "가" * 500, "options": []}]}
    sm.transition(_ev(EventType.PRE_TOOL_USE, tool_name="AskUserQuestion", tool_input=long_q))
    assert sm.boss_pending_question is not None
    assert len(sm.boss_pending_question) <= 300


# ---------------------------------------------------------------- (B) 휴대폰 푸시


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    calls: list[tuple[str, str]] = []

    async def fake_send(title: str, body: str) -> None:
        calls.append((title, body))

    monkeypatch.setattr(notifier, "_send", fake_send)
    monkeypatch.setattr(notifier, "_last_bucket", {})
    monkeypatch.setattr(notifier, "_last_sent", {})
    monkeypatch.setattr(notifier, "_names", {})
    return calls


async def _settle() -> None:
    await asyncio.sleep(0)
    await asyncio.sleep(0)


async def test_push_once_on_entering_needs_you(sent, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CLAUDE_OFFICE_NTFY_TOPIC", "test-topic")
    notifier.on_session_update(SID, "working", name="snook")
    notifier.on_session_update(SID, "needs_you", pending_question="고를까요?")
    notifier.on_session_update(SID, "needs_you", pending_question="고를까요?")
    await _settle()
    assert sent == [("확인 필요 · snook", "고를까요?")]

    # 나갔다 곧바로 다시 들어와도 60초 안이면 안 보낸다
    notifier.on_session_update(SID, "working")
    notifier.on_session_update(SID, "needs_you")
    await _settle()
    assert len(sent) == 1

    # 60초 지나면 다시 보낸다(기본 문구)
    notifier._last_sent[SID] -= notifier.DEBOUNCE_S + 1
    notifier.on_session_update(SID, "working")
    notifier.on_session_update(SID, "needs_you")
    await _settle()
    assert sent[-1] == ("확인 필요 · snook", notifier.DEFAULT_BODY)


async def test_no_push_without_topic_or_for_manual(sent, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("CLAUDE_OFFICE_NTFY_TOPIC", raising=False)
    notifier.on_session_update(SID, "needs_you")
    monkeypatch.setenv("CLAUDE_OFFICE_NTFY_TOPIC", "test-topic")
    notifier.on_session_update("manual-abc123", "needs_you")
    await _settle()
    assert sent == []


async def test_send_posts_json_to_ntfy(monkeypatch: pytest.MonkeyPatch):
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["json"] = request.read().decode()
        return httpx.Response(200)

    real_client = httpx.AsyncClient

    def fake_client(**kw: Any) -> httpx.AsyncClient:
        return real_client(transport=httpx.MockTransport(handler), **kw)

    monkeypatch.setattr(notifier.httpx, "AsyncClient", fake_client)
    monkeypatch.setenv("CLAUDE_OFFICE_NTFY_TOPIC", "t1")
    monkeypatch.setenv("CLAUDE_OFFICE_NTFY_SERVER", "https://ntfy.example")
    monkeypatch.setenv("CLAUDE_OFFICE_NTFY_CLICK", "https://office.example/")
    await notifier._send("확인 필요 · x", "본문")
    assert seen["url"] == "https://ntfy.example/"
    assert '"topic":"t1"' in seen["json"].replace(" ", "")
    assert "office.example" in seen["json"]


# ---------------------------------------------------------------- (C) Tailscale


@pytest.mark.parametrize(
    "host", ["100.101.102.103", "fd7a:115c:a1e0::1", "foo.tail1234.ts.net", "192.168.0.5"]
)
def test_tailscale_hosts_only_in_lan_mode(monkeypatch: pytest.MonkeyPatch, host: str):
    monkeypatch.setattr(middleware, "ALLOW_LAN", True)
    assert middleware.is_lan_host(host)
    assert middleware.host_header_ok(f"{host}:8000" if ":" not in host else f"[{host}]:8000")
    monkeypatch.setattr(middleware, "ALLOW_LAN", False)
    assert not middleware.is_lan_host(host)


def test_public_ip_still_rejected(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(middleware, "ALLOW_LAN", True)
    assert not middleware.is_lan_host("8.8.8.8")
    assert not middleware.host_header_ok("evil.example.com")


async def _get_from(client_ip: str, host: str, cookies: dict[str, str] | None = None) -> int:
    transport = httpx.ASGITransport(app=app, client=(client_ip, 12345))
    async with httpx.AsyncClient(
        transport=transport, base_url=f"http://{host}:8000", cookies=cookies
    ) as c:
        return (await c.get("/health")).status_code


async def test_middleware_tailscale_client(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(middleware, "ALLOW_LAN", True)
    monkeypatch.setattr(middleware, "LAN_TOKEN", "secret-token")
    # 토큰 없으면 401(토큰 요구는 그대로), 쿠키 있으면 통과
    assert await _get_from("100.101.102.103", "foo.tail1234.ts.net") == 401
    ok = await _get_from(
        "100.101.102.103", "foo.tail1234.ts.net", {middleware.LAN_COOKIE: "secret-token"}
    )
    assert ok == 200

    monkeypatch.setattr(middleware, "ALLOW_LAN", False)
    cookies = {middleware.LAN_COOKIE: "secret-token"}
    assert await _get_from("100.101.102.103", "foo.tail1234.ts.net", cookies) == 403
