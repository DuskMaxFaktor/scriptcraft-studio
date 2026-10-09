"""
ScriptCraft Studio - Python debug runner.

Runs a project file under a bdb-based debugger. The studio server talks to it over a local TCP socket
(JSON lines): it sends breakpoints and commands (continue / next / step / out / stop / eval) and receives
"stopped" events with the call stack and variables. Program stdin/stdout/stderr stay untouched, so input()
and print() work exactly as in a normal run.

Usage: python -u py_runner.py <entry.py>
Env:   SCRIPTCRAFT_DEBUG_PORT, SCRIPTCRAFT_DEBUG_ROOT (project folder), SCRIPTCRAFT_BREAKPOINTS (JSON {file: [lines]})
"""
import bdb
import json
import os
import queue
import reprlib
import socket
import sys
import threading
import traceback
import types

_repr = reprlib.Repr()
_repr.maxstring = 200
_repr.maxother = 200
_repr.maxlist = _repr.maxtuple = _repr.maxdict = _repr.maxset = 20
_repr.maxlevel = 3


def _describe(value):
    try:
        text = _repr.repr(value)
    except Exception as exc:  # a broken __repr__ must not kill the debugger
        text = f"<repr failed: {exc}>"
    return {"value": text, "type": type(value).__name__}


def _user_vars(mapping, is_globals=False):
    result = []
    for name, value in mapping.items():
        if name.startswith("__") and name.endswith("__"):
            continue
        if isinstance(value, types.ModuleType):
            continue
        if is_globals and isinstance(value, (types.FunctionType, type)):
            continue
        result.append({"name": name, **_describe(value)})
    return result


class StudioDebugger(bdb.Bdb):
    def __init__(self, conn, root):
        super().__init__()
        self.conn = conn
        self.root = os.path.normcase(os.path.abspath(root))
        self.commands = queue.Queue()
        self.send_lock = threading.Lock()
        self.started = False

    # ---- communication ----
    def send(self, obj):
        data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
        with self.send_lock:
            try:
                self.conn.sendall(data)
            except OSError:
                pass

    def reader(self):
        """Background thread: breakpoints can change while the program runs; other commands are queued."""
        for raw in self.conn.makefile("r", encoding="utf-8"):
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if msg.get("cmd") == "setBreakpoints":
                self.apply_breakpoints(msg.get("breakpoints") or {})
            else:
                self.commands.put(msg)
        self.commands.put({"cmd": "stop"})  # the studio went away

    # ---- paths & breakpoints ----
    def rel(self, filename):
        path = os.path.normcase(os.path.abspath(filename))
        if path.startswith(self.root + os.sep):
            return os.path.relpath(path, self.root).replace("\\", "/")
        return None

    def apply_breakpoints(self, breakpoints):
        self.clear_all_breaks()
        for rel, items in breakpoints.items():
            path = os.path.join(self.root, rel)
            for item in items:
                # Either a bare line number or {"line": N, "condition": "expr"}
                if isinstance(item, dict):
                    line = item.get("line")
                    cond = item.get("condition") or None
                    log = item.get("log")
                    if log:
                        # Logpoint: print the message ({expr} is an f-string field) and never stop
                        cond = "print(f" + repr(str(log)) + ", flush=True) or False"
                else:
                    line = item
                    cond = None
                if line is None:
                    continue
                # bdb evaluates `cond` in the frame on each hit; a crashing condition is treated as a hit
                self.set_break(path, int(line), cond=cond)  # returns an error text for lines without code; ignored

    # Only ever stop in the project's own files, never inside the standard library
    def stop_here(self, frame):
        return self.rel(frame.f_code.co_filename) is not None and super().stop_here(frame)

    # ---- stopping ----
    def user_line(self, frame):
        hit = self.break_here(frame)
        # bdb starts in "step" mode; the studio wants "run until the first breakpoint"
        if not self.started:
            self.started = True
            if not hit:
                self.set_continue()
                return
        self.interaction(frame, "breakpoint" if hit else "step")

    def user_exception(self, frame, exc_info):
        # Stop where an exception is raised in project code only when stepping there anyway
        pass

    def interaction(self, frame, reason):
        stack = []
        f = frame
        while f is not None:
            rel = self.rel(f.f_code.co_filename)
            if rel is not None:
                stack.append({"file": rel, "line": f.f_lineno, "name": f.f_code.co_name})
            f = f.f_back
        top = stack[0] if stack else {"file": None, "line": frame.f_lineno}
        is_module = frame.f_code.co_name == "<module>"
        self.send({
            "event": "stopped",
            "reason": reason,
            "file": top["file"],
            "line": top["line"],
            "stack": stack,
            "locals": [] if is_module else _user_vars(frame.f_locals),
            "globals": _user_vars(frame.f_globals, is_globals=True),
        })
        while True:
            msg = self.commands.get()
            cmd = msg.get("cmd")
            if cmd == "continue":
                self.set_continue()
            elif cmd == "next":
                self.set_next(frame)
            elif cmd == "step":
                self.set_step()
            elif cmd == "out":
                self.set_return(frame)
            elif cmd == "stop":
                self.set_quit()
            elif cmd == "eval":
                expr = str(msg.get("expr", ""))
                try:
                    value = eval(expr, frame.f_globals, frame.f_locals)
                    self.send({"event": "evalResult", "expr": expr, **_describe(value)})
                except Exception as exc:
                    self.send({"event": "evalResult", "expr": expr, "error": f"{type(exc).__name__}: {exc}"})
                continue
            else:
                continue
            self.send({"event": "running"})
            return


def main():
    entry = os.path.abspath(sys.argv[1])
    root = os.environ.get("SCRIPTCRAFT_DEBUG_ROOT") or os.path.dirname(entry)
    port = int(os.environ["SCRIPTCRAFT_DEBUG_PORT"])
    conn = socket.create_connection(("127.0.0.1", port))

    dbg = StudioDebugger(conn, root)
    dbg.apply_breakpoints(json.loads(os.environ.get("SCRIPTCRAFT_BREAKPOINTS") or "{}"))
    threading.Thread(target=dbg.reader, daemon=True).start()

    # Run the file as __main__, like "python entry.py"
    sys.argv = [entry] + sys.argv[2:]
    sys.path[0] = os.path.dirname(entry)
    with open(entry, "rb") as fh:
        code = compile(fh.read(), entry, "exec")
    main_globals = {"__name__": "__main__", "__file__": entry, "__builtins__": __builtins__}

    exit_code = 0
    try:
        dbg.run(code, main_globals)
    except bdb.BdbQuit:
        exit_code = 1
    except SystemExit as exc:
        exit_code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    except BaseException:
        traceback.print_exc()
        exit_code = 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        dbg.send({"event": "terminated"})
        try:
            conn.close()
        except OSError:
            pass
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
