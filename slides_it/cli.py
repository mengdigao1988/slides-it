from __future__ import annotations

import pathlib
import shutil
import signal
import subprocess
import sys
import time
import threading
import webbrowser

import typer
from typing_extensions import Annotated

from slides_it.templates import TemplateManager

app = typer.Typer(
    name="slides-it",
    help="AI-powered HTML presentation generator.",
    no_args_is_help=False,
    invoke_without_command=True,
)

template_app = typer.Typer(help="Manage presentation templates.")
app.add_typer(template_app, name="template")

_REGISTRY_URL = "https://raw.githubusercontent.com/slides-it/slides-it/main/registry.json"
_SERVER_PORT = 3000
_FRONTEND_DIST = pathlib.Path(__file__).parent.parent / "frontend" / "dist"


# ---------------------------------------------------------------------------
# Main entry point — `slides-it` with no subcommand launches the app
# ---------------------------------------------------------------------------

@app.callback(invoke_without_command=True)
def _launch(ctx: typer.Context) -> None:
    """Launch the slides-it web UI."""
    if ctx.invoked_subcommand is not None:
        return

    # Check opencode is installed
    if not shutil.which("opencode"):
        typer.echo("Error: opencode is not installed.", err=True)
        typer.echo("Install it with: curl -fsSL https://opencode.ai/install | bash", err=True)
        raise typer.Exit(1)

    # Free the port if a previous slides-it left it occupied
    _free_port(_SERVER_PORT)

    from slides_it.server import mount_frontend, run as run_server

    # Mount built frontend if it exists
    if _FRONTEND_DIST.exists():
        mount_frontend(_FRONTEND_DIST)
    else:
        typer.echo(
            "Warning: frontend/dist not found. Run `cd frontend && npm run build` first.",
            err=True,
        )

    typer.echo(f"Starting slides-it at http://localhost:{_SERVER_PORT} ...")

    # Open browser after a short delay so uvicorn is ready
    threading.Thread(
        target=lambda: (time.sleep(1.0), webbrowser.open(f"http://localhost:{_SERVER_PORT}")),
        daemon=True,
    ).start()

    # Register SIGTERM handler so `kill <pid>` also cleans up
    def _on_sigterm(signum: int, frame: object) -> None:  # noqa: ARG001
        _cleanup()
        sys.exit(0)

    signal.signal(signal.SIGTERM, _on_sigterm)

    try:
        run_server(
            port=_SERVER_PORT,
            frontend_dist=_FRONTEND_DIST if _FRONTEND_DIST.exists() else None,
        )
    except KeyboardInterrupt:
        pass
    finally:
        _cleanup()
        typer.echo("Goodbye.")


def _free_port(port: int) -> None:
    """
    Kill any process listening on the given port (macOS / Linux only).
    Silently does nothing on Windows or if no process is found.
    """
    if sys.platform == "win32":
        return
    try:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True,
            text=True,
        )
        pids = result.stdout.strip().splitlines()
        for pid in pids:
            pid = pid.strip()
            if pid:
                subprocess.run(["kill", "-9", pid], check=False)
        if pids:
            typer.echo(f"Freed port {port} (killed {len(pids)} process(es)).")
    except FileNotFoundError:
        pass  # lsof not available — skip silently


def _cleanup() -> None:
    """Clean up AGENTS.md on exit (opencode process is handled by server lifespan)."""
    try:
        TemplateManager().cleanup_rules()
    except Exception:
        pass


def main() -> None:
    """Package entry point (called by `slides-it` command)."""
    app()


# ---------------------------------------------------------------------------
# slides-it template list
# ---------------------------------------------------------------------------

@template_app.command("list")
def template_list() -> None:
    """List all installed templates."""
    tm = TemplateManager()
    templates = tm.list()
    active = tm.active()

    if not templates:
        typer.echo("No templates installed.")
        return

    typer.echo("")
    for t in templates:
        marker = " *" if t.name == active else "  "
        tag = " [built-in]" if t.builtin else ""
        typer.echo(f"{marker} {t.name}{tag}")
        typer.echo(f"     {t.description}  (v{t.version}, by {t.author})")
    typer.echo("")
    typer.echo("* = active template")
    typer.echo("")


# ---------------------------------------------------------------------------
# slides-it template search
# ---------------------------------------------------------------------------

@template_app.command("search")
def template_search(
    query: Annotated[str, typer.Argument(help="Search term (leave blank to list all)")] = "",
) -> None:
    """Search the official template registry."""
    try:
        import httpx
        resp = httpx.get(_REGISTRY_URL, follow_redirects=True, timeout=10)
        resp.raise_for_status()
        registry = resp.json()
    except Exception as e:
        typer.echo(f"Error: could not fetch registry — {e}", err=True)
        raise typer.Exit(1)

    templates = registry.get("templates", [])
    if query:
        q = query.lower()
        templates = [t for t in templates if q in t["name"].lower() or q in t.get("description", "").lower()]

    if not templates:
        typer.echo("No templates found." + (f" Try a different search term." if query else ""))
        return

    typer.echo("")
    for t in templates:
        typer.echo(f"  {t['name']}  (v{t.get('version', '?')}, by {t.get('author', '?')})")
        typer.echo(f"     {t.get('description', '')}")
    typer.echo("")
    typer.echo(f"Install with: slides-it template install <name>")
    typer.echo("")


# ---------------------------------------------------------------------------
# slides-it template install
# ---------------------------------------------------------------------------

@template_app.command("install")
def template_install(
    source: Annotated[str, typer.Argument(help=(
        "Template source: registry name, https:// URL (zip), "
        "github:user/repo, or local ./path"
    ))],
    name: Annotated[str | None, typer.Option("--name", "-n", help="Override template name")] = None,
    activate: Annotated[bool, typer.Option("--activate/--no-activate", help="Activate after install")] = True,
) -> None:
    """Install a template from any source."""
    tm = TemplateManager()
    typer.echo(f"Installing template from: {source}")
    try:
        installed_name = tm.install(source, name)
    except Exception as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(1)

    typer.echo(f"Installed: {installed_name}")

    if activate:
        tm.activate(installed_name)
        typer.echo(f"Activated: {installed_name}")


# ---------------------------------------------------------------------------
# slides-it template remove
# ---------------------------------------------------------------------------

@template_app.command("remove")
def template_remove(
    name: Annotated[str, typer.Argument(help="Template name to remove")],
    yes: Annotated[bool, typer.Option("--yes", "-y", help="Skip confirmation")] = False,
) -> None:
    """Remove an installed template."""
    tm = TemplateManager()
    if not yes:
        typer.confirm(f"Remove template '{name}'?", abort=True)
    try:
        tm.remove(name)
    except ValueError as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(1)
    typer.echo(f"Removed: {name}")


# ---------------------------------------------------------------------------
# slides-it template activate
# ---------------------------------------------------------------------------

@template_app.command("activate")
def template_activate(
    name: Annotated[str, typer.Argument(help="Template name to activate")],
) -> None:
    """Set the active template."""
    tm = TemplateManager()
    try:
        tm.activate(name)
    except ValueError as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(1)
    typer.echo(f"Active template: {name}")
