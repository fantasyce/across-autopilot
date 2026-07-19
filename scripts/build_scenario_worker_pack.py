from __future__ import annotations

from pathlib import Path
import argparse
import gzip
import io
import json
import tarfile


LAUNCHER = b'''#!/bin/sh
if [ -n "${ACROSS_WORKER_PYTHON:-}" ] && [ -x "$ACROSS_WORKER_PYTHON" ]; then
  exec "$ACROSS_WORKER_PYTHON" "$(dirname "$0")/../lib/scenario_simulation.py" "$@"
fi
exec python3 "$(dirname "$0")/../lib/scenario_simulation.py" "$@"
'''


def build(root: Path, output: Path, *, version: str, source_date_epoch: int = 0) -> Path:
    files = {
        "bin/across-scenario-simulation": (LAUNCHER, 0o755),
        "lib/scenario-simulation.js": ((root / "src" / "scenario-simulation.js").read_bytes(), 0o644),
        "lib/scenario_simulation.py": ((root / "src" / "scenario_simulation.py").read_bytes(), 0o755),
        "pack.json": (
            (
                json.dumps(
                    {
                        "schema_version": "across-worker-pack/1.0",
                        "pack_id": "scenario-simulation",
                        "version": version,
                        "entrypoint": "bin/across-scenario-simulation",
                        "runtime": "python>=3.11",
                        "contains_provider_credentials": False,
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                + "\n"
            ).encode("utf-8"),
            0o644,
        ),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with (
        output.open("wb") as raw,
        gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=source_date_epoch) as compressed,
        tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive,
    ):
        for name, (body, mode) in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.size = len(body)
            info.mode = mode
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mtime = source_date_epoch
            archive.addfile(info, io.BytesIO(body))
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the deterministic Scenario Simulation Worker pack")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--output", required=True)
    parser.add_argument("--version", default="1.0.11")
    parser.add_argument("--source-date-epoch", type=int, default=0)
    args = parser.parse_args()
    print(build(Path(args.root).resolve(), Path(args.output).resolve(), version=args.version, source_date_epoch=args.source_date_epoch))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
