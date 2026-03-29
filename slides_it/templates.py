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

# Built-in templates shipped with the package — used only as seed source.
# At runtime all templates live in TEMPLATES_DIR (~/.config/slides-it/templates/).
_SEED_DIR = pathlib.Path(__file__).parent / "templates"

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


# ---------------------------------------------------------------------------
# TemplateManager
# ---------------------------------------------------------------------------

class TemplateManager:
    """Manage slides-it templates stored in ~/.config/slides-it/templates/."""

    def __init__(self) -> None:
        TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        self._seed_builtin_templates()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def list(self) -> list[TemplateInfo]:
        """Return all installed templates sorted by name."""
        results: list[TemplateInfo] = []
        if not TEMPLATES_DIR.exists():
            return results
        for path in sorted(TEMPLATES_DIR.iterdir()):
            if path.is_dir() and (path / "TEMPLATE.md").exists():
                info = self._parse_template_md(path / "TEMPLATE.md")
                if info:
                    results.append(info)
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
        Remove an installed template.

        Raises:
            ValueError: If template is not installed.
        """
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
        """Return provider settings from slides-it config (legacy, baseURL/customModel only)."""
        cfg = self._load_config()
        return {
            "providerID":  cfg.get("providerID", ""),
            "baseURL":     cfg.get("baseURL", ""),
            "customModel": cfg.get("customModel", ""),
        }

    def save_settings(
        self,
        provider_id: str,
        base_url: str,
        custom_model: str,
    ) -> None:
        """
        Persist non-secret provider settings to slides-it config.

        API key is no longer stored here — it lives in opencode.jsonc only.

        Args:
            provider_id:  e.g. "anthropic", "openai", "custom"
            base_url:     OpenAI-compatible base URL (may be empty)
            custom_model: model ID to register for custom providers (may be empty)
        """
        cfg = self._load_config()
        cfg["providerID"]  = provider_id
        cfg["baseURL"]     = base_url
        cfg["customModel"] = custom_model
        # Remove legacy apiKey if present
        cfg.pop("apiKey", None)
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

    def build_prompt(self, template_name: str | None = None) -> str:
        """
        Concatenate core SKILL.md + template context into a combined system prompt.

        Injects the active template name and path so the agent can reference
        preview.html and SKILL.md directly from ~/.config/slides-it/templates/.

        Args:
            template_name: Template to use. Defaults to the active template.

        Returns:
            Full system prompt string ready to pass as the `system` field in
            POST /session/:id/prompt_async.
        """
        name = template_name or self.active()
        core_skill = (
            pathlib.Path(__file__).parent / "skill" / "SKILL.md"
        ).read_text(encoding="utf-8")
        template_skill = self.get_skill_md(name)
        template_dir = TEMPLATES_DIR / name
        has_preview = (template_dir / "preview.html").exists()
        if has_preview:
            preview_line = f"<!--   - preview.html — canonical visual reference (read this before generating slides) -->"
        else:
            preview_line = f"<!--   - (no preview.html for this template) -->"
        template_header = (
            f"<!-- Active template: {name} -->\n"
            f"<!-- Template files: {template_dir}/ -->\n"
            f"<!--   - SKILL.md — style instructions (injected below) -->\n"
            f"{preview_line}\n\n"
        )
        return f"{template_header}{core_skill}\n\n---\n\n{template_skill}"

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _seed_builtin_templates(self) -> None:
        """
        Copy built-in templates from the package seed directory to TEMPLATES_DIR.

        Always overwrites to ensure bundled templates stay up to date with
        the installed package version. User-created templates (not present in
        the seed directory) are never touched.
        """
        if not _SEED_DIR.exists():
            return
        for src in sorted(_SEED_DIR.iterdir()):
            if not src.is_dir() or not (src / "TEMPLATE.md").exists():
                continue
            dst = TEMPLATES_DIR / src.name
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src, dst)

    def _template_path(self, name: str) -> pathlib.Path | None:
        """Return the directory for a template, or None if not found."""
        path = TEMPLATES_DIR / name
        if path.exists() and (path / "TEMPLATE.md").exists():
            return path
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

        info = self._parse_template_md(path / "TEMPLATE.md")
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
    def _parse_template_md(path: pathlib.Path) -> TemplateInfo | None:
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
