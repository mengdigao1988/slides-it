from __future__ import annotations

import asyncio
import json
import os
import pathlib
import signal
import subprocess
import urllib.request
from contextlib import asynccontextmanager
from typing import List

import uvicorn
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from slides_it.templates import TemplateManager

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

OPENCODE_PORT = 4096
_OPENCODE_AUTH = pathlib.Path.home() / ".local" / "share" / "opencode" / "auth.json"

# Known providers that ship native support in opencode (no custom npm package needed)
_NATIVE_PROVIDERS = {"anthropic", "openai", "opencode", "openrouter", "deepseek", ""}

# Directories that are never shown in the workspace file tree.
# .slides-it is intentionally NOT in this list — it belongs to slides-it and should be visible.
_LS_IGNORE: set[str] = {
    ".git", ".vscode", ".venv", ".idea",
    "node_modules", "__pycache__", ".DS_Store",
    ".mypy_cache", ".pytest_cache", ".ruff_cache",
    ".tox", "dist", ".next", ".nuxt",
}

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

_opencode_proc: subprocess.Popen[bytes] | None = None
_workspace_dir: str = ""


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):  # type: ignore[type-arg]
    yield
    # Cleanup on shutdown
    _stop_opencode()
    TemplateManager().cleanup_rules()


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="slides-it", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class DirEntry(BaseModel):
    name: str
    path: str
    has_children: bool


class FsEntry(BaseModel):
    name: str
    path: str
    type: str          # "directory" | "file"
    has_children: bool  # directories only; always False for files


class StartRequest(BaseModel):
    directory: str


class StatusResponse(BaseModel):
    ready: bool
    workspace: str
    opencode_version: str


class SettingsResponse(BaseModel):
    providerID: str
    apiKeyMasked: str   # "sk-ant-...abcd" or ""
    baseURL: str
    customModel: str


class SettingsRequest(BaseModel):
    providerID: str
    apiKey: str         # empty string = keep existing
    baseURL: str
    customModel: str
    clearKey: bool = False


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------

@app.get("/api/dirs", response_model=list[DirEntry])
def list_dirs(path: str = Query(default="~")) -> list[DirEntry]:
    """
    List immediate subdirectories of `path`.
    Returns only directories, sorted: hidden last, then alpha.
    """
    resolved = pathlib.Path(path).expanduser().resolve()
    if not resolved.exists() or not resolved.is_dir():
        raise HTTPException(status_code=404, detail=f"Directory not found: {path}")

    entries: list[DirEntry] = []
    try:
        for child in sorted(resolved.iterdir(), key=lambda p: (p.name.startswith("."), p.name.lower())):
            if not child.is_dir():
                continue
            # Check if it has any subdirectory children (for chevron indicator)
            try:
                has_children = any(c.is_dir() for c in child.iterdir())
            except PermissionError:
                has_children = False
            entries.append(DirEntry(name=child.name, path=str(child), has_children=has_children))
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {path}")

    return entries


@app.get("/api/ls", response_model=list[FsEntry])
def list_entries(path: str = Query(default="~")) -> list[FsEntry]:
    """
    List all immediate children (directories AND files) of `path`.
    Directories come first, then files, both sorted alphabetically.
    Hidden entries (dot-prefixed) come last within each group.
    """
    resolved = pathlib.Path(path).expanduser().resolve()
    if not resolved.exists() or not resolved.is_dir():
        raise HTTPException(status_code=404, detail=f"Directory not found: {path}")

    entries: list[FsEntry] = []
    try:
        children = sorted(
            resolved.iterdir(),
            key=lambda p: (p.is_file(), p.name.startswith("."), p.name.lower()),
        )
        for child in children:
            # Skip noise directories / files that users don't need to see
            if child.name in _LS_IGNORE:
                continue
            if child.is_symlink():
                # Resolve symlinks to get real type
                try:
                    real = child.resolve()
                    is_dir = real.is_dir()
                except OSError:
                    continue
            else:
                is_dir = child.is_dir()

            has_children = False
            if is_dir:
                try:
                    has_children = any(True for _ in child.iterdir())
                except PermissionError:
                    pass

            entries.append(FsEntry(
                name=child.name,
                path=str(child),
                type="directory" if is_dir else "file",
                has_children=has_children,
            ))
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {path}")

    return entries


