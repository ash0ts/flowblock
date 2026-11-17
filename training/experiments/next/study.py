"""Collect and score consented creator-study records. No participant outcomes are synthesized."""
from __future__ import annotations
import argparse
import csv
import json
from datetime import datetime, timezone
import os
from uuid import uuid4
from pathlib import Path

TABLES = {
    "creators": ["creator_id", "experience_band", "device_class", "consent_study", "consent_training"],
    "assignments": ["assignment_id", "creator_id", "arm", "brief_id", "product_id", "order_index", "session_start_utc", "session_start_monotonic", "session_cap_seconds", "session_end_monotonic", "abandoned_reason"],
    "attempts": ["attempt_id", "assignment_id", "rating_id", "plan_version", "record_start_monotonic", "record_end_monotonic", "original_sha256"],
    "events": ["event_id", "assignment_id", "attempt_id", "kind", "start_monotonic", "end_monotonic", "analysis_version", "finding_ids", "correction_shown", "correction_accepted", "reason"],
    "ratings": ["rating_id", "reviewer_id", "role", "usable", "reason"],
}
ARMS = {"existing", "recipe", "flowblock-practice", "flowblock-feedback"}


def boolean(value: str) -> bool:
    if value not in {"true", "false"}:
        raise ValueError("Boolean cells must contain true or false.")
    return value == "true"


def number(value: str) -> float:
    result = float(value)
    if not (0 <= result < float("inf")):
        raise ValueError("Times must be finite nonnegative numbers.")
    return result


def read(directory: Path) -> dict[str, list[dict[str, str]]]:
    result = {}
    for table, columns in TABLES.items():
        with (directory / f"{table}.csv").open(newline="") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames != columns:
                raise ValueError(f"Unexpected {table} columns.")
            result[table] = list(reader)
    return result


def unique(rows, key):
    mapped = {}
    for row in rows:
        if not row[key] or row[key] in mapped:
            raise ValueError(f"Missing or duplicate {key}.")
        mapped[row[key]] = row
    return mapped


