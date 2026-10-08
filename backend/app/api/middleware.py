"""HTTP middleware for the Claude Office backend.

Moved out of ``app.main`` in ARC-023. The trust boundary and auth behavior
live here: ``LocalhostOnlyMiddleware`` restricts access to the loopback
interface, and ``ApiKeyMiddleware`` gates state-changing endpoints behind
either an explicit user-configured key or the per-launch auto-generated
token (SEC-001 / SEC-002 / SEC-006). Logic is unchanged from the prior
inline version in ``main.py``.
"""

import hmac
import ipaddress as _ip  # (로컬 커스텀) LAN 모드
import os as _os
from urllib.parse import urlparse as _urlparse

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import get_settings

# Resolved once at import time, mirroring the previous ``main.py`` pattern.
# ``Settings`` is a pydantic-settings singleton; subsequent ``get_settings()``
# calls return the same instance, so call-time attribute access is identical.
settings = get_settings()

_LOCALHOST_HOSTS = frozenset({"127.0.0.1", "::1", "localhost", "testclient"})

# (로컬 커스텀) 집 와이파이 등 사설망에서 휴대폰·다른 맥으로 보기.
# CLAUDE_OFFICE_ALLOW_LAN=1 일 때만 켜진다. 사설 IP만으로는 믿지 않는다
# (카페·호텔 와이파이도 사설망) — LAN 손님은 토큰이 있어야 한다.
# 처음 한 번 ?token=<CLAUDE_OFFICE_LAN_TOKEN> 으로 열면 쿠키(co_lan)가 심기고,
# 이후 요청·웹소켓은 그 쿠키로 통과한다.
# 토큰이 설정돼 있지 않으면 LAN 손님은 전부 거절한다(안전한 기본값).
ALLOW_LAN = _os.environ.get("CLAUDE_OFFICE_ALLOW_LAN", "") in ("1", "true", "yes")
LAN_TOKEN = _os.environ.get("CLAUDE_OFFICE_LAN_TOKEN", "")
LAN_COOKIE = "co_lan"
# 홈 화면 앱(PWA) 정보·아이콘. iOS 는 이것들을 쿠키 없이 가져가므로 토큰 없이 연다
# (공개돼도 되는 정적 파일뿐 — 세션 내용은 담겨 있지 않다).
LAN_PUBLIC_PATHS = frozenset(
    {"/manifest.webmanifest", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png"}
)


# (로컬 커스텀) Tailscale: 밖에서도 내 기기끼리만 붙는 사설망. 100.64.0.0/10(CGNAT)은
# 파이썬 is_private 에 안 잡히므로 따로 둔다. MagicDNS 이름은 *.ts.net.
_TAILSCALE_NETS = (_ip.ip_network("100.64.0.0/10"), _ip.ip_network("fd7a:115c:a1e0::/48"))


def is_lan_host(host: str | None) -> bool:
    """LAN 모드일 때 사설 IP·Tailscale IP(또는 *.local·*.ts.net 이름)인가. 루프백은 False."""
    if not ALLOW_LAN or not host:
        return False
    try:
        a = _ip.ip_address(host)
    except ValueError:
        return host.endswith((".local", ".ts.net"))
    if any(a in net for net in _TAILSCALE_NETS):
        return True
    return a.is_private and not a.is_loopback


def lan_token_ok(token: str | None) -> bool:
    return bool(LAN_TOKEN) and bool(token) and hmac.compare_digest(token or "", LAN_TOKEN)


def host_header_ok(host_header: str | None) -> bool:
    """DNS rebinding 방지: Host 가 루프백이거나, LAN 모드의 사설 주소/.local 이어야 한다."""
    if not host_header:
        return True  # HTTP/1.0 등 Host 없는 로컬 도구
    hostname = _urlparse("//" + host_header).hostname
    # testserver/test: Starlette·httpx 테스트 클라이언트 기본 이름(공개 도메인이 될 수 없음)
    if hostname in ("testserver", "test"):
        return True
    return hostname in _LOCALHOST_HOSTS or is_lan_host(hostname)


class LocalhostOnlyMiddleware(BaseHTTPMiddleware):
    """Reject HTTP requests from non-localhost origins.

    This is a local-only development tool, not deployed to the public internet.
    All API endpoints (including subprocess execution and clipboard writes)
    are protected by restricting access to the loopback interface.
    (로컬 커스텀) LAN 모드에선 사설망 손님도 받되 토큰 쿠키가 있어야 한다.

    ``"testclient"`` is the sentinel host used by Starlette's test transport
    and cannot appear on a real TCP connection, so it is safe to allow.
    """

    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        if not host_header_ok(request.headers.get("host")):
            return JSONResponse(status_code=403, content={"detail": "Access denied: bad Host"})
        client_host = request.client.host if request.client else None
        if client_host in _LOCALHOST_HOSTS:
            return await call_next(request)
        if is_lan_host(client_host):
            query_token = request.query_params.get("token")
            if lan_token_ok(request.cookies.get(LAN_COOKIE)):
                return await call_next(request)
            if request.method == "GET" and request.url.path in LAN_PUBLIC_PATHS:
                return await call_next(request)
            if lan_token_ok(query_token):
                response = await call_next(request)
                response.set_cookie(
                    LAN_COOKIE,
                    query_token or "",
                    max_age=60 * 60 * 24 * 365,
                    httponly=True,
                    samesite="lax",
                )
                return response
            msg = "토큰이 필요해요: 맥에서 office.sh lan url 로 나온 주소로 처음 한 번 여세요"
            return JSONResponse(status_code=401, content={"detail": msg})
        return JSONResponse(status_code=403, content={"detail": "Access denied: localhost only"})


# Paths that do NOT require an API key (health checks, interactive docs).
# The OpenAPI schema URL is checked separately in the middleware because it is
# served under settings.API_V1_STR (e.g. /api/v1/openapi.json), not /openapi.json.
_NO_AUTH_PATHS = frozenset({"/health", "/docs", "/redoc"})


def _is_state_changing(path: str, method: str) -> bool:
    """Return True if the request targets a destructive or side-effecting endpoint.

    Covers global destructive operations (clearing all sessions, running a
    simulation) and per-session OS side effects (terminal activation + clipboard
    write via ``/focus``). Other per-session mutations remain open in the default
    configuration and are fully gated when an explicit key is set (handled by
    ``settings.has_explicit_key`` in the middleware).
    """
    prefix = settings.API_V1_STR + "/sessions"
    return (
        (path == prefix and method == "DELETE")
        or (path == f"{prefix}/simulate" and method == "POST")
        or (path.startswith(f"{prefix}/") and path.endswith("/focus") and method == "POST")
    )


class ApiKeyMiddleware(BaseHTTPMiddleware):
    """Validate X-API-Key header for protected endpoints.

    * When ``CLAUDE_OFFICE_API_KEY`` is explicitly set, ALL non-public paths
      require the key (existing behaviour).
    * When the key is empty (default), state-changing endpoints still require
      the per-launch auto-generated token (``settings.effective_api_key``).
      Read-only paths remain open for backwards compatibility.
    """

    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        if request.method == "OPTIONS":
            return await call_next(request)

        # Skip auth for public paths and WebSocket handshakes
        if (
            request.url.path in _NO_AUTH_PATHS
            or request.url.path == f"{settings.API_V1_STR}/openapi.json"
            or request.url.path.startswith("/ws/")
        ):
            return await call_next(request)

        # Determine whether auth is required for this request
        requires_auth = settings.has_explicit_key or _is_state_changing(
            request.url.path, request.method
        )

        if not requires_auth:
            return await call_next(request)

        provided = request.headers.get("X-API-Key", "")
        if not hmac.compare_digest(provided, settings.effective_api_key):
            return JSONResponse(status_code=401, content={"detail": "Invalid API key"})

        return await call_next(request)
