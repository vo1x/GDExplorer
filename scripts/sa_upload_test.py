#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path


def extract_folder_id(value: str) -> str:
    if "http" not in value:
        return value
    patterns = [
        r"/folders/([a-zA-Z0-9_-]+)",
        r"[?&]id=([a-zA-Z0-9_-]+)",
        r"/u/\d+/folders/([a-zA-Z0-9_-]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, value)
        if match:
            return match.group(1)
    raise ValueError(f"Unable to extract folder id from: {value}")


def sanitize_name(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-_") or "sa"


def load_sa_files(sa_dir: Path) -> list[Path]:
    return sorted(
        [p for p in sa_dir.iterdir() if p.is_file() and p.suffix.lower() == ".json"]
    )


def read_sa_email(path: Path) -> str:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return "unknown"
    return data.get("client_email") or "unknown"


def build_dest_name(base_name: str, email: str) -> str:
    local = email.split("@")[0] if "@" in email else email
    return f"{base_name}--{sanitize_name(local)}.txt"


def run_rclone(
    rclone_path: str,
    source: Path,
    remote_name: str,
    folder_id: str,
    sa_path: Path,
    dest_name: str,
) -> tuple[bool, str, str | None]:
    dest = f"{remote_name}:{dest_name}"
    args = [
        rclone_path,
        "copyto",
        str(source),
        dest,
        "--drive-root-folder-id",
        folder_id,
        "--drive-service-account-file",
        str(sa_path),
        "--log-level",
        "INFO",
        "--use-json-log",
    ]
    proc = subprocess.run(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    output = proc.stdout or ""
    reason = extract_failure_reason(output)
    return proc.returncode == 0, output, reason


def extract_failure_reason(output: str) -> str | None:
    for line in output.splitlines():
        if "\"level\":\"error\"" in line or "level\":\"ERROR\"" in line:
            return line.strip()
        if "ERROR" in line or "error" in line:
            return line.strip()
    return None


def create_test_files(sa_files: list[Path], base_dir: Path) -> list[Path]:
    base_dir.mkdir(parents=True, exist_ok=True)
    files: list[Path] = []
    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    for idx, sa_path in enumerate(sa_files, start=1):
        email = read_sa_email(sa_path)
        name = f"gdexplorer-sa-test-{timestamp}-{idx:03d}-{sanitize_name(email)}.txt"
        path = base_dir / name
        path.write_text("GDExplorer SA test upload.\n", encoding="utf-8")
        files.append(path)
    return files


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Test each service account by uploading a small file to Drive."
    )
    parser.add_argument("--sa-dir", required=True, help="Folder with SA JSON files")
    parser.add_argument("--rclone", default="rclone", help="Path to rclone binary")
    parser.add_argument("--remote", required=True, help="Rclone remote name")
    parser.add_argument(
        "--dest",
        required=True,
        help="Destination folder id or Drive folder URL",
    )
    parser.add_argument(
        "--file",
        help="Path to test file (.txt). If omitted, a temp file is created.",
    )
    parser.add_argument(
        "--parallel",
        type=int,
        default=4,
        help="Number of concurrent uploads (default: 4)",
    )
    parser.add_argument(
        "--log-file",
        default="sa_upload_test.log",
        help="Output log file",
    )
    args = parser.parse_args()

    sa_dir = Path(args.sa_dir).expanduser()
    if not sa_dir.is_dir():
        print(f"SA dir not found: {sa_dir}", file=sys.stderr)
        return 1

    folder_id = extract_folder_id(args.dest)
    sa_files = load_sa_files(sa_dir)
    if not sa_files:
        print(f"No SA JSON files in: {sa_dir}", file=sys.stderr)
        return 1

    temp_file: Path | None = None
    temp_dir: Path | None = None
    if args.file:
        source = Path(args.file).expanduser()
        if not source.is_file():
            print(f"Test file not found: {source}", file=sys.stderr)
            return 1
    else:
        temp_dir = Path(tempfile.gettempdir()) / "gdexplorer-sa-test"
        test_files = create_test_files(sa_files, temp_dir)
        source = test_files[0]
        temp_file = None

    log_path = Path(args.log_file).expanduser()
    log_lines = []
    success = 0
    failed = 0
    failed_emails: list[str] = []

    work = []
    for idx, sa_path in enumerate(sa_files):
        email = read_sa_email(sa_path)
        if args.file:
            file_path = source
        else:
            file_path = test_files[idx] if temp_dir else source
        dest_name = build_dest_name(Path(file_path).stem, email)
        work.append((sa_path, email, file_path, dest_name))

    max_workers = max(1, args.parallel)
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_map = {
            executor.submit(
                run_rclone,
                args.rclone,
                file_path,
                args.remote,
                folder_id,
                sa_path,
                dest_name,
            ): (sa_path, email, dest_name)
            for sa_path, email, file_path, dest_name in work
        }
        for future in as_completed(future_map):
            sa_path, email, dest_name = future_map[future]
            ok, output, reason = future.result()
            status = "OK" if ok else "FAIL"
            line = f"[{status}] {sa_path.name} ({email})"
            print(line)
            log_lines.append(line)
            if not ok:
                reason_line = f"(failed because {reason or 'unknown error'})"
                print(reason_line)
                log_lines.append(reason_line)
            if ok:
                success += 1
            else:
                failed += 1
                if email != "unknown":
                    failed_emails.append(email)

    summary = f"Summary: {success} succeeded, {failed} failed"
    print(summary)
    log_lines.append(summary)
    if failed_emails:
        unique_failed = sorted(set(failed_emails))
        failed_block = "\n".join(unique_failed)
        print("Emails to add to destination drive:")
        print(failed_block)
        log_lines.append("Emails to add to destination drive:")
        log_lines.append(failed_block)
    log_path.write_text("\n".join(log_lines) + "\n", encoding="utf-8")
    print(f"Log written to: {log_path}")

    if temp_file and temp_file.exists():
        temp_file.unlink(missing_ok=True)
    if temp_dir and temp_dir.exists() and not args.file:
        for entry in temp_dir.iterdir():
            if entry.is_file():
                entry.unlink(missing_ok=True)

    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
