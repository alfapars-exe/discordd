"""Private, bounded EJS computation; this service never contacts YouTube."""

import hashlib
import hmac
import json
import os
from pathlib import Path
import selectors
import select
import signal
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


PROTOCOL = "ejs-0.8.0-deno-2.9.8-v1"
MAX_BODY = 8 << 20
MAX_PLAYER = 6 << 20
MAX_OUTPUT = 1 << 20
DENO_ARGS = (
    "run", "--ext=js", "--no-code-cache", "--no-prompt", "--no-remote",
    "--no-lock", "--node-modules-dir=none", "--no-config", "--no-npm",
    "--cached-only", "-",
)
SCRIPT_HASHES = {
    "lib.min.js": "c55987fe697e5b9ee18830163f7af85327e9bb5c3e674b969d38c8d205eaa577",
    "core.min.js": "18da6ce0758b416e7ae645084f4f8801f9f9d59d6c477c05eaa0ff94ebd8cc00",
}
ERROR_STATUS = {
    "unauthorized": 401, "protocol_mismatch": 400, "invalid_request": 400,
    "payload_too_large": 413, "busy": 429, "timeout": 504,
    "output_limit": 502, "solver_failed": 502,
}


class SolverError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class ClientDisconnected(Exception):
    pass


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError("invalid constant")


def strict_json(data):
    if isinstance(data, bytes):
        data = data.decode("utf-8")
    return json.loads(data, object_pairs_hook=unique_object, parse_constant=reject_constant)


def bounded_string(value, limit):
    return isinstance(value, str) and bool(value) and len(value.encode("utf-8")) <= limit


def parse_request(body):
    if len(body) > MAX_BODY:
        raise SolverError("payload_too_large")
    try:
        data = strict_json(body)
        if not isinstance(data, dict) or set(data) != {"type", "player", "requests", "output_preprocessed"}:
            raise ValueError("fields")
        if data["type"] != "player" or type(data["output_preprocessed"]) is not bool:
            raise ValueError("type")
        if not isinstance(data["player"], str) or not data["player"]:
            raise ValueError("player")
        if len(data["player"].encode("utf-8")) > MAX_PLAYER:
            raise SolverError("payload_too_large")
        requests = data["requests"]
        if not isinstance(requests, list) or not 1 <= len(requests) <= 16:
            raise ValueError("requests")
        count = 0
        for request in requests:
            if not isinstance(request, dict) or set(request) != {"type", "challenges"}:
                raise ValueError("request fields")
            if request["type"] not in ("n", "sig"):
                raise ValueError("challenge type")
            challenges = request["challenges"]
            if not isinstance(challenges, list) or not challenges:
                raise ValueError("challenges")
            count += len(challenges)
            if count > 512 or not all(bounded_string(value, 16 << 10) for value in challenges):
                raise ValueError("challenge size")
        # yt-dlp's preprocessed-player cache is disabled. Never return player
        # code or spend output/memory on a cache artifact it will discard.
        data["output_preprocessed"] = False
        return data
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        raise SolverError("invalid_request") from exc


def validated_output(raw, request):
    if len(raw) > MAX_OUTPUT:
        raise SolverError("output_limit")
    try:
        data = strict_json(raw)
        if not isinstance(data, dict) or set(data) != {"type", "responses"} or data["type"] != "result":
            raise ValueError("result")
        responses = data["responses"]
        if not isinstance(responses, list) or len(responses) != len(request["requests"]):
            raise ValueError("responses")
        for response, original in zip(responses, request["requests"]):
            if not isinstance(response, dict) or set(response) != {"type", "data"} or response["type"] != "result":
                raise ValueError("response")
            values = response["data"]
            if not isinstance(values, dict) or set(values) != set(original["challenges"]):
                raise ValueError("challenge keys")
            if not all(bounded_string(value, 16 << 10) for value in values.values()):
                raise ValueError("challenge results")
        encoded = json.dumps(data, separators=(",", ":"), ensure_ascii=True).encode("ascii")
        if len(encoded) > MAX_OUTPUT:
            raise SolverError("output_limit")
        return encoded
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        raise SolverError("solver_failed") from exc


def load_scripts(directory):
    scripts = []
    for name, expected in SCRIPT_HASHES.items():
        data = (Path(directory) / name).read_bytes()
        if not hmac.compare_digest(hashlib.sha256(data).hexdigest(), expected):
            raise ValueError("EJS integrity check failed")
        scripts.append(data.decode("utf-8"))
    return tuple(scripts)