def validate(data):
    creators = unique(data["creators"], "creator_id")
    assignments = unique(data["assignments"], "assignment_id")
    attempts = unique(data["attempts"], "attempt_id")
    unique(data["attempts"], "rating_id")
    unique(data["events"], "event_id")
    creator_arms, orders = {}, set()
    for creator in creators.values():
        boolean(creator["consent_study"])
        boolean(creator["consent_training"])
    for assignment in assignments.values():
        creator = creators.get(assignment["creator_id"])
        if creator is None or not boolean(creator["consent_study"]):
            raise ValueError("An assignment requires a consenting creator.")
        arm = assignment["arm"]
        if arm not in ARMS:
            raise ValueError("Unknown study arm.")
        previous = creator_arms.setdefault(assignment["creator_id"], arm)
        if previous != arm:
            raise ValueError("This parallel-arm protocol assigns one arm per creator.")
        order = int(assignment["order_index"])
        key = (assignment["creator_id"], order)
        if order < 1 or key in orders:
            raise ValueError("Creator job orders must be unique positive integers.")
        orders.add(key)
        anchor = datetime.fromisoformat(assignment["session_start_utc"].replace("Z", "+00:00"))
        if anchor.tzinfo is None or anchor.utcoffset().total_seconds() != 0:
            raise ValueError("Session wall-clock anchors must be explicit UTC timestamps.")
        start = number(assignment["session_start_monotonic"])
        cap = number(assignment["session_cap_seconds"])
        if cap <= 0:
            raise ValueError("A positive session cap is required.")
        if assignment["session_end_monotonic"]:
            end = number(assignment["session_end_monotonic"])
            if not start <= end <= start + cap:
                raise ValueError("A session end must lie within its declared cap.")
    for attempt in attempts.values():
        assignment = assignments.get(attempt["assignment_id"])
        if assignment is None:
            raise ValueError("Attempt references an unknown assignment.")
        start, end = number(attempt["record_start_monotonic"]), number(attempt["record_end_monotonic"])
        session_start = number(assignment["session_start_monotonic"])
        session_end = number(assignment["session_end_monotonic"]) if assignment["session_end_monotonic"] else session_start + number(assignment["session_cap_seconds"])
        if not session_start <= start <= end <= session_end:
            raise ValueError("Capture must lie inside its session.")
        if len(attempt["original_sha256"]) != 64 or any(c not in "0123456789abcdef" for c in attempt["original_sha256"]):
            raise ValueError("Every attempt requires the original media hash.")
    rating_ids = {row["rating_id"] for row in attempts.values()}
    ratings = {}
    for rating in data["ratings"]:
        if rating["rating_id"] not in rating_ids or rating["role"] not in {"independent", "adjudicator"} or not rating["reviewer_id"]:
            raise ValueError("Invalid blinded rating identity or role.")
        boolean(rating["usable"])
        group = ratings.setdefault(rating["rating_id"], [])
        if any(row["reviewer_id"] == rating["reviewer_id"] for row in group):
            raise ValueError("A reviewer cannot rate or adjudicate the same take twice.")
        group.append(rating)
        if sum(row["role"] == "independent" for row in group) > 2 or sum(row["role"] == "adjudicator" for row in group) > 1:
            raise ValueError("Each take has two independent ratings and at most one adjudication.")
    for event in data["events"]:
        assignment = assignments.get(event["assignment_id"])
        if assignment is None:
            raise ValueError("Event references an unknown assignment.")
        if event["attempt_id"] and (event["attempt_id"] not in attempts or attempts[event["attempt_id"]]["assignment_id"] != event["assignment_id"]):
            raise ValueError("Event attempt and assignment differ.")
        start, end = number(event["start_monotonic"]), number(event["end_monotonic"])
        session_start = number(assignment["session_start_monotonic"])
        session_end = number(assignment["session_end_monotonic"]) if assignment["session_end_monotonic"] else session_start + number(assignment["session_cap_seconds"])
        if not session_start <= start <= end <= session_end:
            raise ValueError("An event interval must lie inside its session.")
        shown, accepted = boolean(event["correction_shown"]), boolean(event["correction_accepted"])
        if shown and assignment["arm"] != "flowblock-feedback":
            raise ValueError("Corrections are withheld in all control arms.")
        if accepted and not shown:
            raise ValueError("An accepted correction must have been shown.")
    return assignments, attempts, ratings


def consensus(rows):
    independent = [boolean(row["usable"]) for row in rows if row["role"] == "independent"]
    if len(independent) != 2:
        return None
    if independent[0] == independent[1]:
        return independent[0]
    adjudications = [boolean(row["usable"]) for row in rows if row["role"] == "adjudicator"]
    return adjudications[0] if len(adjudications) == 1 else None


