from __future__ import annotations

import pathlib
import shutil
import signal
import subprocess
import sys
import time
import threading
import webbrowser
from importlib.metadata import version as _pkg_version

import typer
from typing import Annotated

from slides_it import __version__ as _BUNDLED_VERSION
from slides_it.templates import TemplateManager

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resource_path(relative: str) -> pathlib.Path:
    """
    Return the correct absolute path to a bundled resource.

    When running from source: resolves relative to the repo root
    (two levels up from this file: slides_it/cli.py → slides_it/ → repo/).

    When running as a PyInstaller --onefile binary: resolves relative to
    sys._MEIPASS (the temporary extraction directory).
    """
    if getattr(sys, "frozen", False):
        base = pathlib.Path(sys._MEIPASS)  # type: ignore[attr-defined]
    else:
        base = pathlib.Path(__file__).parent.parent
    return base / relative


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
    """Clean up on exit (opencode process is handled by server lifespan)."""
    pass


# ---------------------------------------------------------------------------
# CLI app
# ---------------------------------------------------------------------------

app = typer.Typer(
    name="slides-it",
    help=(
        "AI-powered HTML presentation generator.\n\n"
        "Run without arguments to launch the web UI in your browser.\n"
        "Use the web UI to pick a workspace folder, then chat with the AI\n"
        "to generate beautiful self-contained HTML slide decks."
    ),
    no_args_is_help=False,
    invoke_without_command=True,
    rich_markup_mode="markdown",
)

template_app = typer.Typer(
    help=(
        "Manage presentation templates.\n\n"
        "Templates control the visual style the AI uses when generating slides.\n"
        "Each template is a directory with a SKILL.md (style instructions) and\n"
        "a TEMPLATE.md (metadata). Built-in templates ship with slides-it;\n"
        "community templates can be installed from the official registry or any URL."
    ),
    rich_markup_mode="markdown",
)
app.add_typer(template_app, name="template")

_REGISTRY_URL = "https://raw.githubusercontent.com/slides-it/slides-it/main/registry.json"
_SERVER_PORT = 3000
_FRONTEND_DIST = _resource_path("frontend/dist")


# ---------------------------------------------------------------------------
# --version callback
# ---------------------------------------------------------------------------

def _version_callback(value: bool) -> None:
    if value:
        try:
            ver = _pkg_version("slides-it")
        except Exception:
            ver = _BUNDLED_VERSION
        typer.echo(f"slides-it {ver}")
        raise typer.Exit()


# ---------------------------------------------------------------------------
# Main entry point — `slides-it` with no subcommand launches the app
# ---------------------------------------------------------------------------

@app.callback(invoke_without_command=True)
def _launch(
    ctx: typer.Context,
    version: Annotated[
        bool,
        typer.Option(
            "--version", "-V",
            callback=_version_callback,
            is_eager=True,
            help="Show version and exit.",
        ),
    ] = False,
) -> None:
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

    from slides_it.server import run as run_server

    if not _FRONTEND_DIST.exists():
        typer.echo(
            "Warning: frontend/dist not found. Run `cd frontend && npm run build` first.",
            err=True,
        )

    try:
        ver = _pkg_version("slides-it")
    except Exception:
        ver = _BUNDLED_VERSION

    typer.echo(f"slides-it v{ver} — http://localhost:{_SERVER_PORT}")

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
    except Exception as e:
        typer.echo(f"Error: server crashed — {e}", err=True)
        raise typer.Exit(1)
    finally:
        _cleanup()
        typer.echo("Goodbye.")


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
        typer.echo(f"{marker} {t.name}")
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


# ---------------------------------------------------------------------------
# slides-it restart
# ---------------------------------------------------------------------------

@app.command("restart")
def restart() -> None:
    """Restart the slides-it server and opencode process."""
    stop()
    time.sleep(0.5)

    # Re-launch slides-it in a new process group so it outlives this process
    executable = sys.argv[0]
    subprocess.Popen(
        [executable],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    typer.echo("slides-it restarting…")


# ---------------------------------------------------------------------------
# slides-it stop
# ---------------------------------------------------------------------------

@app.command("stop")
def stop() -> None:
    """Stop the slides-it server and opencode process."""
    stopped_any = False

    # Kill opencode on its port
    if sys.platform != "win32":
        try:
            result = subprocess.run(
                ["lsof", "-ti", ":4096"],
                capture_output=True, text=True,
            )
            pids = [p.strip() for p in result.stdout.strip().splitlines() if p.strip()]
            for pid in pids:
                subprocess.run(["kill", "-9", pid], check=False)
            if pids:
                typer.echo(f"Stopped opencode (port 4096, killed {len(pids)} process(es)).")
                stopped_any = True
        except FileNotFoundError:
            pass

    # Kill the slides-it Python server on its port
    if sys.platform != "win32":
        try:
            result = subprocess.run(
                ["lsof", "-ti", f":{_SERVER_PORT}"],
                capture_output=True, text=True,
            )
            pids = [p.strip() for p in result.stdout.strip().splitlines() if p.strip()]
            for pid in pids:
                subprocess.run(["kill", "-9", pid], check=False)
            if pids:
                typer.echo(f"Stopped slides-it server (port {_SERVER_PORT}, killed {len(pids)} process(es)).")
                stopped_any = True
        except FileNotFoundError:
            pass

    if not stopped_any:
        typer.echo("No slides-it processes found running.")


# ---------------------------------------------------------------------------
# slides-it upgrade
# ---------------------------------------------------------------------------

@app.command("upgrade")
def upgrade() -> None:
    """Upgrade slides-it to the latest release."""
    try:
        import httpx
        resp = httpx.get(
            "https://api.github.com/repos/mengdigao1988/slides-it/releases/latest",
            follow_redirects=True,
            timeout=10,
        )
        resp.raise_for_status()
        latest = resp.json().get("tag_name", "").lstrip("v")
    except Exception as e:
        typer.echo(f"Error: could not fetch latest release — {e}", err=True)
        raise typer.Exit(1)

    current = _BUNDLED_VERSION
    if latest == current:
        typer.echo(f"Already up to date (slides-it {current}).")
        return

    typer.echo(f"Upgrading slides-it {current} → {latest} ...")
    result = subprocess.run(
        "curl -fsSL https://raw.githubusercontent.com/mengdigao1988/slides-it/main/install.sh | bash",
        shell=True,
    )
    if result.returncode != 0:
        typer.echo("Upgrade failed.", err=True)
        raise typer.Exit(1)
    typer.echo(f"slides-it {latest} installed. Restart your terminal if needed.")


def main() -> None:
    """Package entry point (called by `slides-it` command)."""
    app()


if __name__ == "__main__":
    main()