def make_program(scripts, request):
    # Only JSON serialization introduces request data into fixed, owned code.
    # Never accept a script prefix, suffix, module, flags or executable path.
    lib, core = scripts
    data = json.dumps(request, separators=(",", ":"), ensure_ascii=True)
    return (lib + "\nObject.assign(globalThis, lib);\n" + core
            + "\nconsole.log(JSON.stringify(jsc(" + data + ")));\n").encode("utf-8")


def child_environment(directory):
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": directory,
        "TMPDIR": directory, "XDG_CACHE_HOME": directory, "DENO_DIR": directory,
        "DENO_V8_FLAGS": "--max-old-space-size=512,--max-semi-space-size=4",
        "LANG": "C.UTF-8",
    }


def stop_process_group(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    # Reap before removing the job directory or serving another request.
    process.wait(timeout=2)


class DenoRunner:
    def __init__(self, scripts, executable="/usr/local/bin/deno", deadline=20, output_limit=MAX_OUTPUT):
        self.scripts = scripts
        self.executable = executable
        self.deadline = deadline
        self.output_limit = output_limit

    def verify_version(self):
        with tempfile.TemporaryDirectory(prefix="hichat-js-version-") as directory:
            result = subprocess.run(
                [self.executable, "--version"], capture_output=True, timeout=5,
                env=child_environment(directory), cwd=directory, check=False,
            )
        if result.returncode or result.stderr or not result.stdout.startswith(b"deno 2.9.8 "):
            raise ValueError("Deno version check failed")

    def solve(self, request, disconnected):
        program = memoryview(make_program(self.scripts, request))
        expires = time.monotonic() + self.deadline
        with tempfile.TemporaryDirectory(prefix="hichat-js-") as directory:
            process = subprocess.Popen(
                [self.executable, *DENO_ARGS], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=child_environment(directory), cwd=directory, start_new_session=True,
            )
            output = bytearray()
            try:
                with selectors.DefaultSelector() as poller:
                    for stream, label, event in (
                        (process.stdin, "stdin", selectors.EVENT_WRITE),
                        (process.stdout, "stdout", selectors.EVENT_READ),
                        (process.stderr, "stderr", selectors.EVENT_READ),
                    ):
                        os.set_blocking(stream.fileno(), False)
                        poller.register(stream, event, label)
                    while poller.get_map() or process.poll() is None:
                        if disconnected():
                            raise ClientDisconnected()
                        remaining = expires - time.monotonic()
                        if remaining <= 0:
                            raise SolverError("timeout")
                        for key, _ in poller.select(min(remaining, 0.05)):
                            stream = key.fileobj
                            if key.data == "stdin":
                                try:
                                    written = os.write(stream.fileno(), program[:65536])
                                    program = program[written:]
                                except BrokenPipeError:
                                    program = program[:0]
                                if not program:
                                    poller.unregister(stream)
                                    stream.close()
                            else:
                                chunk = os.read(stream.fileno(), 65536)
                                if not chunk:
                                    poller.unregister(stream)
                                    stream.close()
                                elif key.data == "stderr":
                                    raise SolverError("solver_failed")
                                else:
                                    if len(output) + len(chunk) > self.output_limit:
                                        raise SolverError("output_limit")
                                    output.extend(chunk)
                    if process.returncode:
                        raise SolverError("solver_failed")
                    return bytes(output)
            finally:
                try:
                    stop_process_group(process)
                finally:
                    for stream in (process.stdin, process.stdout, process.stderr):
                        stream.close()


class SolverServer(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True
    allow_reuse_address = True

    def __init__(self, address, token, runner):
        self.expected_authorization = ("Bearer " + token).encode("ascii")
        self.runner = runner
        self.job_slot = threading.BoundedSemaphore(1)
        self.stopping = threading.Event()
        self.connections = set()
        self.connections_lock = threading.Lock()
        # Bound unauthenticated/slow connections as well as solver jobs.
        self.connection_slots = threading.BoundedSemaphore(16)
        super().__init__(address, SolverHandler)

    def process_request(self, request, client_address):
        if self.stopping.is_set() or not self.connection_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        with self.connections_lock:
            self.connections.add(request)
        try:
            super().process_request(request, client_address)
        except BaseException:
            with self.connections_lock:
                self.connections.discard(request)
            self.connection_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            with self.connections_lock:
                self.connections.discard(request)
            self.connection_slots.release()

    def stop(self):
        self.stopping.set()
        with self.connections_lock:
            connections = tuple(self.connections)
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.shutdown()

    def handle_error(self, request, client_address):
        # Do not log request payloads, credentials, tracebacks or child stderr.
        pass


class SolverHandler(BaseHTTPRequestHandler):
    server_version = "HiChatJSSolver"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, _format, *args):
        pass

    def send_error(self, _code, _message=None, _explain=None):
        self.reply(ERROR_STATUS["invalid_request"], {"error": "invalid_request"})

    def reply(self, status, payload):
        body = payload if isinstance(payload, bytes) else json.dumps(payload, separators=(",", ":")).encode("ascii")
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def handle_expect_100(self):
        # Do not acknowledge/upload a request before authentication and size checks.
        self.reply(400, {"error": "invalid_request"})
        return False

    def do_GET(self):
        if self.path != "/health":
            self.reply(404, {"error": "invalid_request"})
            return
        self.reply(200, {"status": "ok", "deno": "2.9.8", "ejs": "0.8.0", "protocol": PROTOCOL})

    def client_disconnected(self):
        if self.server.stopping.is_set():
            return True
        readable, _, _ = select.select([self.connection], [], [], 0)
        if not readable:
            return False
        try:
            return not self.connection.recv(1, socket.MSG_PEEK)
        except BlockingIOError:
            return False
        except OSError:
            return True

    def read_body(self, length):
        chunks = []
        remaining = length
        expires = time.monotonic() + 5
        while remaining:
            timeout = expires - time.monotonic()
            if timeout <= 0:
                raise SolverError("timeout")
            self.connection.settimeout(timeout)
            chunk = self.rfile.read1(min(remaining, 65536))
            if not chunk:
                raise ClientDisconnected()
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def do_POST(self):
        acquired = False
        try:
            if self.path != "/solve":
                self.reply(404, {"error": "invalid_request"})
                return
            headers = self.headers.get_all("Authorization", [])
            supplied = headers[0].encode("utf-8") if len(headers) == 1 else b""
            if not hmac.compare_digest(supplied, self.server.expected_authorization):
                raise SolverError("unauthorized")
            if self.headers.get_all("Origin"):
                raise SolverError("invalid_request")
            if self.headers.get_all("X-HiChat-JS-Protocol", []) != [PROTOCOL]:
                raise SolverError("protocol_mismatch")
            if self.headers.get_all("Content-Type", []) != ["application/json"]:
                raise SolverError("invalid_request")
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit() or self.headers.get_all("Transfer-Encoding"):
                raise SolverError("invalid_request")
            if len(lengths[0]) > 10:
                raise SolverError("payload_too_large")
            length = int(lengths[0])
            if length > MAX_BODY:
                raise SolverError("payload_too_large")
            if length <= 0:
                raise SolverError("invalid_request")
            acquired = self.server.job_slot.acquire(blocking=False)
            if not acquired:
                raise SolverError("busy")
            request = parse_request(self.read_body(length))
            raw = self.server.runner.solve(request, self.client_disconnected)
            self.reply(200, validated_output(raw, request))
        except ClientDisconnected:
            self.close_connection = True
        except SolverError as exc:
            self.reply(ERROR_STATUS[exc.code], {"error": exc.code})
        except (TimeoutError, socket.timeout):
            self.reply(504, {"error": "timeout"})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except (OSError, ValueError, subprocess.SubprocessError):
            # No exception text or child diagnostics cross the API boundary.
            self.reply(502, {"error": "solver_failed"})
        finally:
            if acquired:
                self.server.job_slot.release()


def serve(server):
    def stop(_signum, _frame):
        if not server.stopping.is_set():
            server.stopping.set()
            threading.Thread(target=server.stop, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print("solver ready", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()


def main():
    token = os.environ.get("HICHAT_JS_SOLVER_TOKEN", "")
    if not 32 <= len(token) <= 512 or not all(33 <= ord(char) <= 126 for char in token):
        raise SystemExit("solver configuration invalid")
    try:
        scripts = load_scripts(Path(__file__).parent / "vendor")
        runner = DenoRunner(scripts)
        runner.verify_version()
        server = SolverServer(("0.0.0.0", 7860), token, runner)
    except (OSError, ValueError, subprocess.SubprocessError):
        raise SystemExit("solver initialization failed") from None
    serve(server)


if __name__ == "__main__":
    main()
