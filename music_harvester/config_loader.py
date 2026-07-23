from __future__ import annotations

from pathlib import Path
from typing import Any


def load_yaml(path: Path) -> Any:
    try:
      import yaml
    except ImportError as exc:
      raise SystemExit(
          "PyYAML is required for config files. Run: python -m pip install -r requirements.txt"
      ) from exc

    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


def project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def default_config_dir() -> Path:
    return Path(__file__).resolve().parent / "config"
