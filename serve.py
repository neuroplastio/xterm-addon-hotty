#!/usr/bin/env python3
"""serve.py — xterm.js with the HOTTY addon, over a pty, in a browser tab.

    python3 serve.py -- python3 ../hotty/examples/dash.py
    python3 serve.py --examples          # /?run=card, /?run=grid&args=--cells+4096

`--examples` runs the HOTTY repository's example programs (HOTTY_DIR, or a
checkout of neuroplastio/hotty next to this one).

Serves dist/ (build it with `npm run build`) and a WebSocket at /ws. Each
connection runs the program on its own pty: pty output goes to the page as
binary frames, the page's input comes back as binary frames, and
`{"resize": [cols, rows]}` text frames resize the pty.

Standard library only (no node-pty, which needs a native build). It listens
on 127.0.0.1: it runs programs for whoever connects.

`/leak/...` answers 404 and records the request; `/leaks` lists them. The
hostile-page tests point every URL they can at it: a surface must never
reach it.
"""
import argparse
import base64
import fcntl
import hashlib
import http.server
import json
import os
import pty
import select
import shlex
import signal
import socket
import struct
import sys
import termios
import threading
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")


def hotty_dir():
    """The HOTTY repository (its examples): HOTTY_DIR, or a checkout next to
    this one (../hotty, or ../../hotty/main in the worktree layout)."""
    if os.environ.get("HOTTY_DIR"):
        return os.path.abspath(os.environ["HOTTY_DIR"])
    for c in (os.path.join(HERE, "..", "hotty"), os.path.join(HERE, "..", "..", "hotty", "main")):
        if os.path.isfile(os.path.join(c, "SPEC.md")):
            return os.path.abspath(c)
    return None


ROOT = hotty_dir()
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json"}

# Page policies for `?csp=<name>`. "strict" breaks xterm.js itself (its DOM
# renderer sets inline styles); "recommended" is what an embedder needs for
# xterm.js plus HOTTY (README.md).
POLICIES = {
    "strict": "default-src 'self'; connect-src 'self' ws:; style-src 'self'",
    "recommended": "default-src 'self'; connect-src 'self' ws:; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:",
}

leaks = []
leaks_lock = threading.Lock()


class WebSocket:
    """The server side of RFC 6455, enough for one binary stream each way."""

    def __init__(self, sock):
        self.sock = sock
        self.lock = threading.Lock()

    def send(self, data, opcode=0x2):
        n = len(data)
        if n < 126:
            head = struct.pack("!BB", 0x80 | opcode, n)
        elif n < 1 << 16:
            head = struct.pack("!BBH", 0x80 | opcode, 126, n)
        else:
            head = struct.pack("!BBQ", 0x80 | opcode, 127, n)
        with self.lock:
            self.sock.sendall(head + data)

    def _read(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise EOFError
            buf += chunk
        return buf

    def recv(self):
        """Returns (opcode, payload) of the next complete message."""
        message, first = b"", None
        while True:
            b0, b1 = self._read(2)
            fin, opcode = b0 & 0x80, b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read(8))[0]
            mask = self._read(4) if b1 & 0x80 else b"\0\0\0\0"
            data = bytes(c ^ mask[i % 4] for i, c in enumerate(self._read(n)))
            if opcode == 0x9:
                self.send(data, 0xA)
                continue
            if opcode == 0x8:
                raise EOFError
            if opcode in (0x1, 0x2):
                first, message = opcode, data
            elif opcode == 0x0:
                message += data
            if fin:
                return first, message


def run_program(ws, argv):
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
        os.chdir(ROOT or HERE)
        try:
            os.execvpe(argv[0], argv, env)
        finally:
            os._exit(127)

    def resize(cols, rows):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    stop = threading.Event()

    def pump_output():
        try:
            while not stop.is_set():
                r, _, _ = select.select([fd], [], [], 0.25)
                if not r:
                    continue
                try:
                    data = os.read(fd, 1 << 16)
                except OSError:
                    break
                if not data:
                    break
                ws.send(data)
        except OSError:
            pass
        finally:
            stop.set()
            try:
                ws.send(b"", 0x8)
            except OSError:
                pass

    out = threading.Thread(target=pump_output, daemon=True)
    out.start()
    try:
        while not stop.is_set():
            opcode, data = ws.recv()
            if opcode == 0x1:
                msg = json.loads(data)
                if "resize" in msg:
                    resize(*msg["resize"])
            else:
                os.write(fd, data)
    except (EOFError, OSError, ValueError):
        pass
    finally:
        stop.set()
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        os.close(fd)


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "hotty-serve"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if self.server.verbose:
            super().log_message(fmt, *args)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path.startswith("/leak"):
            if url.path == "/leaks":
                with leaks_lock:
                    return self.reply(200, "application/json", json.dumps(leaks).encode())
            with leaks_lock:
                leaks.append(self.path)
            return self.reply(404, "text/plain", b"")
        if url.path == "/ws":
            return self.websocket(urllib.parse.parse_qs(url.query))
        name = "index.html" if url.path in ("/", "") else url.path.lstrip("/")
        path = os.path.normpath(os.path.join(DIST, name))
        if not path.startswith(DIST + os.sep) or not os.path.isfile(path):
            return self.reply(404, "text/plain", b"not found")
        with open(path, "rb") as f:
            body = f.read()
        headers = {}
        # `?csp=strict`: the page under a strict policy of its own, to see
        # what an embedder's CSP does to the surfaces (srcdoc and about:blank
        # iframes inherit it).
        csp = urllib.parse.parse_qs(url.query).get("csp", [None])[0]
        if name == "index.html" and csp in POLICIES:
            headers["Content-Security-Policy"] = POLICIES[csp]
        self.reply(200, TYPES.get(os.path.splitext(path)[1], "application/octet-stream"), body, headers)

    do_POST = do_GET

    def reply(self, code, ctype, body, headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def websocket(self, query):
        argv = self.server.argv
        if self.server.examples and "run" in query and ROOT:
            name = query["run"][0]
            script = os.path.join(ROOT, "examples", f"{name}.py")
            if not name.replace("_", "").replace("-", "").isalnum() or not os.path.isfile(script):
                return self.reply(404, "text/plain", b"no such example")
            argv = [sys.executable, script, *shlex.split(query.get("args", [""])[0])]
        if not argv:
            return self.reply(400, "text/plain", b"no program: pass one after --, or --examples")
        key = self.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.wfile.flush()
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        run_program(WebSocket(self.connection), argv)
        self.close_connection = True


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--examples", action="store_true", help="run examples/<name>.py for /?run=<name>")
    p.add_argument("--verbose", action="store_true")
    p.add_argument("argv", nargs=argparse.REMAINDER, help="-- program [args...]")
    a = p.parse_args()
    argv = a.argv[1:] if a.argv[:1] == ["--"] else a.argv
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        sys.exit("dist/ is missing: run `npm run build` first")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    server.daemon_threads = True
    server.argv, server.examples, server.verbose = argv, a.examples, a.verbose
    print(f"http://127.0.0.1:{server.server_address[1]}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