@app.post("/api/start")
def start_workspace(req: StartRequest) -> dict[str, str]:
    """
    Start opencode serve in the given directory.
    Writes the slides-it system prompt to ~/.config/opencode/AGENTS.md first.
    If opencode is already healthy on the expected port, reuse it.
    """
    global _opencode_proc, _workspace_dir

    directory = pathlib.Path(req.directory).expanduser().resolve()
    if not directory.exists() or not directory.is_dir():
        raise HTTPException(status_code=400, detail=f"Directory not found: {req.directory}")

    # Write system prompt rules
    TemplateManager().write_rules()

    # Create .slides-it directory in workspace (for future session persistence etc.)
    (directory / ".slides-it").mkdir(exist_ok=True)

    # Write provider config into workspace opencode.json
    settings = TemplateManager().get_settings()
    _write_opencode_json(str(directory), settings["providerID"], settings["baseURL"], settings["customModel"])

    # If opencode is already healthy, just update workspace and reuse it
    if _is_opencode_healthy():
        _workspace_dir = str(directory)
        return {"status": "starting", "workspace": str(directory)}

    # Stop any existing managed opencode process, then free the port
    _stop_opencode()

    # Start opencode serve
    _opencode_proc = subprocess.Popen(
        ["opencode", "serve", "--port", str(OPENCODE_PORT)],
        cwd=str(directory),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    _workspace_dir = str(directory)

    return {"status": "starting", "workspace": str(directory)}


@app.get("/api/status", response_model=StatusResponse)
def get_status() -> StatusResponse:
    """Check whether opencode serve is up and healthy."""
    # First check our managed process is alive (if we started one)
    if _opencode_proc and _opencode_proc.poll() is not None:
        return StatusResponse(ready=False, workspace=_workspace_dir, opencode_version="")

    # Then actually ping opencode regardless of how it was started
    try:
        with urllib.request.urlopen(
            f"http://localhost:{OPENCODE_PORT}/global/health", timeout=2
        ) as resp:
            data = json.loads(resp.read())
            return StatusResponse(
                ready=data.get("healthy", False),
                workspace=_workspace_dir,
                opencode_version=data.get("version", ""),
            )
    except Exception:
        return StatusResponse(ready=False, workspace=_workspace_dir, opencode_version="")


@app.post("/api/shutdown")
async def shutdown() -> dict[str, str]:
    """
    Graceful shutdown triggered by the browser window closing.
    Sends SIGTERM to self after the response is delivered.
    """
    loop = asyncio.get_event_loop()
    loop.call_later(0.1, lambda: os.kill(os.getpid(), signal.SIGTERM))
    return {"status": "shutting_down"}


@app.get("/api/models")
def get_models() -> dict[str, object]:
    """
    Return the list of available models (via `opencode models` CLI)
    and the currently active model ID.
    """
    tm = TemplateManager()
    current = tm.get_model()

    try:
        result = subprocess.run(
            ["opencode", "models"],
            capture_output=True, text=True, timeout=10,
        )
        models = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    except Exception:
        models = []

    return {"models": models, "current": current}


@app.put("/api/model")
def set_model(body: dict[str, str]) -> dict[str, str]:
    """Save the active model ID to slides-it config."""
    model_id = body.get("modelID", "").strip()
    if not model_id:
        raise HTTPException(status_code=400, detail="modelID is required")
    TemplateManager().set_model(model_id)
    return {"modelID": model_id}


@app.get("/api/settings", response_model=SettingsResponse)
def get_settings() -> SettingsResponse:
    """Return current provider settings (API key is masked)."""
    s = TemplateManager().get_settings()
    key = s["apiKey"]
    if len(key) > 12:
        masked = key[:8] + "..." + key[-4:]
    elif key:
        masked = "*" * len(key)
    else:
        masked = ""
    return SettingsResponse(
        providerID=s["providerID"],
        apiKeyMasked=masked,
        baseURL=s["baseURL"],
        customModel=s["customModel"],
    )


@app.put("/api/settings")
def save_settings(req: SettingsRequest) -> dict[str, str]:
    """
    Persist provider settings.

    - Writes API key to opencode's auth.json.
    - Writes baseURL / custom provider config to workspace opencode.json (if workspace active).
    - clearKey=True removes the stored key (falls back to opencode free tier).
    """
    tm = TemplateManager()
    existing = tm.get_settings()

    # Resolve final key
    if req.clearKey:
        final_key = ""
    elif req.apiKey:
        final_key = req.apiKey
    else:
        final_key = existing["apiKey"]   # keep existing if not changed

    tm.save_settings(req.providerID, final_key, req.baseURL, req.customModel)
    _write_auth_json(req.providerID or "anthropic", final_key)
    if _workspace_dir:
        _write_opencode_json(_workspace_dir, req.providerID, req.baseURL, req.customModel)

    return {"status": "saved"}


@app.post("/api/upload")
async def upload_files(
    files: List[UploadFile] = File(...),
    target_dir: str = Query(default=""),
) -> dict[str, list[str]]:
    """
    Upload one or more files into the active workspace directory.

    Args:
        files: Multipart file uploads.
        target_dir: Relative sub-path within the workspace (default: workspace root).

    Returns:
        { "uploaded": ["file1.html", ...] }
    """
    if not _workspace_dir:
        raise HTTPException(status_code=400, detail="No workspace is active. Start a workspace first.")

    base = pathlib.Path(_workspace_dir)
    if target_dir:
        dest = (base / target_dir).resolve()
        # Security: must remain inside workspace
        if not str(dest).startswith(str(base)):
            raise HTTPException(status_code=400, detail="target_dir must be inside the workspace.")
    else:
        dest = base

    dest.mkdir(parents=True, exist_ok=True)

    uploaded: list[str] = []
    for upload in files:
        filename = pathlib.Path(upload.filename or "upload").name
        out_path = dest / filename
        content = await upload.read()
        out_path.write_bytes(content)
        uploaded.append(filename)

    return {"uploaded": uploaded}


# ---------------------------------------------------------------------------
# Static frontend (served last so API routes take precedence)
# ---------------------------------------------------------------------------

def mount_frontend(dist_path: pathlib.Path) -> None:
    """Mount the built frontend at /. Call after app is created."""
    if dist_path.exists():
        app.mount("/", StaticFiles(directory=str(dist_path), html=True), name="frontend")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_opencode_healthy() -> bool:
    """Return True if opencode is already responding on OPENCODE_PORT."""
    try:
        with urllib.request.urlopen(
            f"http://localhost:{OPENCODE_PORT}/global/health", timeout=1
        ) as resp:
            data = json.loads(resp.read())
            return bool(data.get("healthy", False))
    except Exception:
        return False


def _write_auth_json(provider_id: str, api_key: str) -> None:
    """
    Write or remove the API key in opencode's auth.json.

    Args:
        provider_id: opencode provider identifier (e.g. "anthropic", "custom").
        api_key:     raw key string; empty string removes the entry.
    """
    auth: dict = {}
    if _OPENCODE_AUTH.exists():
        try:
            auth = json.loads(_OPENCODE_AUTH.read_text(encoding="utf-8"))
        except Exception:
            pass

    if api_key:
        auth[provider_id] = {"type": "api", "key": api_key}
    elif provider_id in auth:
        del auth[provider_id]

    _OPENCODE_AUTH.parent.mkdir(parents=True, exist_ok=True)
    _OPENCODE_AUTH.write_text(json.dumps(auth, indent=2), encoding="utf-8")


def _write_opencode_json(workspace: str, provider_id: str, base_url: str, custom_model: str) -> None:
    """
    Merge provider config into <workspace>/opencode.json.

    Only writes a provider block when:
    - provider is not a natively-supported one, OR
    - a custom baseURL is supplied.

    Existing keys in opencode.json are preserved.
    """
    cfg_path = pathlib.Path(workspace) / "opencode.json"
    cfg: dict = {}
    if cfg_path.exists():
        try:
            text = cfg_path.read_text(encoding="utf-8")
            # Strip JSON-with-comments (opencode uses .jsonc style)
            import re
            text = re.sub(r"//.*", "", text)
            cfg = json.loads(text)
        except Exception:
            cfg = {}

    cfg["$schema"] = "https://opencode.ai/config.json"

    is_custom = provider_id not in _NATIVE_PROVIDERS or base_url
    if is_custom and provider_id:
        provider_block: dict = {
            "npm": "@ai-sdk/openai-compatible",
            "name": provider_id,
            "options": {"baseURL": base_url},
        }
        if custom_model:
            provider_block["models"] = {custom_model: {"name": custom_model}}
        cfg.setdefault("provider", {})[provider_id] = provider_block
    elif "provider" in cfg and provider_id in cfg["provider"]:
        # Previously had a custom block; remove it since provider reverted to native
        del cfg["provider"][provider_id]
        if not cfg["provider"]:
            del cfg["provider"]

    cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def _stop_opencode() -> None:
    global _opencode_proc
    if _opencode_proc and _opencode_proc.poll() is None:
        _opencode_proc.terminate()
        try:
            _opencode_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _opencode_proc.kill()
    _opencode_proc = None
    # Also kill any stray process occupying the opencode port
    _free_port(OPENCODE_PORT)


def _free_port(port: int) -> None:
    """Kill any process listening on the given port (macOS / Linux)."""
    import sys
    if sys.platform == "win32":
        return
    try:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True,
            text=True,
        )
        for pid in result.stdout.strip().splitlines():
            pid = pid.strip()
            if pid:
                subprocess.run(["kill", "-9", pid], check=False)
    except FileNotFoundError:
        pass


# ---------------------------------------------------------------------------
# Entrypoint (for direct invocation / dev)
# ---------------------------------------------------------------------------

def run(port: int = 3000, frontend_dist: pathlib.Path | None = None) -> None:
    if frontend_dist:
        mount_frontend(frontend_dist)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
