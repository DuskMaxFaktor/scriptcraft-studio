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
import base64
import ctypes
import queue
import threading
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


def _emit_image(raw):
    """raw: PNG bytes or an already-base64 string."""
    data = base64.b64encode(raw).decode("ascii") if isinstance(raw, (bytes, bytearray)) else str(raw)
    send({"execId": _cur["id"], "type": "display", "mime": "image/png", "data": data})


def _capture_figures():
    """Show any open matplotlib figures inline (like Jupyter), then close them."""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    try:
        for num in list(plt.get_fignums()):
            fig = plt.figure(num)
            buf = io.BytesIO()
            fig.savefig(buf, format="png", bbox_inches="tight")
            _emit_image(buf.getvalue())
            plt.close(fig)
    except Exception:
        pass


def _show_rich(value):
    """If the last expression renders as an image (matplotlib figure, PIL image…), show it. Returns True if handled."""
    repr_png = getattr(value, "_repr_png_", None)
    if callable(repr_png):
        try:
            out = repr_png()
            if out:
                _emit_image(out)
                return True
        except Exception:
            pass
    return False


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
            if value is not None and not _show_rich(value):
                try:
                    text = repr(value)
                except Exception as exc:  # a broken __repr__ must not kill the kernel
                    text = f"<repr failed: {exc}>"
                send({"execId": _cur["id"], "type": "result", "text": text})
        _capture_figures()  # inline any plots the cell drew
        return "ok"
    except SystemExit:
        return "ok"
    except BaseException as exc:
        send({"execId": _cur["id"], "type": "error", "ename": type(exc).__name__, "evalue": str(exc), "traceback": _clean_traceback(exc)})
        return "error"


# Cells run on their own thread so the main thread can still read an "interrupt" command while a cell runs
_exec_q: "queue.Queue" = queue.Queue()
_executor_tid = [None]


def _executor():
    _executor_tid[0] = threading.get_ident()
    while True:
        msg = _exec_q.get()
        _cur["id"] = msg.get("execId")
        status = run_cell(msg.get("code") or "")
        send({"execId": _cur["id"], "type": "done", "status": status})


def _interrupt():
    """Raise KeyboardInterrupt in the executor thread (soft interrupt, keeps the namespace)."""
    tid = _executor_tid[0]
    if tid is not None:
        ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_long(tid), ctypes.py_object(KeyboardInterrupt))


def main():
    sys.stdout = _Stream("stdout")
    sys.stderr = _Stream("stderr")
    threading.Thread(target=_executor, daemon=True).start()
    send({"ready": True})
    # readline() (not "for line in sys.stdin") so each request is handled as soon as it arrives
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
        if msg.get("cmd") == "interrupt":
            _interrupt()
        else:
            _exec_q.put(msg)


if __name__ == "__main__":
    main()
