"""Project the existing 0013-1 watch files without returning private source text."""

import json
import os
import plistlib
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

LABEL = "com.lanjing.outlook-0013-watch"
HOSTS = {
    "ggzyfw.beijing.gov.cn",
    "ghzrzyw.beijing.gov.cn",
    "www.lejucaijing.com",
    "xinwen.bjd.com.cn",
    "www.china0001.com.cn",
}
RUN_LIMIT = 60
PUBLIC_QUERIES = {
    "1019-0013-1 酒仙桥 项目",
    "酒仙桥 0013-1 户型 采光",
    "京土储挂 朝 2026 030 酒仙桥",
}
SEARCH_FAILURES = {
    "provider_search_failed",
    "provider_invalid_response",
    "provider_response_too_large",
    "provider_unavailable",
    "timeout",
}


def read_record(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 2_000_000:
        raise ValueError("Invalid receipt file")
    with path.open(encoding="utf-8") as file:
        value = json.load(file)
    if not isinstance(value, dict):
        raise TypeError("Invalid receipt")
    return value


def allowed_source(value):
    if not isinstance(value, dict):
        return None
    url, title = value.get("url"), value.get("title")
    if not isinstance(url, str) or len(url) > 500 or any(c.isspace() for c in url):
        return None
    if not isinstance(title, str) or not title.strip() or len(title) > 300:
        return None
    try:
        parts = urlsplit(url)
        if (
            parts.scheme != "https"
            or parts.hostname not in HOSTS
            or parts.username is not None
            or parts.password is not None
            or parts.port not in (None, 443)
        ):
            return None
    except ValueError:
        return None
    return {"title": title, "url": url}


def count(value):
    return value if type(value) is int and value >= 0 else None


def timestamp(value):
    try:
        observed = datetime.fromisoformat(value)
        if observed.tzinfo is not None:
            return observed.astimezone(timezone.utc).isoformat()
    except (ValueError, TypeError):
        pass
    return None


def collector_runtime():
    try:
        job = subprocess.run(
            ["/bin/launchctl", "print", f"gui/{os.getuid()}/{LABEL}"],
            capture_output=True,
            text=True,
            timeout=3,
            check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return {"state": "unknown", "intervalSeconds": None}
    state = re.search(r"(?m)^\tstate = (running|not running)\s*$", job)
    interval = re.search(r"(?m)^\trun interval = (\d+) seconds\s*$", job)
    return {
        "state": {"running": "running", "not running": "waiting"}[state[1]]
        if state
        else "unknown",
        "intervalSeconds": int(interval[1]) if interval else None,
    }


def query_details(queries):
    items = []
    for query in queries[:20]:
        if not isinstance(query, dict):
            continue
        label, status, reason = (
            query.get(key) for key in ("query", "status", "reason")
        )
        if status not in ("ok", "failed"):
            status = "unknown"
        items.append(
            {
                "query": label
                if isinstance(label, str) and label in PUBLIC_QUERIES
                else None,
                "status": status,
                "reason": reason
                if isinstance(reason, str) and reason in SEARCH_FAILURES
                else None,
                "results": count(query.get("results")) if status == "ok" else None,
            }
        )
    return items


def read_runs(root):
    records = []
    invalid = 0
    for path in (root / "runs").glob("*.json"):
        if not re.fullmatch(r"[a-f0-9]{32}", path.stem):
            continue
        try:
            row = read_record(path)
            observed = timestamp(row.get("observedAt"))
            if not observed:
                raise ValueError("Missing observation timestamp")
            queries = row.get("queries")
            failed = (
                sum(q.get("status") == "failed" for q in queries if isinstance(q, dict))
                if isinstance(queries, list)
                else None
            )
            records.append(
                {
                    "id": path.stem,
                    "observedAt": observed,
                    "searchState": row["searchState"]
                    if row.get("searchState") in ("ok", "degraded")
                    else "unknown",
                    "queryCount": len(queries) if isinstance(queries, list) else None,
                    "failedQueries": failed,
                    "queries": query_details(queries)
                    if isinstance(queries, list)
                    else [],
                    **{
                        k: count(row.get(k))
                        for k in (
                            "verifiedSources",
                            "openedSources",
                            "newCandidates",
                            "searchDiscoveredSources",
                            "failedFetches",
                            "identityRejected",
                        )
                    },
                }
            )
        except (OSError, ValueError, TypeError):
            invalid += 1
    return (
        sorted(records, key=lambda row: (row["observedAt"], row["id"]), reverse=True)[
            :RUN_LIMIT
        ],
        len(records),
        invalid,
    )


def read_candidates(root, observed_times):
    selected = []
    for path in (root / "evidence").glob("*.json"):
        if not re.fullmatch(r"[a-f0-9]{64}-[a-f0-9]{64}", path.stem):
            continue
        try:
            row = read_record(path)
        except (OSError, ValueError, TypeError):
            continue
        observed = timestamp(row.get("observedAt"))
        event = row.get("eventId")
        revision = count(row.get("revision"))
        source = allowed_source(row.get("source"))
        if not all(
            (
                observed in observed_times,
                isinstance(event, str),
                path.stem.split("-")[0] == event,
                revision,
                source,
            )
        ):
            continue
        published = row.get("publishedAt")
        selected.append(
            {
                "id": event,
                "revision": revision,
                "observedAt": observed,
                "sourcePublishedAt": published
                if isinstance(published, str)
                and re.fullmatch(r"\d{4}-\d{2}-\d{2}", published)
                else None,
                "source": source,
                "discovery": row["discovery"]
                if row.get("discovery") in ("seed", "search")
                else "unknown",
                "reviewStatus": row["reviewStatus"]
                if row.get("reviewStatus") in ("pending", "approved", "rejected")
                else "unknown",
                "published": row.get("published") is True,
            }
        )
    return sorted(
        selected,
        key=lambda row: (row["observedAt"], row["id"], row["revision"]),
        reverse=True,
    )


def main():
    home = Path.home()
    plist_path = home / "Library" / "LaunchAgents" / f"{LABEL}.plist"
    with plist_path.open("rb") as file:
        job = plistlib.load(file)
    if job.get("Label") != LABEL:
        raise ValueError("Unexpected collector")
    root = home / ".local/share/lanjing-outlook-watch/0013-1"
    args = job.get("ProgramArguments", [])
    if Path(args[args.index("--output-root") + 1]) != root:
        raise ValueError("Collector output root changed")
    if not (root / "runs").is_dir():
        raise ValueError("Receipt directory unavailable")
    runs, total, invalid = read_runs(root)
    candidates = read_candidates(root, {row["observedAt"] for row in runs})
    grouped = {}
    by_observed_time = {}
    for run in runs:
        by_observed_time.setdefault(run["observedAt"], []).append(run["id"])
    for candidate in candidates:
        matching = by_observed_time[candidate["observedAt"]]
        if len(matching) == 1:
            grouped.setdefault(matching[0], []).append(candidate)
    print(
        json.dumps(
            {
                "version": 1,
                "checkedAt": datetime.now(timezone.utc).isoformat(),
                "intervalSeconds": count(job.get("StartInterval")),
                "collector": collector_runtime(),
                "totalRuns": total,
                "unreadableRuns": invalid,
                "runs": [{**row, "items": grouped.get(row["id"], [])} for row in runs],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
