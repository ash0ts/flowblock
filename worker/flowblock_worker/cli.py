from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .model import ROOT, Segmenter, manifest, sha256, verified_paths


def setup_model():
    config = manifest()
    checkout = Path(os.environ.get("FLOWBLOCK_SAM2_DIR", str(ROOT / "vendor" / "sam2")))
    checkpoint = Path(
        os.environ.get(
            "FLOWBLOCK_CHECKPOINT", str(ROOT / "models" / config["checkpoint"]["filename"])
        )
    )
    checkout.parent.mkdir(parents=True, exist_ok=True)
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    if not checkout.exists():
        subprocess.run(
            [
                "git",
                "clone",
                "--filter=blob:none",
                "--no-checkout",
                config["repository"]["url"],
                str(checkout),
            ],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(checkout), "checkout", config["repository"]["commit"]], check=True
        )
    if not checkpoint.is_file() or sha256(checkpoint) != config["checkpoint"]["sha256"]:
        temporary = checkpoint.with_suffix(".part")
        try:
            with (
                urllib.request.urlopen(config["checkpoint"]["url"], timeout=60) as source,
                temporary.open("wb") as target,
            ):
                shutil.copyfileobj(source, target)
            if sha256(temporary) != config["checkpoint"]["sha256"]:
                raise RuntimeError("Downloaded checkpoint failed SHA-256 verification")
            temporary.replace(checkpoint)
        finally:
            temporary.unlink(missing_ok=True)
    verified_paths()
    print(
        json.dumps(
            {
                "ready": True,
                "repositoryCommit": config["repository"]["commit"],
                "checkpointSha256": config["checkpoint"]["sha256"],
            }
        )
    )


def health_server(health: dict, port: int):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path not in ("/healthz", "/readyz"):
                self.send_error(404)
                return
            ready = health.get("ready", False) and health.get("databaseAvailable", True)
            self.send_response(200 if self.path == "/healthz" or ready else 503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({**health, "ready": ready}).encode())

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(
        (os.environ.get("FLOWBLOCK_HEALTH_HOST", "127.0.0.1"), port), Handler
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main():
    parser = argparse.ArgumentParser(description="Real SAM 2.1 product segmentation worker")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("setup-model", help="Fetch and verify the pinned model and source")
    check = commands.add_parser(
        "check", help="Verify binaries, checkpoint, source, and chosen compute device"
    )
    process_command = commands.add_parser(
        "process", help="Analyze an explicit local video and manifest"
    )
    process_command.add_argument("--input", type=Path, required=True)
    process_command.add_argument("--manifest", type=Path, required=True)
    process_command.add_argument("--output", type=Path, required=True)
    serve = commands.add_parser("serve", help="Consume leased PostgreSQL analysis jobs")
    serve.add_argument("--once", action="store_true")
    serve.add_argument(
        "--health-port", type=int, default=int(os.environ.get("FLOWBLOCK_WORKER_PORT", "8091"))
    )
    for command in (check, process_command, serve):
        command.add_argument(
            "--device",
            choices=("cuda", "mps", "cpu"),
            default=os.environ.get("FLOWBLOCK_DEVICE", "cuda"),
        )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    if args.command == "setup-model":
        setup_model()
        return
    for binary in ("ffmpeg", "ffprobe", "git"):
        if not shutil.which(binary):
            parser.error(f"Required executable not found: {binary}")
    health = {"ready": False, "device": args.device, "model": "SAM 2.1 Small", "busy": False}
    server = health_server(health, args.health_port) if args.command == "serve" else None
    try:
        segmenter = Segmenter(args.device)
        if args.command == "check":
            print(
                json.dumps(
                    {
                        "ready": True,
                        "device": args.device,
                        "model": "SAM 2.1 Small",
                        "checkpointVerified": True,
                    }
                )
            )
        elif args.command == "process":
            from .pipeline import process

            result = process(
                args.input, json.loads(args.manifest.read_text()), args.output, segmenter
            )
            print(
                json.dumps(
                    {
                        "output": str(args.output / "analysis.json"),
                        "coverage": result["coverage"],
                        "device": args.device,
                    }
                )
            )
        else:
            from .jobs import serve_queue

            serve_queue(segmenter, health, args.once)
    finally:
        if server:
            server.shutdown()


if __name__ == "__main__":
    main()
