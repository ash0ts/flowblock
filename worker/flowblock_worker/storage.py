"""Private object-key access. No user-provided URLs are fetched."""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

from .video import MAX_BYTES


def validate_key(key: str) -> str:
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,1023}", key):
        raise ValueError("Invalid private object key")
    if any(part in ("", ".", "..") for part in key.split("/")):
        raise ValueError("Private object key contains an invalid path segment")
    return key


class ObjectStore:
    def __init__(self):
        self.bucket = os.environ.get("S3_BUCKET") or os.environ.get("FLOWBLOCK_S3_BUCKET")
        self.root = Path(
            os.environ.get(
                "FLOWBLOCK_STORAGE_DIR",
                str(Path(__file__).resolve().parents[2] / ".data" / "media"),
            )
        ).resolve()
        self.client = None
        if self.bucket:
            import boto3
            from botocore.config import Config

            self.client = boto3.client(
                "s3",
                endpoint_url=os.environ.get("S3_ENDPOINT")
                or os.environ.get("FLOWBLOCK_S3_ENDPOINT")
                or "https://cwobject.com",
                region_name=os.environ.get("AWS_REGION", "US"),
                config=Config(s3={"addressing_style": "virtual"}),
            )

    def local_path(self, key: str) -> Path:
        path = (self.root / validate_key(key)).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError("Object key escapes private storage")
        return path

    def download(self, key: str, destination: Path) -> None:
        validate_key(key)
        if self.client:
            metadata = self.client.head_object(Bucket=self.bucket, Key=key)
            if not 0 < metadata["ContentLength"] <= MAX_BYTES:
                raise ValueError("Object exceeds the 256 MiB input limit")
            response = self.client.get_object(Bucket=self.bucket, Key=key)
            total = 0
            with response["Body"] as body, destination.open("wb") as target:
                for block in iter(lambda: body.read(1024 * 1024), b""):
                    total += len(block)
                    if total > MAX_BYTES:
                        raise ValueError("Object exceeds the 256 MiB input limit")
                    target.write(block)
        else:
            source = self.local_path(key)
            if not 0 < source.stat().st_size <= MAX_BYTES:
                raise ValueError("Object exceeds the 256 MiB input limit")
            shutil.copyfile(source, destination)

    def upload(self, source: Path, key: str, content_type: str) -> None:
        validate_key(key)
        if self.client:
            self.client.upload_file(
                str(source),
                self.bucket,
                key,
                ExtraArgs={"ContentType": content_type, "ServerSideEncryption": "AES256"},
            )
        else:
            target = self.local_path(key)
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix + ".part")
            shutil.copyfile(source, temporary)
            temporary.replace(target)

    def delete(self, key: str) -> None:
        validate_key(key)
        if self.client:
            self.client.delete_object(Bucket=self.bucket, Key=key)
        else:
            self.local_path(key).unlink(missing_ok=True)
            self.local_path(key).with_suffix(self.local_path(key).suffix + ".part").unlink(
                missing_ok=True
            )

    def delete_prefix(self, prefix: str) -> None:
        prefix = validate_key(prefix.rstrip("/"))
        if self.client:
            paginator = self.client.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix + "/"):
                objects = [{"Key": item["Key"]} for item in page.get("Contents", [])]
                if objects:
                    response = self.client.delete_objects(
                        Bucket=self.bucket, Delete={"Objects": objects}
                    )
                    if response.get("Errors"):
                        raise RuntimeError("Could not remove all unpublished analysis objects")
        else:
            directory = self.local_path(prefix)
            if directory.exists():
                shutil.rmtree(directory)
