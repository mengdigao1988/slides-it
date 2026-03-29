from __future__ import annotations

import asyncio
import json
import os
import threading
import pathlib
import signal
import subprocess
import tempfile
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

# Known providers that ship native support in opencode (no custom npm package needed)
_NATIVE_PROVIDERS = {"anthropic", "openai", "opencode", "openrouter", "deepseek", ""}

# Directories that are never shown in the workspace file tree.
_LS_IGNORE: set[str] = {
    ".git", ".vscode", ".venv", ".idea",
    "node_modules", "__pycache__", ".DS_Store",
    ".mypy_cache", ".pytest_cache", ".ruff_cache",
    ".tox", "dist", ".next", ".nuxt",
    ".slides-it",   # internal slides-it state — not useful to the user
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
    # On startup: clean up any stale slides-it AGENTS.md block left by an older
    # version that used write_rules(). slides-it no longer owns that file.
    _cleanup_stale_agents_md()
    yield
    # Cleanup on shutdown
    _stop_opencode()


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


class TemplateEntry(BaseModel):
    name: str
    description: str
    author: str
    version: str
    active: bool
    has_preview: bool


class TemplateDetail(BaseModel):
    name: str
    description: str
    author: str
    version: str
    active: bool
    has_preview: bool
    skill_md: str
    preview_html: str | None


class SessionRequest(BaseModel):
    session_id: str
    messages: list[dict] = []   # serialised ChatMessage[] from the frontend


class InstallTemplateRequest(BaseModel):
    # Mode A: install from external source (URL, github:user/repo, registry name, local path)
    source: str = ""

    # Mode B: install from inline content (used by the AI agent via curl)
    # All three fields are required together when source is empty.
    name: str = ""           # kebab-case template name, e.g. "blue-minimal"
    description: str = ""
    skill_md: str = ""       # full SKILL.md content
    preview_html: str = ""   # full preview.html content (may be empty)
    activate: bool = False   # if True, activate this template after installing


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
    If opencode is already healthy on the expected port, reuse it.
    """
    global _opencode_proc, _workspace_dir

    directory = pathlib.Path(req.directory).expanduser().resolve()
    if not directory.exists() or not directory.is_dir():
        raise HTTPException(status_code=400, detail=f"Directory not found: {req.directory}")

    # Create .slides-it directory in workspace (for future session persistence etc.)
    (directory / ".slides-it").mkdir(exist_ok=True)

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
    asyncio.get_running_loop().call_later(0.1, lambda: os.kill(os.getpid(), signal.SIGTERM))
    return {"status": "shutting_down"}


@app.get("/api/session")
def get_session() -> dict[str, object]:
    """
    Return the persisted session ID and message history for the current workspace.

    Also ensures .slides-it/ exists — so this is safe to call regardless of
    whether /api/start was called (e.g. on browser refresh).

    Layout inside <workspace>/.slides-it/:
      current                   — plain text, contains the active session ID
      session-<id>.json         — messages for that session
    """
    if not _workspace_dir:
        return {"session_id": None, "messages": []}
    slides_dir = pathlib.Path(_workspace_dir) / ".slides-it"
    # Ensure the directory exists unconditionally — browser refresh skips /api/start
    slides_dir.mkdir(exist_ok=True)
    current_file = slides_dir / "current"
    if not current_file.exists():
        return {"session_id": None, "messages": []}
    try:
        session_id = current_file.read_text(encoding="utf-8").strip()
        if not session_id:
            return {"session_id": None, "messages": []}
        session_file = slides_dir / f"session-{session_id}.json"
        if not session_file.exists():
            return {"session_id": session_id, "messages": []}
        data = json.loads(session_file.read_text(encoding="utf-8"))
        return {"session_id": session_id, "messages": data.get("messages", [])}
    except Exception:
        return {"session_id": None, "messages": []}


@app.put("/api/session")
def save_session(req: SessionRequest) -> dict[str, str]:
    """
    Persist messages to <workspace>/.slides-it/session-<id>.json
    and update the 'current' pointer.
    Old session files are kept (not deleted).
    """
    if not _workspace_dir:
        raise HTTPException(status_code=400, detail="No active workspace")
    slides_dir = pathlib.Path(_workspace_dir) / ".slides-it"
    slides_dir.mkdir(exist_ok=True)
    # Write messages to the session-scoped file
    session_file = slides_dir / f"session-{req.session_id}.json"
    session_file.write_text(
        json.dumps({"messages": req.messages}, ensure_ascii=False),
        encoding="utf-8",
    )
    # Update the current pointer
    (slides_dir / "current").write_text(req.session_id, encoding="utf-8")
    return {"status": "saved"}


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
            cwd=_workspace_dir if _workspace_dir else None,
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


@app.get("/api/template/{name}/skill")
def get_template_skill(name: str) -> dict[str, str]:
    """
    Return the combined system prompt for the given template.

    Concatenates core SKILL.md + template SKILL.md. The frontend sends this
    as the `system` field in POST /session/:id/prompt_async so that the active
    template's visual style is injected on every message without touching any
    config files on disk.
    """
    tm = TemplateManager()
    try:
        skill = tm.build_prompt(name)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"skill": skill}


@app.get("/api/template/{name}/preview")
def get_template_preview(name: str) -> dict[str, str]:
    """
    Return the raw HTML content of preview.html for the given template.
    The frontend injects this into an iframe via srcdoc.
    """
    tm = TemplateManager()
    path = tm._template_path(name)
    if not path:
        raise HTTPException(status_code=404, detail=f"Template '{name}' not found")
    preview_file = path / "preview.html"
    if not preview_file.exists():
        raise HTTPException(status_code=404, detail=f"Template '{name}' has no preview.html")
    return {"html": preview_file.read_text(encoding="utf-8")}


@app.get("/api/template/{name}", response_model=TemplateDetail)
def get_template(name: str) -> TemplateDetail:
    """
    Return full details for a single template — metadata, SKILL.md, and preview.html.

    Used by the AI agent to fetch the active template's visual reference in one
    call before generating slides. Also available to the frontend for any future
    use that needs all fields together.

    preview_html is null if the template has no preview.html.
    skill_md contains only the template's own SKILL.md (not the core skill).
    """
    tm = TemplateManager()
    path = tm._template_path(name)
    if not path:
        raise HTTPException(status_code=404, detail=f"Template '{name}' not found")
    info = tm._parse_template_md(path / "TEMPLATE.md")
    if not info:
        raise HTTPException(status_code=404, detail=f"Template '{name}' has no TEMPLATE.md")
    skill_file = path / "SKILL.md"
    if not skill_file.exists():
        raise HTTPException(status_code=404, detail=f"Template '{name}' has no SKILL.md")
    preview_file = path / "preview.html"
    return TemplateDetail(
        name=info.name,
        description=info.description,
        author=info.author,
        version=info.version,
        active=info.name == tm.active(),
        has_preview=preview_file.exists(),
        skill_md=skill_file.read_text(encoding="utf-8"),
        preview_html=preview_file.read_text(encoding="utf-8") if preview_file.exists() else None,
    )


@app.get("/api/templates", response_model=list[TemplateEntry])
def list_templates() -> list[TemplateEntry]:
    """Return all installed templates with metadata."""
    tm = TemplateManager()
    active = tm.active()
    result = []
    for info in tm.list():
        path = tm._template_path(info.name)
        has_preview = bool(path and (path / "preview.html").exists())
        result.append(TemplateEntry(
            name=info.name,
            description=info.description,
            author=info.author,
            version=info.version,
            active=info.name == active,
            has_preview=has_preview,
        ))
    return result


@app.post("/api/templates/install")
def install_template(req: InstallTemplateRequest) -> dict[str, str]:
    """
    Install a template — two modes:

    Mode A (source): install from any external source.
        { "source": "https://...", "activate": true }
        { "source": "github:user/repo" }
        { "source": "dark-neon" }          ← registry lookup

    Mode B (inline): install from content generated by the AI agent.
        {
          "name": "blue-minimal",
          "description": "Clean blue theme with minimal decoration",
          "skill_md": "## Visual Style...",
          "preview_html": "<!DOCTYPE html>...",
          "activate": true
        }

    In Mode B the server writes a temporary directory containing TEMPLATE.md,
    SKILL.md, and optionally preview.html, then installs it via the same
    _install_from_path() codepath used by Mode A.  This keeps all install
    logic in one place.
    """
    tm = TemplateManager()

    if req.source.strip():
        # ── Mode A: external source ───────────────────────────────────────
        source = req.source.strip()
        try:
            name = tm.install(source)
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        if req.activate:
            try:
                tm.activate(name)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
        return {"name": name, "status": "installed", "activated": str(req.activate).lower()}

    else:
        # ── Mode B: inline content from agent ────────────────────────────
        name = req.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="'name' is required when 'source' is empty")
        if not req.skill_md.strip():
            raise HTTPException(status_code=400, detail="'skill_md' is required when 'source' is empty")

        # Validate name: kebab-case, no path traversal
        import re as _re
        if not _re.match(r'^[a-z0-9]+(?:-[a-z0-9]+)*$', name):
            raise HTTPException(
                status_code=400,
                detail="'name' must be kebab-case (lowercase letters, digits, hyphens only)",
            )

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = pathlib.Path(tmp)

            # Write TEMPLATE.md with YAML frontmatter
            template_md = (
                "---\n"
                f"name: {name}\n"
                f"description: {req.description.strip() or 'AI-generated template'}\n"
                "author: ai-generated\n"
                "version: 1.0.0\n"
                "---\n"
            )
            (tmp_path / "TEMPLATE.md").write_text(template_md, encoding="utf-8")

            # Write SKILL.md
            (tmp_path / "SKILL.md").write_text(req.skill_md, encoding="utf-8")

            # Write preview.html if provided
            if req.preview_html.strip():
                (tmp_path / "preview.html").write_text(req.preview_html, encoding="utf-8")

            try:
                installed_name = tm.install(str(tmp_path))
            except Exception as e:
                raise HTTPException(status_code=400, detail=str(e))

        if req.activate:
            try:
                tm.activate(installed_name)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))

        return {"name": installed_name, "status": "installed", "activated": str(req.activate).lower()}


@app.delete("/api/templates/{name}")
def delete_template(name: str) -> dict[str, str]:
    """Remove a user-installed template. Built-in templates cannot be removed."""
    tm = TemplateManager()
    try:
        tm.remove(name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"name": name, "status": "removed"}


@app.put("/api/templates/{name}/activate")
def activate_template(name: str) -> dict[str, str]:
    """Set the active template."""
    tm = TemplateManager()
    try:
        tm.activate(name)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"name": name, "status": "activated"}


@app.get("/api/settings", response_model=SettingsResponse)
def get_settings() -> SettingsResponse:
    """Return current provider settings read from workspace opencode.jsonc (API key is masked)."""
    provider_id = ""
    api_key = ""
    base_url = ""
    custom_model = ""

    if _workspace_dir:
        cfg = _read_opencode_jsonc(_workspace_dir)
        providers = cfg.get("provider", {})
        if providers:
            # Take the first (and normally only) provider block written by slides-it
            provider_id = next(iter(providers))
            opts = providers[provider_id].get("options", {})
            api_key = opts.get("apiKey", "")
            base_url = opts.get("baseURL", "")
            # custom model: look for first key under "models"
            models_block = providers[provider_id].get("models", {})
            custom_model = next(iter(models_block), "")

    if len(api_key) > 12:
        masked = api_key[:8] + "..." + api_key[-4:]
    elif api_key:
        masked = "*" * len(api_key)
    else:
        masked = ""

    return SettingsResponse(
        providerID=provider_id,
        apiKeyMasked=masked,
        baseURL=base_url,
        customModel=custom_model,
    )


@app.put("/api/settings")
def save_settings(req: SettingsRequest) -> dict[str, str]:
    """
    Persist provider settings to workspace opencode.jsonc and restart OpenCode.

    - Reads the existing apiKey from opencode.jsonc if req.apiKey is empty (no change).
    - Writes the provider block (apiKey + optional baseURL) to opencode.jsonc.
    - No apiKey → removes the provider block so opencode falls back to free tier.
    - Restarts the managed opencode process so the new config takes effect immediately.
    """
    if not _workspace_dir:
        raise HTTPException(status_code=400, detail="No active workspace")

    # Resolve final key: keep existing if user left the field blank
    final_key = req.apiKey
    if not final_key:
        existing_cfg = _read_opencode_jsonc(_workspace_dir)
        providers = existing_cfg.get("provider", {})
        if req.providerID and req.providerID in providers:
            final_key = providers[req.providerID].get("options", {}).get("apiKey", "")
        elif providers:
            # If provider changed, don't carry over old key
            final_key = ""

    _write_opencode_jsonc(_workspace_dir, req.providerID, final_key, req.baseURL, req.customModel)

    # Restart opencode in a background thread so this request returns immediately.
    # The frontend polls /api/status until ready=true.
    global _opencode_proc
    if _opencode_proc is not None:
        workspace = _workspace_dir  # capture for thread closure

        def _restart() -> None:
            global _opencode_proc
            _stop_opencode()
            _opencode_proc = subprocess.Popen(
                ["opencode", "serve", "--port", str(OPENCODE_PORT)],
                cwd=workspace,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

        threading.Thread(target=_restart, daemon=True).start()
        return {"status": "restarting"}

    return {"status": "saved"}


@app.get("/api/file-base64")
def get_file_base64(path: str = Query(...)) -> dict[str, str]:
    """
    Read a file as raw bytes and return it base64-encoded.

    Used by the frontend to attach binary files (images, PDFs) as FileParts
    for the AI. Reading via this endpoint avoids the text-encoding corruption
    that occurs when binary data is fetched through opencode's /file/content
    endpoint (which treats all file content as UTF-8 text).

    Args:
        path: Absolute path to the file on disk.

    Returns:
        { "base64": "<base64-encoded bytes>", "mime": "<mime-type>" }
    """
    file_path = pathlib.Path(path)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")

    import base64
    import mimetypes

    mime, _ = mimetypes.guess_type(str(file_path))
    if not mime:
        mime = "application/octet-stream"

    data = file_path.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")

    return {"base64": b64, "mime": mime}


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

_OPENCODE_AGENTS_MD = pathlib.Path.home() / ".config" / "opencode" / "AGENTS.md"
_SLIDES_IT_MARKER = "<!-- slides-it managed -->"


def _cleanup_stale_agents_md() -> None:
    """
    Remove any slides-it block left in ~/.config/opencode/AGENTS.md by an older
    version that used write_rules(). slides-it no longer writes to that file;
    system prompts are passed per-message via the `system` API field instead.
    Safe to call on every startup — no-ops if the file doesn't exist or has no
    slides-it marker.
    """
    if not _OPENCODE_AGENTS_MD.exists():
        return
    text = _OPENCODE_AGENTS_MD.read_text(encoding="utf-8")
    if _SLIDES_IT_MARKER not in text:
        return
    parts = text.split(_SLIDES_IT_MARKER)
    # Preserve any user content that existed outside the slides-it block
    tail = parts[-1].strip() if len(parts) > 2 else ""
    if tail:
        _OPENCODE_AGENTS_MD.write_text(tail, encoding="utf-8")
    else:
        _OPENCODE_AGENTS_MD.unlink(missing_ok=True)


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


def _read_opencode_jsonc(workspace: str) -> dict:
    """
    Read and parse the slides-it provider config from the workspace.

    Reads opencode.json first (the file opencode actually loads as project config).
    Falls back to opencode.jsonc for users who had an older slides-it version.

    Returns an empty dict if no file exists or cannot be parsed.
    """
    import re
    # opencode loads opencode.json as the project config — use that as primary
    cfg_path = pathlib.Path(workspace) / "opencode.json"
    if not cfg_path.exists():
        cfg_path = pathlib.Path(workspace) / "opencode.jsonc"
    if not cfg_path.exists():
        return {}
    try:
        text = cfg_path.read_text(encoding="utf-8")
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # Strip only lines whose first non-whitespace chars are "//"
            stripped = re.sub(r"(?m)^\s*//.*$", "", text)
            return json.loads(stripped)
    except Exception:
        return {}


def _write_opencode_jsonc(
    workspace: str,
    provider_id: str,
    api_key: str,
    base_url: str,
    custom_model: str,
) -> None:
    """
    Write provider config into <workspace>/opencode.json.

    Uses opencode.json (not .jsonc) because that is the filename opencode
    recognises as the project-level config. Writing to .jsonc would be silently
    ignored by opencode when a .json file is also present.
    """
    import re
    # Write to opencode.json — the file opencode actually loads as project config
    cfg_path = pathlib.Path(workspace) / "opencode.json"

    # Parse existing file (comment-stripping for safety)
    cfg: dict = {}
    if cfg_path.exists():
        try:
            text = cfg_path.read_text(encoding="utf-8")
            try:
                cfg = json.loads(text)
            except json.JSONDecodeError:
                stripped = re.sub(r"(?m)^\s*//.*$", "", text)
                cfg = json.loads(stripped)
        except Exception:
            cfg = {}

    cfg.setdefault("$schema", "https://opencode.ai/config.json")

    provider_section: dict = cfg.get("provider", {})

    # Remove stale provider blocks from previous provider (clean slate on switch)
    if provider_id and provider_section:
        stale = [k for k in list(provider_section.keys()) if k != provider_id]
        for k in stale:
            del provider_section[k]

    if api_key and provider_id:
        options: dict = {"apiKey": api_key}
        if base_url:
            options["baseURL"] = base_url

        if provider_id in _NATIVE_PROVIDERS:
            # Native provider: just options block
            block: dict = {"options": options}
        else:
            # Custom OpenAI-compatible provider: needs npm + name + options
            block = {
                "npm": "@ai-sdk/openai-compatible",
                "name": provider_id,
                "options": options,
            }
            if custom_model:
                block["models"] = {custom_model: {"name": custom_model}}

        provider_section[provider_id] = block
        cfg["provider"] = provider_section
    else:
        # No key → remove the provider block entirely (fall back to free tier)
        if provider_id in provider_section:
            del provider_section[provider_id]
        if provider_section:
            cfg["provider"] = provider_section
        elif "provider" in cfg:
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
