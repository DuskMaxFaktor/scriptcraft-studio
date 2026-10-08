# ScriptCraft Studio - Python notebook kernel.
# A long-lived process that runs cell code in ONE shared namespace (state is kept between cells),
# like a Jupyter kernel. The studio server talks to it over stdin/stdout as JSON lines:
#   in:  {"execId": "...", "code": "..."}
#   out: {"execId","type":"stream","name":"stdout"|"stderr","text":...}
#        {"execId","type":"result","text": "<repr of the last expression>"}
#        {"execId","type":"error","ename","evalue","traceback"}
#        {"execId","type":"done","status":"ok"|"error"}
# The first line printed is {"ready": true}.
import sys
import io
import json
import ast
import traceback

_real_stdout = sys.stdout


def send(obj):
    _real_stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _real_stdout.flush()


# Current execution id, shared with the stream redirectors
_cur = {"id": None}


class _Stream(io.TextIOBase):
    def __init__(self, name):
        self.name = name

    def writable(self):
        return True

    def write(self, s):
        if s:
            send({"execId": _cur["id"], "type": "stream", "name": self.name, "text": s})
        return len(s)

    def flush(self):
        pass


def _no_input(*_args, **_kwargs):
    raise RuntimeError("input() is not available in a notebook cell")


ns = {"__name__": "__main__", "__builtins__": __builtins__, "input": _no_input}


def _clean_traceback(exc):
    """Drop this runner's own frames, keep only the cell's."""
    tb = exc.__traceback__
    # skip the first frame (the exec call in run_cell)
    if tb is not None:
        tb = tb.tb_next
    lines = traceback.format_exception(type(exc), exc, tb)
    return "".join(lines)


def run_cell(code):
    try:
        parsed = ast.parse(code, "<cell>", "exec")
    except SyntaxError as exc:
        send({"execId": _cur["id"], "type": "error", "ename": type(exc).__name__, "evalue": str(exc), "traceback": "".join(traceback.format_exception_only(type(exc), exc))})
        return "error"

    # If the last statement is a bare expression, evaluate it and echo its repr (like Jupyter)
    last_expr = None
    if parsed.body and isinstance(parsed.body[-1], ast.Expr):
        last_expr = ast.Expression(parsed.body.pop().value)

    try:
        if parsed.body:
            exec(compile(parsed, "<cell>", "exec"), ns, ns)
        if last_expr is not None:
            value = eval(compile(last_expr, "<cell>", "eval"), ns, ns)
            if value is not None:
                try:
                    text = repr(value)
                except Exception as exc:  # a broken __repr__ must not kill the kernel
                    text = f"<repr failed: {exc}>"
                send({"execId": _cur["id"], "type": "result", "text": text})
        return "ok"
    except SystemExit:
        return "ok"
    except BaseException as exc:
        send({"execId": _cur["id"], "type": "error", "ename": type(exc).__name__, "evalue": str(exc), "traceback": _clean_traceback(exc)})
        return "error"


def main():
    sys.stdout = _Stream("stdout")
    sys.stderr = _Stream("stderr")
    send({"ready": True})
    # readline() (not "for line in sys.stdin") so each request is handled as soon as it arrives,
    # instead of waiting for the input buffer to fill
    stdin = sys.__stdin__
    while True:
        raw = stdin.readline()
        if raw == "":  # EOF: the studio went away
            break
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        _cur["id"] = msg.get("execId")
        code = msg.get("code") or ""
        status = run_cell(code)
        send({"execId": _cur["id"], "type": "done", "status": status})


if __name__ == "__main__":
    main()
