"""Python code intelligence for the studio's editor (completions, signatures, hover, go to definition, rename).

One long-lived process: JSON requests arrive one per line on stdin, answers go out one per line on stdout.
Request:  {"id": 1, "op": "complete", "path": "<abs file>", "code": "...", "line": 3, "column": 4,
           "root": "<project dir>", "extra": ["<extra sys.path>"], "newName": "..."}
Lines are 1-based, columns 0-based (as in jedi).
"""
import json
import sys

import jedi

jedi.settings.case_insensitive_completion = False
_projects = {}


def project(root, extra):
    key = (root, tuple(extra))
    if key not in _projects:
        _projects[key] = jedi.Project(root, added_sys_path=list(extra), smart_sys_path=True)
    return _projects[key]


def short_doc(name, limit=1200):
    try:
        doc = name.docstring()
    except Exception:
        return ""
    return doc[:limit]


def location(name):
    if name.line is None:
        return None
    return {
        "path": str(name.module_path) if name.module_path else None,
        "line": name.line,
        "column": name.column,
        "module": name.module_name,
        "name": name.name,
        "builtin": name.in_builtin_module(),
    }


def handle(req):
    op = req["op"]
    script = jedi.Script(req["code"], path=req["path"], project=project(req["root"], req.get("extra", [])))
    line, col = req.get("line", 1), req.get("column", 0)

    if op == "complete":
        items = []
        for i, c in enumerate(script.complete(line, col)[:150]):
            item = {"name": c.name, "type": c.type, "complete": c.complete, "module": c.module_name}
            # Docs for the first few only: computing every docstring is slow
            if i < 12:
                item["doc"] = short_doc(c, 600)
                try:
                    sigs = c.get_signatures()
                    if sigs:
                        item["signature"] = sigs[0].to_string()
                except Exception:
                    pass
            items.append(item)
        return {"items": items}

    if op == "signatures":
        out = []
        for s in script.get_signatures(line, col):
            out.append({
                "label": s.to_string(),
                "params": [p.to_string() for p in s.params],
                "index": s.index,
                "doc": short_doc(s, 800),
            })
        return {"signatures": out}

    if op == "hover":
        names = script.help(line, col) or script.infer(line, col)
        out = []
        for n in names[:2]:
            sig = ""
            try:
                sigs = n.get_signatures()
                sig = sigs[0].to_string() if sigs else ""
            except Exception:
                pass
            out.append({"name": n.name, "type": n.type, "module": n.module_name, "signature": sig, "description": n.description, "doc": short_doc(n)})
        return {"items": out}

    if op == "definition":
        names = script.goto(line, col, follow_imports=True, follow_builtin_imports=False)
        return {"locations": [loc for loc in (location(n) for n in names) if loc]}

    if op == "references":
        return {"locations": [loc for loc in (location(n) for n in script.get_references(line, col)) if loc]}

    if op == "rename":
        refactoring = script.rename(line, col, new_name=req["newName"])
        changed = {}
        for path, change in refactoring.get_changed_files().items():
            changed[str(path)] = change.get_new_code()
        return {"files": changed}

    raise ValueError(f"unknown op {op}")


def main():
    # UTF-8 both ways, whatever the console code page is
    stdin = open(sys.stdin.fileno(), "r", encoding="utf-8", closefd=False)
    stdout = open(sys.stdout.fileno(), "w", encoding="utf-8", closefd=False)
    stdout.write(json.dumps({"ready": True, "jedi": jedi.__version__}) + "\n")
    stdout.flush()
    for raw in stdin:
        raw = raw.strip()
        if not raw:
            continue
        req_id = None
        try:
            req = json.loads(raw)
            req_id = req.get("id")
            result = handle(req)
            stdout.write(json.dumps({"id": req_id, "ok": True, **result}, ensure_ascii=False) + "\n")
        except Exception as e:  # one bad request must not stop the worker
            stdout.write(json.dumps({"id": req_id, "ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False) + "\n")
        stdout.flush()


if __name__ == "__main__":
    main()
