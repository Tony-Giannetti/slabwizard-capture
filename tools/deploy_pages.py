"""
Deploy mobile/ to the GitHub Pages repo that serves the phone app.

    python mobile/tools/deploy_pages.py            # sync + commit + push
    python mobile/tools/deploy_pages.py --dry-run  # show what would change

``SlabWizard/mobile/`` is the source of truth — it sits beside
``core/inventory/ingest/`` so the bundle contract in ``js/capture.js`` and
``capture.py`` stay in step (they are twins; changing one without the other
breaks imports). The Pages repo is a **deploy target**, not a second copy to
edit: anything committed there by hand is overwritten by the next run.
"""

from __future__ import annotations

import argparse
import filecmp
import shutil
import subprocess
import sys
from pathlib import Path

MOBILE = Path(__file__).resolve().parent.parent
DEPLOY = MOBILE.parent.parent.parent / "slabwizard-capture"
REMOTE = "https://github.com/Tony-Giannetti/slabwizard-capture.git"

# Everything the browser needs, plus the docs and the icon generator.
INCLUDE_FILES = ["index.html", "styles.css", "app.js", "config.js",
                 "manifest.webmanifest", "sw.js", "README.md"]
INCLUDE_DIRS = ["js", "icons", "tools"]
SKIP_NAMES = {"__pycache__", ".DS_Store", "Thumbs.db"}


def _run(args, cwd, check=True) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=str(cwd), check=check,
                          capture_output=True, text=True)


def _copy_tree(src: Path, dst: Path, changed: list) -> None:
    for item in sorted(src.iterdir()):
        if item.name in SKIP_NAMES or item.name.endswith((".tmp", ".tmp.mjs")):
            continue
        target = dst / item.name
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            _copy_tree(item, target, changed)
        else:
            if not target.exists() or not filecmp.cmp(item, target, shallow=False):
                changed.append(str(target.relative_to(dst.parent)))
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)


def ensure_clone() -> None:
    if (DEPLOY / ".git").is_dir():
        return
    DEPLOY.parent.mkdir(parents=True, exist_ok=True)
    print(f"Cloning {REMOTE} -> {DEPLOY}")
    subprocess.run(["git", "clone", REMOTE, str(DEPLOY)], check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-m", "--message", default="Update SlabWizard Capture")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    ensure_clone()

    changed: list = []
    for name in INCLUDE_FILES:
        src = MOBILE / name
        if not src.is_file():
            print(f"  missing (skipped): {name}")
            continue
        dst = DEPLOY / name
        if not dst.exists() or not filecmp.cmp(src, dst, shallow=False):
            changed.append(name)
        if not args.dry_run:
            shutil.copy2(src, dst)

    for name in INCLUDE_DIRS:
        src = MOBILE / name
        if not src.is_dir():
            continue
        if args.dry_run:
            continue
        _copy_tree(src, DEPLOY / name, changed)

    if args.dry_run:
        print("Would update:", ", ".join(changed) if changed else "nothing")
        return 0

    status = _run(["git", "status", "--porcelain"], DEPLOY)
    if not status.stdout.strip():
        print("Already up to date — nothing to deploy.")
        return 0

    print("Changed:")
    for line in status.stdout.strip().splitlines():
        print("  " + line)

    _run(["git", "add", "-A"], DEPLOY)
    _run(["git", "commit", "-m", args.message], DEPLOY)
    push = _run(["git", "push"], DEPLOY, check=False)
    if push.returncode != 0:
        print("Push failed:\n" + (push.stderr or push.stdout), file=sys.stderr)
        return 1

    print("\nDeployed. Pages usually takes 30-60s to pick it up:")
    print("  https://tony-giannetti.github.io/slabwizard-capture/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
