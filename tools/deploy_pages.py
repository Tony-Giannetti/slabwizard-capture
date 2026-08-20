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
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List

MOBILE = Path(__file__).resolve().parent.parent
DEPLOY = MOBILE.parent.parent.parent / "slabwizard-capture"
REMOTE = "https://github.com/Tony-Giannetti/slabwizard-capture.git"
PAGES_URL = "https://tony-giannetti.github.io/slabwizard-capture/"

# Everything the browser needs, plus the docs and the icon generator.
INCLUDE_FILES = ["index.html", "styles.css", "app.js", "config.js",
                 "manifest.webmanifest", "sw.js", "README.md"]
INCLUDE_DIRS = ["js", "icons", "tools", "vendor"]
SKIP_NAMES = {"__pycache__", ".DS_Store", "Thumbs.db"}

_CACHE_RE = re.compile(r'(const CACHE = "slabwizard-capture-v)(\d+)(";)')


def _run(args, cwd, check=True) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=str(cwd), check=check,
                          capture_output=True, text=True)


def _skip(item: Path) -> bool:
    return (item.name in SKIP_NAMES
            or item.name.endswith((".tmp", ".tmp.mjs", ".pyc")))


def _sync_dir(src: Path, dst: Path, rel: str, copy: bool,
              changed: List[str]) -> None:
    for item in sorted(src.iterdir()):
        if _skip(item):
            continue
        target = dst / item.name
        name = f"{rel}/{item.name}"
        if item.is_dir():
            if copy:
                target.mkdir(parents=True, exist_ok=True)
            elif not target.exists():
                changed.append(name + "/")
                continue
            _sync_dir(item, target, name, copy, changed)
        else:
            if not target.exists() or not filecmp.cmp(item, target,
                                                      shallow=False):
                changed.append(name)
            if copy:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(item, target)


def sync(copy: bool) -> List[str]:
    """Compare (and optionally copy) mobile/ into the deploy clone."""
    changed: List[str] = []
    for name in INCLUDE_FILES:
        src = MOBILE / name
        if not src.is_file():
            print(f"  missing (skipped): {name}")
            continue
        dst = DEPLOY / name
        if not dst.exists() or not filecmp.cmp(src, dst, shallow=False):
            changed.append(name)
        if copy:
            shutil.copy2(src, dst)

    for name in INCLUDE_DIRS:
        src = MOBILE / name
        if src.is_dir():
            if copy:
                (DEPLOY / name).mkdir(parents=True, exist_ok=True)
            _sync_dir(src, DEPLOY / name, name, copy, changed)
    return changed


def bump_cache_version() -> str:
    """Increment the service worker's cache name in the SOURCE tree.

    Without this the browser keeps the previous cache on activate, and a
    phone that already installed the app serves the old bundle — including
    an old config.js — indefinitely. Bumping is not optional on a deploy,
    so it is not left to whoever is deploying to remember.
    """
    sw = MOBILE / "sw.js"
    text = sw.read_text(encoding="utf-8")
    match = _CACHE_RE.search(text)
    if not match:
        print("  WARNING: could not find the CACHE constant in sw.js — "
              "phones may keep serving the old bundle.")
        return "?"
    version = int(match.group(2)) + 1
    sw.write_text(_CACHE_RE.sub(r"\g<1>%d\g<3>" % version, text),
                  encoding="utf-8")

    # Stamp the same version into the Settings screen, so "which build is
    # this phone actually running?" is answerable by looking at it.
    index = MOBILE / "index.html"
    html = index.read_text(encoding="utf-8")
    stamped = re.sub(r'(<span id="app-version">)v\d+(</span>)',
                     r"\g<1>v%d\g<2>" % version, html)
    if stamped != html:
        index.write_text(stamped, encoding="utf-8")
    else:
        print("  WARNING: app-version span not found in index.html — "
              "the visible version was not stamped.")
    return "v%d" % version


def verify_modules() -> None:
    """Abort the deploy unless every ES module parses AS A MODULE.

    ``node --check foo.js`` parses CommonJS and has passed files with real
    syntax errors; copying to .mjs forces the ESM parse goal. One broken
    module kills the entire app (dead buttons, no errors on screen), so
    nothing ships unverified.
    """
    import tempfile
    files = [MOBILE / "app.js", MOBILE / "config.js",
             *sorted((MOBILE / "js").glob("*.js"))]
    with tempfile.TemporaryDirectory() as tmp:
        for f in files:
            probe = Path(tmp) / (f.stem + ".mjs")
            probe.write_text(f.read_text(encoding="utf-8"), encoding="utf-8")
            r = subprocess.run(["node", "--check", str(probe)],
                               capture_output=True, text=True)
            if r.returncode != 0:
                raise SystemExit(
                    "DEPLOY ABORTED - %s does not parse as an ES module:\n%s"
                    % (f.name, r.stderr.strip()))
    print("verified %d modules parse as ESM" % len(files))


def generate_shell() -> None:
    """Regenerate sw.js's SHELL list from the actual file tree.

    A hand-maintained list drifts (js/diag.js shipped outside it); a file
    missing from the shell escapes the atomic versioned precache and can
    mix versions with the rest of the module graph.
    """
    entries = ['"./"', '"./index.html"', '"./styles.css"', '"./app.js"',
               '"./config.js"', '"./manifest.webmanifest"']
    entries += sorted('"./js/%s"' % f.name
                      for f in (MOBILE / "js").glob("*.js"))
    entries += sorted('"./icons/%s"' % f.name
                      for f in (MOBILE / "icons").glob("*.png"))
    body = ("const SHELL = [\n"
            + "".join("  %s,\n" % e for e in entries)
            + "];")
    sw = MOBILE / "sw.js"
    text = sw.read_text(encoding="utf-8")
    new_text = re.sub(r"const SHELL = \[.*?\];", body, text, flags=re.S)
    if new_text == text and "const SHELL" not in text:
        print("  WARNING: SHELL list not found in sw.js")
    sw.write_text(new_text, encoding="utf-8")


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

    pending = sync(copy=False)
    if not pending:
        print("Already up to date — nothing to deploy.")
        return 0

    print("Changed:")
    for name in pending:
        print("  " + name)

    if args.dry_run:
        print("\n--dry-run: nothing copied, pushed, or version-bumped.")
        return 0

    verify_modules()
    generate_shell()
    # Bump BEFORE the copy so the new version ships in this same push.
    print(f"Service worker cache -> {bump_cache_version()}")
    sync(copy=True)

    status = _run(["git", "status", "--porcelain"], DEPLOY)
    if not status.stdout.strip():
        print("Deploy clone is already identical — nothing to push.")
        return 0

    _run(["git", "add", "-A"], DEPLOY)
    _run(["git", "commit", "-m", args.message], DEPLOY)
    push = _run(["git", "push"], DEPLOY, check=False)
    if push.returncode != 0:
        print("Push failed:\n" + (push.stderr or push.stdout), file=sys.stderr)
        return 1

    print(f"\nDeployed. Pages usually takes 30-60s to pick it up:\n  {PAGES_URL}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
