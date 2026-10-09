"""Line coverage for project tests: a small pytest plugin (loaded with -p sc_cover).

Records which lines of the project's own .py files ran while the tests ran and writes
{"files": {"rel/path.py": {"covered": [...], "missing": [...]}}} to $SC_COVER_OUT.
Uses sys.monitoring (Python 3.12+, cheap: each line reports once) or sys.settrace otherwise.
Needs nothing installed besides pytest.
"""
import json
import os
import re
import sys

ROOT = os.path.normcase(os.path.abspath(os.environ.get("SC_COVER_ROOT", os.getcwd())))
OUT = os.environ.get("SC_COVER_OUT")
SKIP_DIRS = {"node_modules", ".git", ".packages", ".history", "__pycache__", ".venv", "venv", ".pytest_cache"}
TEST_FILE = re.compile(r"(^|/)(test_[^/]*|[^/]*_test|conftest)\.py$")

_hits = {}  # normcased absolute path -> set of lines
_inside = {}  # filename -> is it a project file?


def _project_file(filename):
    r = _inside.get(filename)
    if r is None:
        p = os.path.normcase(os.path.abspath(filename))
        r = p.startswith(ROOT + os.sep) and not any(
            part in SKIP_DIRS for part in os.path.relpath(p, ROOT).split(os.sep)[:-1]
        )
        _inside[filename] = r
    return r


def _record(filename, line):
    _hits.setdefault(os.path.normcase(os.path.abspath(filename)), set()).add(line)


_TOOL = None


def _start():
    global _TOOL
    mon = getattr(sys, "monitoring", None)
    if mon is not None:
        for tool in (mon.COVERAGE_ID, 4, 5):
            if mon.get_tool(tool) is None:
                _TOOL = tool
                break
    if _TOOL is not None:
        mon.use_tool_id(_TOOL, "scriptcraft-coverage")

        def on_line(code, line):
            if _project_file(code.co_filename):
                _record(code.co_filename, line)
            return mon.DISABLE  # each line reports once

        mon.register_callback(_TOOL, mon.events.LINE, on_line)
        mon.set_events(_TOOL, mon.events.LINE)
    else:
        def tracer(frame, event, arg):
            if not _project_file(frame.f_code.co_filename):
                return None
            if event == "line":
                _record(frame.f_code.co_filename, frame.f_lineno)
            return tracer

        sys.settrace(tracer)
        import threading
        threading.settrace(tracer)


def _stop():
    if _TOOL is not None:
        mon = sys.monitoring
        mon.set_events(_TOOL, 0)
        mon.register_callback(_TOOL, mon.events.LINE, None)
        mon.free_tool_id(_TOOL)
    else:
        sys.settrace(None)


def _executable_lines(path):
    """Lines that hold code (what could have run), from the compiled module."""
    try:
        with open(path, "rb") as f:
            src = f.read()
        code = compile(src, path, "exec", dont_inherit=True)
    except Exception:
        return None
    lines = set()
    stack = [code]
    while stack:
        c = stack.pop()
        for _, _, line in c.co_lines():
            if line is not None and line > 0:
                lines.add(line)
        stack.extend(k for k in c.co_consts if hasattr(k, "co_lines"))
    # The module docstring / a bare "def" header line count as run when the module is imported; keep them
    return lines


def _project_sources():
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for name in files:
            if name.endswith(".py"):
                yield os.path.join(base, name)


def _write():
    if not OUT:
        return
    result = {}
    for path in _project_sources():
        rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
        if TEST_FILE.search(rel):
            continue
        lines = _executable_lines(path)
        if not lines:
            continue
        hit = _hits.get(os.path.normcase(os.path.abspath(path)), set())
        result[rel] = {
            "covered": sorted(lines & hit),
            "missing": sorted(lines - hit),
        }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"files": result}, f)


def pytest_configure(config):
    _start()


def pytest_unconfigure(config):
    _stop()
    try:
        _write()
    except Exception as e:  # coverage must never break the test run
        print(f"scriptcraft coverage: {e}", file=sys.stderr)
