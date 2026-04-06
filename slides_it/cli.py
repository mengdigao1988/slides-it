from __future__ import annotations

import os
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
from slides_it.designs import DesignManager

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_CONFIG_DIR = pathlib.Path.home() / ".config" / "slides-it"
_PID_FILE = _CONFIG_DIR / "server.pid"
_LOG_FILE = _CONFIG_DIR / "server.log"


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
    _remove_pid_file()


def _write_pid_file(pid: int) -> None:
    """Write the given PID to the pid file."""
    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    _PID_FILE.write_text(str(pid))


def _remove_pid_file() -> None:
    """Remove the pid file if it exists."""
    try:
        _PID_FILE.unlink(missing_ok=True)
    except OSError:
        pass


def _read_pid_file() -> int | None:
    """Read the PID from the pid file, or None if not found."""
    try:
        text = _PID_FILE.read_text().strip()
        return int(text) if text else None
    except (OSError, ValueError):
        return None


def _is_process_alive(pid: int) -> bool:
    """Check whether a process with the given PID is alive."""
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def _is_port_listening(port: int) -> bool:
    """Check whether something is listening on the given port."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _existing_server_pid() -> int | None:
    """Return the PID of a running slides-it server, or None."""
    pid = _read_pid_file()
    if pid and _is_process_alive(pid) and _is_port_listening(_SERVER_PORT):
        return pid
    # Stale pid file — clean up
    if pid:
        _remove_pid_file()
    return None


# ---------------------------------------------------------------------------
# CLI app
# ---------------------------------------------------------------------------

app = typer.Typer(
    name="slides-it",
    help=(
        "AI-powered HTML presentation generator.\n\n"
        "Run without arguments to launch the web UI in your browser.\n"
        "Use the web UI to pick a workspace folder, then chat with the AI\n"
        "to generate beautiful self-contained HTML slide decks.\n\n"
        "By default, slides-it runs as a background daemon.\n"
        "Use --fg to run in the foreground (for debugging)."
    ),
    no_args_is_help=False,
    invoke_without_command=True,
    rich_markup_mode="markdown",
)

design_app = typer.Typer(
    help=(
        "Manage presentation designs.\n\n"
        "Designs control the visual style the AI uses when generating slides.\n"
        "Each design is a directory with a DESIGN.md (metadata + style instructions)\n"
        "and an optional preview.html. Built-in designs ship with slides-it;\n"
        "community designs can be installed from the official registry or any URL."
    ),
    rich_markup_mode="markdown",
)
app.add_typer(design_app, name="design")

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
    fg: Annotated[
        bool,
        typer.Option(
            "--fg",
            help="Run in the foreground (default: background daemon).",
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

    # Check if already running
    existing_pid = _existing_server_pid()
    if existing_pid:
        typer.echo(
            f"slides-it is already running (PID {existing_pid}).\n"
            f"Opening browser… Use 'slides-it stop' to stop it."
        )
        webbrowser.open(f"http://localhost:{_SERVER_PORT}")
        raise typer.Exit(0)

    try:
        ver = _pkg_version("slides-it")
    except Exception:
        ver = _BUNDLED_VERSION

    # ── Background daemon mode (default) ───────────────────────────────────
    if not fg:
        # Free the port first, then fork a detached child with --fg
        _free_port(_SERVER_PORT)

        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        log_handle = open(_LOG_FILE, "a")  # noqa: SIM115

        # Build the command to re-invoke ourselves with --fg
        if getattr(sys, "frozen", False):
            # PyInstaller binary — sys.executable IS the binary itself
            cmd = [sys.executable, "--fg"]
        else:
            # Source/uv run — use same Python interpreter via module mode
            cmd = [sys.executable, "-m", "slides_it.cli", "--fg"]

        proc = subprocess.Popen(
            cmd,
            start_new_session=True,
            stdout=log_handle,
            stderr=log_handle,
        )
        log_handle.close()

        _write_pid_file(proc.pid)

        typer.echo(
            f"slides-it v{ver} running in background (PID {proc.pid}).\n"
            f"  → http://localhost:{_SERVER_PORT}\n"
            f"  → Log: {_LOG_FILE}\n"
            f"  → Use 'slides-it stop' to stop."
        )

        # Open browser after a short delay
        threading.Thread(
            target=lambda: (time.sleep(1.5), webbrowser.open(f"http://localhost:{_SERVER_PORT}")),
            daemon=True,
        ).start()
        # Give the thread time to schedule the browser open
        time.sleep(2.0)
        raise typer.Exit(0)

    # ── Foreground mode (--fg) ─────────────────────────────────────────────

    # Free the port if a previous slides-it left it occupied
    _free_port(_SERVER_PORT)

    from slides_it.server import run as run_server

    if not _FRONTEND_DIST.exists():
        typer.echo(
            "Warning: frontend/dist not found. Run `cd frontend && npm run build` first.",
            err=True,
        )

    typer.echo(f"slides-it v{ver} — http://localhost:{_SERVER_PORT}")

    # Write PID file for this foreground process
    _write_pid_file(os.getpid())

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
# slides-it design list
# ---------------------------------------------------------------------------

@design_app.command("list")
def design_list() -> None:
    """List all installed designs."""
    dm = DesignManager()
    designs = dm.list()
    active = dm.active()

    if not designs:
        typer.echo("No designs installed.")
        return

    typer.echo("")
    for t in designs:
        marker = " *" if t.name == active else "  "
        typer.echo(f"{marker} {t.name}")
        typer.echo(f"     {t.description}  (v{t.version}, by {t.author})")
    typer.echo("")
    typer.echo("* = active design")
    typer.echo("")


# ---------------------------------------------------------------------------
# slides-it design search
# ---------------------------------------------------------------------------

@design_app.command("search")
def design_search(
    query: Annotated[str, typer.Argument(help="Search term (leave blank to list all)")] = "",
) -> None:
    """Search the official design registry."""
    try:
        import httpx
        resp = httpx.get(_REGISTRY_URL, follow_redirects=True, timeout=10)
        resp.raise_for_status()
        registry = resp.json()
    except Exception as e:
        typer.echo(f"Error: could not fetch registry — {e}", err=True)
        raise typer.Exit(1)

    designs = registry.get("templates", [])
    if query:
        q = query.lower()
        designs = [t for t in designs if q in t["name"].lower() or q in t.get("description", "").lower()]

    if not designs:
        typer.echo("No designs found." + (f" Try a different search term." if query else ""))
        return

    typer.echo("")
    for t in designs:
        typer.echo(f"  {t['name']}  (v{t.get('version', '?')}, by {t.get('author', '?')})")
        typer.echo(f"     {t.get('description', '')}")
    typer.echo("")
    typer.echo(f"Install with: slides-it design install <name>")
    typer.echo("")


# ---------------------------------------------------------------------------
# slides-it design install
# ---------------------------------------------------------------------------

@design_app.command("install")
def design_install(
    source: Annotated[str, typer.Argument(help=(
        "Design source: registry name, https:// URL (zip), "
        "github:user/repo, or local ./path"
    ))],
    name: Annotated[str | None, typer.Option("--name", "-n", help="Override design name")] = None,
    activate: Annotated[bool, typer.Option("--activate/--no-activate", help="Activate after install")] = True,
) -> None:
    """Install a design from any source."""
    dm = DesignManager()
    typer.echo(f"Installing design from: {source}")
    try:
        installed_name = dm.install(source, name)
    except Exception as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(1)

    typer.echo(f"Installed: {installed_name}")

    if activate:
        dm.activate(installed_name)
        typer.echo(f"Activated: {installed_name}")


# ---------------------------------------------------------------------------
# slides-it design remove
# ---------------------------------------------------------------------------

@design_app.command("remove")
def design_remove(
    name: Annotated[str, typer.Argument(help="Design name to remove")],
    yes: Annotated[bool, typer.Option("--yes", "-y", help="Skip confirmation")] = False,
) -> None:
    """Remove an installed design."""
    dm = DesignManager()
    if not yes:
        typer.confirm(f"Remove design '{name}'?", abort=True)
    try:
        dm.remove(name)
    except ValueError as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(1)
    typer.echo(f"Removed: {name}")


# ---------------------------------------------------------------------------
# slides-it design activate
# ---------------------------------------------------------------------------

@design_app.command("activate")
def design_activate(
    name: Annotated[str, typer.Argument(help="Design name to activate")],
) -> None:
    """Set the active design."""
    dm = DesignManager()
    try:
        dm.activate(name)
    except ValueError as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(1)
    typer.echo(f"Active design: {name}")


# ---------------------------------------------------------------------------
# slides-it restart
# ---------------------------------------------------------------------------

@app.command("restart")
def restart() -> None:
    """Restart the slides-it server and opencode process."""
    stop()
    time.sleep(0.5)

    # Re-launch slides-it (will run as daemon by default)
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

    # Try PID file first (preferred — clean shutdown)
    pid = _read_pid_file()
    if pid and _is_process_alive(pid):
        try:
            os.kill(pid, signal.SIGTERM)
            # Wait briefly for graceful shutdown
            for _ in range(10):
                time.sleep(0.3)
                if not _is_process_alive(pid):
                    break
            else:
                # Force kill if still alive after 3 seconds
                os.kill(pid, signal.SIGKILL)
            typer.echo(f"Stopped slides-it server (PID {pid}).")
            stopped_any = True
        except (OSError, ProcessLookupError):
            pass
    _remove_pid_file()

    # Kill opencode on its port
    if sys.platform != "win32":
        try:
            result = subprocess.run(
                ["lsof", "-ti", ":4096"],
                capture_output=True, text=True,
            )
            pids = [p.strip() for p in result.stdout.strip().splitlines() if p.strip()]
            for p in pids:
                subprocess.run(["kill", "-9", p], check=False)
            if pids:
                typer.echo(f"Stopped opencode (port 4096, killed {len(pids)} process(es)).")
                stopped_any = True
        except FileNotFoundError:
            pass

    # Fallback: kill any process on the server port (catches orphaned processes)
    if sys.platform != "win32":
        try:
            result = subprocess.run(
                ["lsof", "-ti", f":{_SERVER_PORT}"],
                capture_output=True, text=True,
            )
            pids = [p.strip() for p in result.stdout.strip().splitlines() if p.strip()]
            for p in pids:
                subprocess.run(["kill", "-9", p], check=False)
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
            "https://api.github.com/repos/cyber-dash-tech/slides-it/releases/latest",
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
        "curl -fsSL https://raw.githubusercontent.com/cyber-dash-tech/slides-it/main/install.sh | bash",
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
