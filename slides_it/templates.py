from __future__ import annotations

import json
import pathlib
import shutil
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

CONFIG_DIR = pathlib.Path.home() / ".config" / "slides-it"
TEMPLATES_DIR = CONFIG_DIR / "templates"
CONFIG_FILE = CONFIG_DIR / "config.json"

# Built-in templates bundled with the package
_BUILTIN_DIR = pathlib.Path(__file__).parent / "templates"

OPENCODE_AGENTS_MD = pathlib.Path.home() / ".config" / "opencode" / "AGENTS.md"
_SLIDES_IT_MARKER = "<!-- slides-it managed -->"
DEFAULT_TEMPLATE = "default"


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class TemplateInfo:
    name: str
    description: str
    author: str
    version: str
    builtin: bool


# ---------------------------------------------------------------------------
# TemplateManager
# ---------------------------------------------------------------------------

class TemplateManager:
    """Manage slides-it templates stored in ~/.config/slides-it/templates/."""

    def __init__(self) -> None:
        TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def list(self) -> list[TemplateInfo]:
        """Return all installed templates (built-in first, then user-installed)."""
        results: list[TemplateInfo] = []
        seen: set[str] = set()

        # Built-in templates (bundled with package, read-only)
        for path in sorted(_BUILTIN_DIR.iterdir()):
            if path.is_dir() and (path / "TEMPLATE.md").exists():
                info = self._parse_template_md(path / "TEMPLATE.md", builtin=True)
                if info and info.name not in seen:
                    results.append(info)
                    seen.add(info.name)

        # User-installed templates (skip if name already covered by built-in)
        for path in sorted(TEMPLATES_DIR.iterdir()):
            if path.is_dir() and (path / "TEMPLATE.md").exists():
                info = self._parse_template_md(path / "TEMPLATE.md", builtin=False)
                if info and info.name not in seen:
                    results.append(info)
                    seen.add(info.name)

        return results

    def install(self, source: str, name: str | None = None) -> str:
        """
        Install a template from any source.

        Args:
            source: Registry name, https:// URL (zip), github:user/repo, or local path.
            name: Override the template name. Defaults to name from TEMPLATE.md.

        Returns:
            Installed template name.
        """
        if source.startswith("https://") or source.startswith("http://"):
            return self._install_from_url(source, name)
        if source.startswith("github:"):
            repo = source[len("github:"):]
            url = f"https://github.com/{repo}/archive/refs/heads/main.zip"
            return self._install_from_url(url, name)
        if source.startswith("./") or source.startswith("/") or pathlib.Path(source).exists():
            return self._install_from_path(pathlib.Path(source), name)
        # Fall back to registry lookup
        return self._install_from_registry(source)

    def remove(self, name: str) -> None:
        """
        Remove a user-installed template.

        Raises:
            ValueError: If template is built-in or not installed.
        """
        if (_BUILTIN_DIR / name).exists():
            raise ValueError(f"Cannot remove built-in template '{name}'")
        target = TEMPLATES_DIR / name
        if not target.exists():
            raise ValueError(f"Template '{name}' is not installed")
        shutil.rmtree(target)
        # Reset active template if it was the removed one
        if self.active() == name:
            self.activate(DEFAULT_TEMPLATE)

    def activate(self, name: str) -> None:
        """
        Set the active template.

        Raises:
            ValueError: If template is not installed.
        """
        if not self._template_path(name):
            raise ValueError(f"Template '{name}' is not installed")
        config = self._load_config()
        config["activeTemplate"] = name
        self._save_config(config)

    def active(self) -> str:
        """Return the name of the currently active template."""
        return self._load_config().get("activeTemplate", DEFAULT_TEMPLATE)

    def get_model(self) -> str:
        """Return the currently active model ID (empty string if not set)."""
        return self._load_config().get("modelID", "")

    def set_model(self, model_id: str) -> None:
        """Persist the active model ID to config."""
        config = self._load_config()
        config["modelID"] = model_id
        self._save_config(config)

    def get_settings(self) -> dict[str, str]:
        """Return provider settings from slides-it config."""
        cfg = self._load_config()
        return {
            "providerID":  cfg.get("providerID", ""),
            "apiKey":      cfg.get("apiKey", ""),
            "baseURL":     cfg.get("baseURL", ""),
            "customModel": cfg.get("customModel", ""),
        }

    def save_settings(
        self,
        provider_id: str,
        api_key: str,
        base_url: str,
        custom_model: str,
    ) -> None:
        """
        Persist provider settings to slides-it config.

        Args:
            provider_id:  e.g. "anthropic", "openai", "custom"
            api_key:      raw key (stored locally; never sent to opencode API)
            base_url:     OpenAI-compatible base URL (may be empty)
            custom_model: model ID to register for custom providers (may be empty)
        """
        cfg = self._load_config()
        cfg["providerID"]  = provider_id
        cfg["apiKey"]      = api_key
        cfg["baseURL"]     = base_url
        cfg["customModel"] = custom_model
        self._save_config(cfg)

    def get_skill_md(self, name: str | None = None) -> str:
        """
        Read and return the SKILL.md content for a template.

        Args:
            name: Template name. Defaults to the active template.

        Returns:
            SKILL.md file contents as a string.

        Raises:
            ValueError: If template is not installed or SKILL.md is missing.
        """
        template_name = name or self.active()
        path = self._template_path(template_name)
        if not path:
            raise ValueError(f"Template '{template_name}' is not installed")
        skill_file = path / "SKILL.md"
        if not skill_file.exists():
            raise ValueError(f"Template '{template_name}' has no SKILL.md")
        return skill_file.read_text(encoding="utf-8")

    def write_rules(self, template_name: str | None = None) -> None:
        """
        Write the combined system prompt to ~/.config/opencode/AGENTS.md.

        Concatenates core SKILL.md + active template SKILL.md and writes to
        OpenCode's global rules file. If a prior file exists (not written by
        slides-it), its contents are preserved and appended after the slides-it
        block so nothing is lost.

        Call this on startup and whenever the active template changes.

        Args:
            template_name: Template to use. Defaults to the active template.
        """
        content = self._build_prompt(template_name)
        OPENCODE_AGENTS_MD.parent.mkdir(parents=True, exist_ok=True)

        prior = ""
        if OPENCODE_AGENTS_MD.exists():
            existing = OPENCODE_AGENTS_MD.read_text(encoding="utf-8")
            # If we already own it, replace it entirely
            if _SLIDES_IT_MARKER in existing:
                OPENCODE_AGENTS_MD.write_text(content, encoding="utf-8")
                return
            # Otherwise, preserve the original content after our block
            prior = existing

        combined = content + ("\n\n" + prior if prior else "")
        OPENCODE_AGENTS_MD.write_text(combined, encoding="utf-8")

    def cleanup_rules(self) -> None:
        """
        Remove the slides-it block from ~/.config/opencode/AGENTS.md on exit.

        If the file contains content beyond the slides-it block, it is restored.
        If slides-it wrote the entire file, it is deleted.
        """
        if not OPENCODE_AGENTS_MD.exists():
            return
        existing = OPENCODE_AGENTS_MD.read_text(encoding="utf-8")
        if _SLIDES_IT_MARKER not in existing:
            return  # Not our file, leave it alone

        # Split off any preserved original content that followed our block
        parts = existing.split(_SLIDES_IT_MARKER, maxsplit=2)
        # parts[0] = everything before marker (our header comment)
        # Find trailing user content after the closing marker line
        tail = ""
        if len(parts) > 2:
            # second marker closes our block; content after is user's
            tail = parts[2].strip()

        if tail:
            OPENCODE_AGENTS_MD.write_text(tail, encoding="utf-8")
        else:
            OPENCODE_AGENTS_MD.unlink(missing_ok=True)

    def _build_prompt(self, template_name: str | None = None) -> str:
        """
        Concatenate core SKILL.md + template SKILL.md with the managed marker.

        Returns:
            Full string to write to ~/.config/opencode/AGENTS.md.
        """
        core_skill = (
            pathlib.Path(__file__).parent / "skill" / "SKILL.md"
        ).read_text(encoding="utf-8")
        template_skill = self.get_skill_md(template_name)
        body = f"{core_skill}\n\n---\n\n{template_skill}"
        return f"{_SLIDES_IT_MARKER}\n{body}\n{_SLIDES_IT_MARKER}"

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _template_path(self, name: str) -> pathlib.Path | None:
        """Return the directory for a template, or None if not found."""
        builtin = _BUILTIN_DIR / name
        if builtin.exists() and (builtin / "TEMPLATE.md").exists():
            return builtin
        user = TEMPLATES_DIR / name
        if user.exists() and (user / "TEMPLATE.md").exists():
            return user
        return None

    def _install_from_url(self, url: str, name: str | None) -> str:
        """Download a zip from any URL and install the template."""
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = pathlib.Path(tmp) / "template.zip"
            try:
                urllib.request.urlretrieve(url, zip_path)
            except Exception as e:
                raise RuntimeError(f"Failed to download template from {url}") from e

            extract_dir = pathlib.Path(tmp) / "extracted"
            try:
                with zipfile.ZipFile(zip_path) as zf:
                    zf.extractall(extract_dir)
            except zipfile.BadZipFile as e:
                raise RuntimeError(f"Downloaded file is not a valid zip: {url}") from e

            return self._install_from_extracted(extract_dir, name)

    def _install_from_path(self, path: pathlib.Path, name: str | None) -> str:
        """Install a template from a local directory."""
        if not path.exists():
            raise ValueError(f"Path does not exist: {path}")
        if not (path / "TEMPLATE.md").exists():
            raise ValueError(f"No TEMPLATE.md found in {path}")
        if not (path / "SKILL.md").exists():
            raise ValueError(f"No SKILL.md found in {path}")

        info = self._parse_template_md(path / "TEMPLATE.md", builtin=False)
        template_name = name or (info.name if info else path.name)
        target = TEMPLATES_DIR / template_name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(path, target)
        return template_name

    def _install_from_registry(self, name: str) -> str:
        """Look up a template name in registry.json and install it."""
        registry_path = pathlib.Path(__file__).parent.parent / "registry.json"
        if not registry_path.exists():
            raise ValueError(f"registry.json not found; cannot install '{name}' by name")
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        for entry in registry.get("templates", []):
            if entry["name"] == name:
                url = entry.get("url", "")
                if url == "bundled":
                    raise ValueError(f"'{name}' is a built-in template and is already available")
                return self._install_from_url(url, name)
        raise ValueError(f"Template '{name}' not found in registry")

    def _install_from_extracted(self, extract_dir: pathlib.Path, name: str | None) -> str:
        """Find the template root inside an extracted zip and install it."""
        # GitHub zips wrap contents in a subdirectory — find TEMPLATE.md
        template_root: pathlib.Path | None = None
        for candidate in [extract_dir, *extract_dir.iterdir()]:
            if candidate.is_dir() and (candidate / "TEMPLATE.md").exists():
                template_root = candidate
                break
        if not template_root:
            raise RuntimeError("No TEMPLATE.md found inside the downloaded zip")
        return self._install_from_path(template_root, name)

    @staticmethod
    def _parse_template_md(path: pathlib.Path, builtin: bool) -> TemplateInfo | None:
        """Parse YAML frontmatter from TEMPLATE.md and return TemplateInfo."""
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return None

        fields: dict[str, str] = {}
        lines = text.splitlines()
        if lines and lines[0].strip() == "---":
            for line in lines[1:]:
                if line.strip() == "---":
                    break
                if ":" in line:
                    key, _, value = line.partition(":")
                    fields[key.strip()] = value.strip()

        return TemplateInfo(
            name=fields.get("name", path.parent.name),
            description=fields.get("description", ""),
            author=fields.get("author", "unknown"),
            version=fields.get("version", "0.0.0"),
            builtin=builtin,
        )

    def _load_config(self) -> dict[str, str]:
        if CONFIG_FILE.exists():
            try:
                return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                pass
        return {}

    def _save_config(self, config: dict[str, str]) -> None:
        CONFIG_FILE.write_text(json.dumps(config, indent=2), encoding="utf-8")
