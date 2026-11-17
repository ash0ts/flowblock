"""Summarize recorded development outcomes without loading a planner or checker."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path

VERSION = "flowblock-recorded-development-diagnostics-v1"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fraction(numerator: int, denominator: int) -> dict:
    return {"count": numerator, "denominator": denominator, "rate": numerator / denominator if denominator else None}


def object_value(value) -> dict:
    return value if isinstance(value, dict) else {}


def diagnose(directory: Path, output: Path) -> dict:
    directory, output = directory.resolve(), output.resolve()
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest["split"] != "development":
        raise ValueError("This diagnostic is limited to development; confirmation must remain separately reported.")
    if digest(directory / manifest["taskFile"]) != manifest["tasksSha256"]:
        raise ValueError("Task-file hash changed.")
    tasks = {row["id"]: row for row in json.loads((directory / manifest["taskFile"]).read_text())}
    entries = [json.loads(line) for line in (directory / "results.jsonl").read_text().splitlines() if line]
    if len(entries) != len(manifest["taskIds"]) or len({row["taskId"] for row in entries}) != len(entries):
        raise ValueError("A completed campaign with unique result rows is required.")
    entries = {row["taskId"]: row for row in entries}
    raw = []
    for task_id in manifest["taskIds"]:
        path = directory / f"{task_id}.json"
        row = json.loads(path.read_text())
        if row["entry"] != entries[task_id] or row["task"] != tasks[task_id]:
            raise ValueError(f"Raw receipt disagrees with recorded result/task: {task_id}")
        raw.append(row)
    total = len(raw)
    available = [row for row in raw if row["entry"]["available"]]
    plans = [(row, grade) for row in available for grade in row["entry"]["grade"]["planGrades"]]
    events = [(row, index, event) for row in raw for index, event in enumerate((row.get("result") or {}).get("events", []))]
    compiles = [(row, index, event) for row, index, event in events if object_value(event["action"]).get("action") == "compile_candidate" and isinstance(object_value(event["observation"]).get("validation", {}).get("valid"), bool)]
    invalid_compiles = [(row, index, event) for row, index, event in compiles if not event["observation"]["validation"]["valid"]]
    invalid_replies = [(row, index, event) for row, index, event in events if object_value(event["observation"]).get("error") == "invalid_action"]
    revision_errors = [(row, index, event) for row, index, event in events if object_value(event["action"]).get("action") == "propose_revision" and object_value(event["observation"]).get("error")]
    known = [row for row in available if row["entry"]["grade"]["knownFeasible"]]
    calls = [(row, call) for row in raw for call in row["calls"]]
    refs = lambda name: os.path.relpath(directory / name, output.parent)

    def evidence(row, index=None):
        task_id = row["taskId"]
        ref = {"taskId": task_id, "receiptPath": refs(f"{task_id}.json"), "receiptSha256": digest(directory / f"{task_id}.json"), "traceId": row["entry"].get("traceId")}
        if index is not None:
            event = row["result"]["events"][index]
            ref.update(eventIndex=index, eventPointer=f"/result/events/{index}")
            # Pair by recorded action content, not a guessed event/call offset.
            candidates = []
            for call in row["calls"]:
                content = object_value(call.get("response")).get("content")
                try:
                    action = json.loads(content)
                except (TypeError, json.JSONDecodeError):
                    action = content
                if action == event["action"]:
                    candidates.append(call["index"])
            ref["matchingCallIndices"] = candidates
            ref["callResponsePaths"] = [refs(f"calls/{task_id}/{i}-response.json") for i in candidates if (directory / f"calls/{task_id}/{i}-response.json").exists()]
            ref["action"] = event["action"]
            observation = object_value(event["observation"])
            ref["observation"] = {key: value for key, value in observation.items() if key in {"error", "issues", "candidateId", "recipeId", "family", "motion", "cameraHeight", "durationSeconds", "compileChecks", "accepted"}}
            if "validation" in observation:
                ref["observation"]["validation"] = {"valid": observation["validation"]["valid"], "violationCodes": sorted({v["code"] for v in observation["validation"]["violations"] if v["severity"] == "error"})}
        return ref

    criteria = {}
    for key in sorted({key for _, grade in plans for key in grade["checks"]}):
        assessed = [(row, grade) for row, grade in plans if isinstance(grade["checks"].get(key), bool)]
        failed = [(row, grade) for row, grade in assessed if grade["checks"][key] is False]
        criteria[key] = {"passed": len(assessed) - len(failed), "failed": fraction(len(failed), len(assessed)), "unit": "credited returned plan", "missing": len(plans) - len(assessed), "examples": [evidence(row) for row, _ in failed[:2]]}
    families = []
    for family in ["hold", "push-in", "pull-out", "lateral", "orbit", "reveal"]:
        family_rows = [row for row in raw if row["task"]["briefSpec"]["family"] == family]
        fa = [row for row in family_rows if row["entry"]["available"]]
        fg = [grade for row in fa for grade in row["entry"]["grade"]["planGrades"]]
        fk = [row for row in fa if row["entry"]["grade"]["knownFeasible"]]
        productive = sum(row["entry"]["grade"]["productive"] for row in fa)
        families.append({"family": family, "scheduled": len(family_rows), "available": len(fa), "productiveAmongScheduled": fraction(productive, len(family_rows)), "productiveAmongAvailable": fraction(productive, len(fa)), "knownWitnessTasks": len(fk), "productiveAmongAvailableWitnesses": fraction(sum(row["entry"]["grade"]["productive"] for row in fk), len(fk)), "returnedPlans": len(fg), "engineValidReturnedPlans": sum(g["checks"]["feasible"] for g in fg), "status": dict(Counter(row["entry"]["status"] for row in family_rows)), "termination": dict(Counter(row["entry"]["termination"] for row in family_rows)), "failedBriefChecksOnReturnedPlans": dict(Counter(key for grade in fg for key in grade["failedChecks"])), "falseAbstention": sum(row["entry"]["grade"]["falseAbstention"] for row in fa)})
    violations = {}
    for code in sorted({v["code"] for _, _, event in invalid_compiles for v in event["observation"]["validation"]["violations"] if v["severity"] == "error"}):
        matching = [(row, index, event) for row, index, event in invalid_compiles if any(v["code"] == code and v["severity"] == "error" for v in event["observation"]["validation"]["violations"])]
        violations[code] = {"amongInvalidCompiles": fraction(len(matching), len(invalid_compiles)), "amongExecutedCompiles": fraction(len(matching), len(compiles)), "tasksAmongScheduled": fraction(len({row["taskId"] for row, _, _ in matching}), total), "example": evidence(matching[0][0], matching[0][1])}
    issues = {}
    for key in sorted({key for _, _, event in invalid_replies for issue in event["observation"].get("issues", []) for key in issue.get("keys", [])}):
        matching = [(row, index) for row, index, event in invalid_replies if any(key in issue.get("keys", []) for issue in event["observation"].get("issues", []))]
        issues[key] = {"repliesAmongSchemaInvalid": fraction(len(matching), len(invalid_replies)), "tasks": len({row["taskId"] for row, _ in matching}), "example": evidence(*matching[0])}
    false_abstentions = []
    for row in available:
        if row["entry"]["grade"]["falseAbstention"]:
            false_abstentions.append({**evidence(row), "explanation": row["result"]["message"], "recordedKnownWitness": True, "compileChecks": sum(compiled["taskId"] == row["taskId"] for compiled, _, _ in compiles)})
    missed_briefs = []
    for row, grade in plans:
        if not grade["productive"]:
            event_index = next((index for compiled, index, event in compiles if compiled["taskId"] == row["taskId"] and event["observation"].get("candidateId") == grade["planId"]), None)
            missed_briefs.append({**evidence(row, event_index), "brief": row["task"]["input"]["intent"]["brief"], "requestedFamily": row["task"]["briefSpec"]["family"], "failedChecks": grade["failedChecks"], "planId": grade["planId"], "engineValid": grade["checks"]["feasible"], "explanation": row["result"]["message"]})
    repair_tasks = [row for row in raw if row["entry"]["termination"] == "repair-budget"]
    repeated_rejected = []
    for row in repair_tasks:
        actions = [json.dumps(event["action"], sort_keys=True) for compiled, _, event in invalid_compiles if compiled["taskId"] == row["taskId"]]
        if len(actions) > len(set(actions)):
            repeated_rejected.append(evidence(row))
    productive = sum(row["entry"]["grade"]["productive"] for row in available)
    result = {"schemaVersion": 1, "diagnosticVersion": VERSION, "generatorSha256": digest(Path(__file__)), "scope": "development-diagnostic", "attemptId": manifest["attemptId"], "arm": manifest["arm"], "model": manifest["model"], "sourceManifestPath": refs("manifest.json"), "sourceManifestSha256": digest(directory / "manifest.json"), "resultsSha256": digest(directory / "results.jsonl"), "taskFileSha256": manifest["tasksSha256"], "checkerVersion": manifest["checkerVersion"], "runtimeVersion": manifest["runtimeVersion"], "sourceHashes": manifest["sourceHashes"],
      "schedule": {"tasks": total, "sceneGroups": len({row["task"]["sceneGroup"] for row in raw}), "attempted": sum(row["entry"]["attempted"] for row in raw), "available": len(available)},
      "status": dict(Counter(row["entry"]["status"] for row in raw)), "termination": dict(Counter(row["entry"]["termination"] for row in raw)),
      "outcomes": {"productiveAmongScheduled": fraction(productive, total), "productiveAmongAvailable": fraction(productive, len(available)), "productiveAmongAvailableWitnesses": fraction(sum(row["entry"]["grade"]["productive"] for row in known), len(known)), "returnedPlans": len(plans), "tasksWithCreditedReturnedPlans": len({row["taskId"] for row, _ in plans}), "engineValidReturnedPlans": fraction(sum(grade["checks"]["feasible"] for _, grade in plans), len(plans)), "productiveReturnedPlans": fraction(sum(grade["productive"] for _, grade in plans), len(plans)), "briefRejectedReturnedPlans": len(missed_briefs), "acceptedEmptyFinishes": sum(row["entry"]["grade"]["emptyFinish"] for row in available), "falseAbstentions": fraction(len(false_abstentions), len(known)), "unsupportedAbstentions": sum(row["entry"]["grade"]["unsupportedAbstention"] for row in available), "boundedEmpty": sum(row["entry"]["grade"]["boundedEmpty"] for row in available), "uncheckedEmptyFinishes": sum(row["entry"]["grade"]["uncheckedEmpty"] for row in available), "fallbackLibraryPlansExcludedFromModelCredit": sum(len((row.get("result") or {}).get("plans", [])) for row in raw if row["entry"]["termination"] == "fallback")},
      "families": families, "returnedPlanCriteria": criteria,
      "tools": {"providerCalls": len(calls), "recordedEvents": len(events), "providerCallMinusEventCount": len(calls) - len(events), "recordedActionTypes": dict(Counter(object_value(event["action"]).get("action", "non-object-action") for _, _, event in events)), "recordedSchemaInvalidReplies": fraction(len(invalid_replies), len(calls)), "recordedRevisionErrors": {"count": len(revision_errors), "tasks": len({row["taskId"] for row, _, _ in revision_errors}), "examples": [evidence(row, index) for row, index, _ in revision_errors[:2]]}, "recordedCompileChecks": len(compiles), "validCompiles": fraction(len(compiles) - len(invalid_compiles), len(compiles)), "invalidCompiles": fraction(len(invalid_compiles), len(compiles)), "violations": violations, "schemaUnknownKeys": issues, "repairBudgetTasks": len(repair_tasks), "repairBudgetTasksWithPreviouslyValidCompile": sum(any(compiled["taskId"] == row["taskId"] and event["observation"]["validation"]["valid"] for compiled, _, event in compiles) for row in repair_tasks), "repairBudgetTasksWithIdenticalRejectedCompileRepeated": repeated_rejected},
      "briefFailureExamples": missed_briefs, "falseAbstentionExamples": false_abstentions,
      "taskEvidence": [{**evidence(row), "family": row["task"]["briefSpec"]["family"], "status": row["entry"]["status"], "termination": row["entry"]["termination"], "productive": row["entry"]["grade"]["productive"] if row["entry"]["grade"] else None, "knownWitness": row["entry"]["grade"]["knownFeasible"] if row["entry"]["grade"] else None} for row in raw],
      "limitations": ["Recorded development outcomes only; no model calls, plan recompilation or current-checker regrading.", "Criterion denominators are credited returned plans. Compilation failures have separate observed compile/task denominators; codes overlap.", "Logged schema errors and compile checks are observed counts, not proof that omitted actions were valid. A provider-call/event count gap does not identify omitted action types or causes.", "Engine validity is conditional on supplied synthetic geometry and is not physical safety or brief preservation.", "A valid intermediate compile is not a graded final plan and receives no productive credit. Raw library fallback plans do not receive model-success credit.", "Witness absence is unresolved, not proof of infeasibility. Twelve scene groups contain dependent movement tasks.", "This attempt is separate from the initial GPT network pilot, failed warmups, other arms, and future confirmation.", "Diagnosis does not establish creator benefit or authorize tuning the frozen candidate."]}
    if productive != json.loads((directory / "summary.json").read_text())["productive"]:
        raise ValueError("Recorded summary does not reconcile with task grades.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x") as stream:
        stream.write(json.dumps(result, indent=2) + "\n")
    return result


def markdown(report: dict) -> str:
    out, tools = report["outcomes"], report["tools"]
    task_success = out["productiveAmongAvailable"]
    names = {"llama-base": "Base Llama", "gpt-oss": "GPT-OSS"}
    terminations = ", ".join(f"{count} {name}" for name, count in report["termination"].items())
    lines = [f"# {names.get(report['arm'], report['arm'])} development diagnostics", "", f"The completed `{report['attemptId']}` attempt produced a brief-preserving plan on {task_success['count']}/{task_success['denominator']} available tasks. {report['schedule']['available']}/{report['schedule']['tasks']} scheduled tasks were available. Recorded terminations: {terminations}. These are development diagnostics, not confirmation results.", "", f"The recorded grader assessed {out['returnedPlans']} returned plans from {out['tasksWithCreditedReturnedPlans']} tasks: {out['engineValidReturnedPlans']['count']} were engine-valid and {out['productiveReturnedPlans']['count']} preserved the brief. Plan counts and successful-task counts differ when a task returns multiple plans.", "", "| Requested family | Productive / available tasks | Productive / known-witness tasks | Returned plans | Actor-failure tasks |", "| --- | ---: | ---: | ---: | ---: |"]
    for row in report["families"]:
        lines.append(f"| {row['family']} | {row['productiveAmongAvailable']['count']}/{row['available']} | {row['productiveAmongAvailableWitnesses']['count']}/{row['knownWitnessTasks']} | {row['returnedPlans']} | {row['status'].get('actor-failure', 0)} |")
    failed = ", ".join(f"{key.replace('_', ' ')} {value['failed']['count']}/{value['failed']['denominator']}" for key, value in report["returnedPlanCriteria"].items() if value["failed"]["count"])
    passed = ", ".join(key.replace("_", " ") for key, value in report["returnedPlanCriteria"].items() if value["failed"]["count"] == 0 and value["missing"] == 0)
    lines += ["", f"{out['briefRejectedReturnedPlans']} returned plans missed at least one brief check. Failed checks: {failed or 'none'}. Checks overlap. {passed.capitalize()} passed on all {out['returnedPlans']} assessed plans. Unreturned plans are outside these criterion denominators.", "", f"The agent issued {tools['providerCalls']} provider calls; {tools['recordedEvents']} tool/action events were logged. Recorded compilation checks: {tools['recordedCompileChecks']} ({tools['validCompiles']['count']} valid, {tools['invalidCompiles']['count']} invalid). Explicitly logged action-schema errors: {tools['recordedSchemaInvalidReplies']['count']}."]
    if tools["providerCallMinusEventCount"]:
        lines.append(f"The call count exceeds the event count by {tools['providerCallMinusEventCount']}. This receipt cannot assign those missing event observations to particular failure types. Observed compile and schema-error counts are incomplete diagnostics, not evidence that unlogged actions were valid.")
    unknown = tools["schemaUnknownKeys"].get("travelFractionOfOpticallySolvedDistance")
    if unknown:
        count = unknown["repliesAmongSchemaInvalid"]
        lines.append(f"`travelFractionOfOpticallySolvedDistance` appeared in {count['count']}/{count['denominator']} explicitly schema-invalid replies: a descriptive recipe default was copied into an override field the action schema does not accept.")
    if tools["recordedRevisionErrors"]["count"]:
        rev = tools["recordedRevisionErrors"]
        lines.append(f"The coordinator rejected {rev['count']} `propose_revision` calls across {rev['tasks']} tasks because planning requests had no saved take/evidence. These are recorded tool-selection errors.")
    violations = sorted(tools["violations"].items(), key=lambda pair: pair[1]["amongInvalidCompiles"]["count"], reverse=True)[:3]
    if violations:
        counts = ", ".join(f"`{key}` {value['amongInvalidCompiles']['count']}/{value['amongInvalidCompiles']['denominator']}" for key, value in violations)
        lines += ["", f"The most frequent codes among observed invalid compiles were {counts}. Codes overlap and describe supplied geometry, not a filmed creator's movement."]
    lines += ["", "Examples:", ""]
    for item in report["briefFailureExamples"][:3]:
        lines.append(f"- [{item['taskId']}]({item['receiptPath']}): returned plan fails {', '.join(item['failedChecks'])}; inspect `entry.grade.planGrades` and `{item.get('eventPointer', '/result')}`.")
    if unknown:
        invalid = unknown["example"]
        links = ", ".join(f"[response]({path})" for path in invalid["callResponsePaths"])
        lines.append(f"- [{invalid['taskId']}]({invalid['receiptPath']}): rejected descriptive default at `{invalid['eventPointer']}` ({links}).")
    if tools["recordedRevisionErrors"]["examples"]:
        item = tools["recordedRevisionErrors"]["examples"][0]
        links = ", ".join(f"[response]({path})" for path in item["callResponsePaths"])
        lines.append(f"- [{item['taskId']}]({item['receiptPath']}): unsupported revision action at `{item['eventPointer']}` ({links}).")
    numeric = next((item for item in report["falseAbstentionExamples"] if "0.10000000000000009" in item["explanation"] and "less than" in item["explanation"]), None)
    if numeric:
        lines.append(f"- [{numeric['taskId']}]({numeric['receiptPath']}): the final explanation calls `0.10000000000000009 m` less than the `0.10 m` requirement. The recorded grader has a feasible witness; this is a false abstention, not evidence of infeasibility.")
    lines += ["", f"There were {out['acceptedEmptyFinishes']} accepted empty finishes: {out['falseAbstentions']['count']} on the {out['falseAbstentions']['denominator']} tasks with recorded witnesses, {out['unsupportedAbstentions']} credited unsupported abstentions, and {out['boundedEmpty']} bounded empty outcomes. Unchecked empty finishes: {out['uncheckedEmptyFinishes']}. Witness absence does not prove infeasibility."]
    if out["fallbackLibraryPlansExcludedFromModelCredit"]:
        lines.append(f"The {report['termination'].get('fallback', 0)} fallback tasks carried {out['fallbackLibraryPlansExcludedFromModelCredit']} raw library plans; all were excluded from model-success credit. Credited plan counts above use recorded `planGrades`, not those raw fallback plans.")
    lines += ["", "The machine-readable companion preserves criterion denominators, failure categories, task hashes, call links and trace IDs. No runtime, teacher label or training data was changed for this diagnosis. Other arms, the initial network pilot and confirmation remain separate attempts.", ""]
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.output.with_suffix(".md").exists():
        raise SystemExit("Refusing to overwrite an existing diagnostic Markdown receipt.")
    report = diagnose(args.directory, args.output)
    with args.output.with_suffix(".md").open("x") as stream:
        stream.write(markdown(report))
    print(json.dumps({"attemptId": report["attemptId"], "outcomes": report["outcomes"]}))