def score(data):
    assignments, attempts, ratings = validate(data)
    records = []
    for assignment in assignments.values():
        takes = [take for take in attempts.values() if take["assignment_id"] == assignment["assignment_id"]]
        outcomes = [(take, consensus(ratings.get(take["rating_id"], []))) for take in takes]
        common = {"assignment_id": assignment["assignment_id"], "creator_id": assignment["creator_id"], "arm": assignment["arm"], "brief_id": assignment["brief_id"], "attempts": len(takes)}
        if not assignment["session_end_monotonic"] or any(usable is None for _, usable in outcomes):
            records.append({**common, "status": "incomplete", "event": None, "time_seconds": None})
            continue
        start = number(assignment["session_start_monotonic"])
        usable = [take for take, success in outcomes if success]
        earliest = min(usable, key=lambda take: number(take["record_end_monotonic"])) if usable else None
        end = number(earliest["record_end_monotonic"]) if earliest else number(assignment["session_end_monotonic"])
        records.append({**common, "status": "scored", "event": earliest is not None, "time_seconds": end - start, "first_usable_attempt": earliest["attempt_id"] if earliest else None, "censoring_reason": None if earliest else assignment["abandoned_reason"] or "session-ended-without-usable-take"})
    summaries = []
    for arm in sorted(ARMS):
        rows = [row for row in records if row["arm"] == arm]
        completed = [row for row in rows if row["status"] == "scored"]
        events = sum(row["event"] for row in completed)
        summaries.append({"arm": arm, "creators": len({row["creator_id"] for row in rows}), "assignments": len(rows), "scored": len(completed), "incomplete": len(rows) - len(completed), "usable": events, "censored": len(completed) - events, "usable_fraction_scored": events / len(completed) if completed else None})
    return {"schemaVersion": 1, "status": "empty-collection" if not records else "collected-data-summary", "records": records, "arms": summaries, "limitations": ["Descriptive collection output, not a powered causal analysis. Jobs and attempts within a creator are dependent.", "Incomplete ratings or sessions are not silently scored as failures. Every take is retained.", "Censored sessions are retained; do not average only successful times or treat missing takes as zero-time events.", "Random assignment, counterbalanced job order, independent blinded rating and consent must be verified separately before causal claims."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["init", "validate", "append", "close-session", "score", "rating-manifest"])
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--table", choices=list(TABLES))
    parser.add_argument("--row-json", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--assignment-id")
    parser.add_argument("--end-monotonic")
    parser.add_argument("--abandoned-reason", default="")
    args = parser.parse_args()
    if args.command == "init":
        args.directory.mkdir(parents=True, exist_ok=False)
        for table, columns in TABLES.items():
            with (args.directory / f"{table}.csv").open("x", newline="") as handle:
                csv.writer(handle).writerow(columns)
        print(json.dumps({"status": "blank-collection-created", "tables": list(TABLES)}))
        return
    data = read(args.directory)
    if args.command == "close-session":
        if not args.assignment_id or args.end_monotonic is None:
            parser.error("close-session requires --assignment-id and --end-monotonic")
        assignment = next((row for row in data["assignments"] if row["assignment_id"] == args.assignment_id), None)
        if assignment is None or assignment["session_end_monotonic"]:
            raise ValueError("Only an existing open session can be closed.")
        previous = dict(assignment)
        assignment.update(session_end_monotonic=args.end_monotonic, abandoned_reason=args.abandoned_reason)
        validate(data)
        audit = {"operation": "close-session", "recorded_at": datetime.now(timezone.utc).isoformat(), "before": previous, "after": assignment}
        audit_path = args.directory / f"session-close-{uuid4()}.json"
        with audit_path.open("x") as handle:
            json.dump(audit, handle, indent=2)
        temporary = args.directory / f"assignments-{uuid4()}.tmp"
        with temporary.open("x", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=TABLES["assignments"])
            writer.writeheader()
            writer.writerows(data["assignments"])
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, args.directory / "assignments.csv")
        print(json.dumps({"status": "session-closed", "assignment_id": args.assignment_id, "audit": audit_path.name}))
        return
    if args.command == "append":
        if not args.table or not args.row_json:
            parser.error("append requires --table and --row-json")
        row = json.loads(args.row_json.read_text())
        if set(row) != set(TABLES[args.table]) or any(not isinstance(value, str) for value in row.values()):
            raise ValueError("A row must contain exactly the table columns, as strings.")
        data[args.table].append(row)
        validate(data)
        with (args.directory / f"{args.table}.csv").open("a", newline="") as handle:
            csv.DictWriter(handle, fieldnames=TABLES[args.table]).writerow(row)
        print(json.dumps({"status": "row-appended", "table": args.table}))
        return
    validate(data)
    if args.command == "validate":
        print(json.dumps({"status": "valid", "rows": {key: len(rows) for key, rows in data.items()}}))
    elif args.command == "rating-manifest":
        if not args.output:
            parser.error("rating-manifest requires --output")
        with args.output.open("x", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=["rating_id", "original_sha256"])
            writer.writeheader()
            for row in sorted(data["attempts"], key=lambda item: item["rating_id"]):
                writer.writerow({key: row[key] for key in writer.fieldnames})
    else:
        result = json.dumps(score(data), indent=2) + "\n"
        if args.output:
            with args.output.open("x") as handle:
                handle.write(result)
        else:
            print(result, end="")


if __name__ == "__main__":
    main()
