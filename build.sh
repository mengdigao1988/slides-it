#!/usr/bin/env bash
# build.sh — Build a self-contained slides-it binary using PyInstaller.
#
# Usage:
#   bash build.sh
#
# Output:
#   dist/slides-it        (macOS / Linux)
#   dist/slides-it.exe    (Windows — not currently tested)
#
# Prerequisites:
#   - uv (https://docs.astral.sh/uv/)
#   - Node.js + npm (for the frontend build)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PYPROJECT_VER="$(grep '^version' pyproject.toml | head -1 | sed 's/.*= *"//' | sed 's/".*//')"
INIT_VER="$(python3 -c "import re; print(re.search(r'__version__\s*=\s*\"([^\"]+)\"', open('slides_it/__init__.py').read()).group(1))")"

if [ "$PYPROJECT_VER" != "$INIT_VER" ]; then
    echo "ERROR: Version mismatch — pyproject.toml=$PYPROJECT_VER but slides_it/__init__.py=$INIT_VER"
    echo "Fix: update both files to the same version before building."
    exit 1
fi

echo "==> Building slides-it v${PYPROJECT_VER}"

# ---------------------------------------------------------------------------
# 1. Build the React frontend
# ---------------------------------------------------------------------------
echo ""
echo "==> Building frontend..."
cd frontend
npm install --silent
npm run build
cd ..
echo "    done — frontend/dist ready"

# ---------------------------------------------------------------------------
# 2. Ensure PyInstaller is available in the uv environment
# ---------------------------------------------------------------------------
echo ""
echo "==> Checking PyInstaller..."
if ! uv run python -c "import PyInstaller" 2>/dev/null; then
    echo "    Installing PyInstaller..."
    uv add --dev pyinstaller
fi

# ---------------------------------------------------------------------------
# 3. PyInstaller one-file build
# ---------------------------------------------------------------------------
echo ""
echo "==> Running PyInstaller..."

# --add-data source:dest
#   On macOS/Linux the separator is ':'
#   PyInstaller uses sys._MEIPASS as the root at runtime,
#   and our _resource_path() helper in cli.py resolves from there.

uv run pyinstaller \
    --onefile \
    --name slides-it \
    --add-data "slides_it/designs:slides_it/designs" \
    --add-data "slides_it/skill:slides_it/skill" \
    --add-data "frontend/dist:frontend/dist" \
    --collect-all slides_it \
    --hidden-import uvicorn.logging \
    --hidden-import uvicorn.loops \
    --hidden-import uvicorn.loops.auto \
    --hidden-import uvicorn.protocols \
    --hidden-import uvicorn.protocols.http \
    --hidden-import uvicorn.protocols.http.auto \
    --hidden-import uvicorn.protocols.websockets \
    --hidden-import uvicorn.protocols.websockets.auto \
    --hidden-import uvicorn.lifespan \
    --hidden-import uvicorn.lifespan.on \
    --hidden-import fastapi \
    --hidden-import typer \
    --hidden-import pdfplumber \
    --hidden-import pdfminer \
    --hidden-import pdfminer.high_level \
    --hidden-import openpyxl \
    --hidden-import docx \
    --hidden-import pptx \
    --clean \
    --noconfirm \
    slides_it/cli.py

# ---------------------------------------------------------------------------
# 4. Verify
# ---------------------------------------------------------------------------
echo ""
if [ -f "dist/slides-it" ]; then
    SIZE=$(du -sh dist/slides-it | cut -f1)
    echo "==> Build successful: dist/slides-it (${SIZE})"
    echo ""
    echo "    Test it:"
    echo "      ./dist/slides-it --version"
    echo "      ./dist/slides-it --help"
else
    echo "ERROR: dist/slides-it not found — build may have failed."
    exit 1
fi
