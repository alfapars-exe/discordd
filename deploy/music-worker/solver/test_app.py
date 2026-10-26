import copy
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

import app


TOKEN = "test-token-" + "x" * 32
REQUEST = {"type": "player", "player": "synthetic public player", "requests": [
    {"type": "n", "challenges": ["test-challenge"]}], "output_preprocessed": True}
RESULT = {"type": "result", "responses": [{"type": "result", "data": {"test-challenge": "result"}}]}


def encoded(data):
    return json.dumps(data, separators=(",", ":")).encode()


class ValidationTests(unittest.TestCase):
    def test_owned_scripts_have_pinned_hashes(self):
        scripts = app.load_scripts(Path(__file__).parent / "vendor")
        self.assertEqual([len(code.encode()) for code in scripts], [151561, 6945])
        with tempfile.TemporaryDirectory() as directory:
            for name in app.SCRIPT_HASHES:
                (Path(directory) / name).write_bytes(b"changed")
            with self.assertRaises(ValueError):
                app.load_scripts(directory)

    def test_valid_request_suppresses_preprocessed_player(self):
        request = app.parse_request(encoded(REQUEST))
        self.assertFalse(request["output_preprocessed"])
        self.assertEqual(request["requests"], REQUEST["requests"])

    def test_rejects_unknown_duplicate_and_malformed_fields(self):
        variants = [None, [], {}, {**REQUEST, "code": "evil()"},
                    {**REQUEST, "runtime_flags": ["--allow-all"]},
                    {**REQUEST, "type": "preprocessed"},
                    {**REQUEST, "output_preprocessed": "false"},
                    {**REQUEST, "player": None}, {**REQUEST, "player": ""},
                    {**REQUEST, "requests": None}, {**REQUEST, "requests": []},
                    {**REQUEST, "requests": [None]},
                    {**REQUEST, "requests": [{"type": "n", "challenges": [None]}]},
                    {**REQUEST, "requests": [{"type": "n", "challenges": [42]}]},
                    {**REQUEST, "requests": [{"type": "n", "challenges": "a"}]},
                    {**REQUEST, "requests": [{"type": "n", "challenges": [""]}]},
                    {**REQUEST, "requests": [{"type": "bad", "challenges": ["x"]}]},
                    {**REQUEST, "requests": [{"type": "n", "challenges": ["x"], "code": "evil"}]}]
        for data in variants:
            with self.subTest(data=data), self.assertRaises(app.SolverError) as caught:
                app.parse_request(encoded(data))
            self.assertEqual(caught.exception.code, "invalid_request")
        duplicate = encoded(REQUEST).replace(b'"type":"player"', b'"type":"player","type":"player"')
        for raw in (duplicate, b"{", b"NaN", encoded(REQUEST).decode().encode("utf-16"),
                    encoded(REQUEST).replace(b"synthetic public player", b"\\ud800")):
            with self.subTest(raw=raw[:80]), self.assertRaises(app.SolverError):
                app.parse_request(raw)

    def test_request_size_limits(self):
        with self.assertRaises(app.SolverError) as caught:
            app.parse_request(b"x" * (app.MAX_BODY + 1))
        self.assertEqual(caught.exception.code, "payload_too_large")
        with self.assertRaises(app.SolverError) as caught:
            app.parse_request(encoded({**REQUEST, "player": "x" * (app.MAX_PLAYER + 1)}))
        self.assertEqual(caught.exception.code, "payload_too_large")
        for changes in ({"requests": REQUEST["requests"] * 17},
                        {"requests": [{"type": "n", "challenges": ["x"] * 513}]},
                        {"requests": [{"type": "n", "challenges": ["x" * 16385]}]}):
            with self.assertRaises(app.SolverError):
                app.parse_request(encoded({**REQUEST, **changes}))

    def test_script_uses_only_serialized_data(self):
        request = copy.deepcopy(REQUEST)
        request["player"] = '\");evil();/*\n\u2028'
        program = app.make_program(("fixed-lib", "fixed-core"), request).decode()
        prefix = "fixed-lib\nObject.assign(globalThis, lib);\nfixed-core\nconsole.log(JSON.stringify(jsc("
        suffix = ")));\n"
        self.assertTrue(program.startswith(prefix))
        self.assertTrue(program.endswith(suffix))
        self.assertEqual(json.loads(program[len(prefix):-len(suffix)]), request)

    def test_response_validation_and_error_sanitization(self):
        self.assertEqual(json.loads(app.validated_output(encoded(RESULT), REQUEST)), RESULT)
        cases = [{"type": "error", "error": "secret/raw player"},
                 {"type": "result", "responses": [{"type": "error", "error": "secret"}]},
                 {"type": "result", "responses": []},
                 {**RESULT, "preprocessed_player": "not allowed"},
                 {"type": "result", "responses": [{"type": "result", "data": {"other": "x"}}]},
                 {"type": "result", "responses": [{"type": "result", "data": {"test-challenge": None}}]}]
        for data in cases:
            with self.subTest(data=data), self.assertRaises(app.SolverError) as caught:
                app.validated_output(encoded(data), REQUEST)
            self.assertEqual(str(caught.exception), "solver_failed")
        with self.assertRaises(app.SolverError) as caught:
            app.validated_output(b"x" * (app.MAX_OUTPUT + 1), REQUEST)
        self.assertEqual(caught.exception.code, "output_limit")

    def test_child_environment_excludes_secrets_and_ambient_flags(self):
        with mock.patch.dict(os.environ, {"HICHAT_JS_SOLVER_TOKEN": "secret",
                                         "HF_TOKEN": "hf-secret", "DENO_FLAGS": "--allow-all",
                                         "DENO_V8_FLAGS": "untrusted", "HTTP_PROXY": "secret"}):
            env = app.child_environment("/tmp/private")
        self.assertEqual(env["DENO_V8_FLAGS"], "--max-old-space-size=512,--max-semi-space-size=4")
        self.assertFalse(any("secret" in value for value in env.values()))
        self.assertEqual(set(env), {"PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME", "DENO_DIR", "DENO_V8_FLAGS", "LANG"})
        self.assertFalse(any(flag.startswith("--allow-") for flag in app.DENO_ARGS))


class FakeRunner:
    def __init__(self):
        self.calls = []

    def solve(self, request, disconnected):
        self.calls.append(request)
        return encoded(RESULT)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.runner = FakeRunner()
        self.server = app.SolverServer(("127.0.0.1", 0), TOKEN, self.runner)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def headers(self):
        return {"Authorization": "Bearer " + TOKEN, "X-HiChat-JS-Protocol": app.PROTOCOL,
                "Content-Type": "application/json"}

    def send(self, body=None, headers=None, method="POST", path="/solve"):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=2)
        connection.request(method, path, encoded(REQUEST) if body is None else body,
                           self.headers() if headers is None else headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_health_and_valid_job(self):
        status, health = self.send(method="GET", path="/health", headers={}, body=b"")
        self.assertEqual(status, 200)
        self.assertEqual(health["protocol"], app.PROTOCOL)
        self.assertEqual(self.send(), (200, RESULT))
        self.assertFalse(self.runner.calls[0]["output_preprocessed"])

    def test_authentication_precedes_body_read(self):
        connection = socket.create_connection(self.server.server_address, timeout=2)
        connection.sendall(b"POST /solve HTTP/1.1\r\nHost: local\r\nContent-Length: 8000000\r\n\r\n")
        response = http.client.HTTPResponse(connection)
        response.begin()
        self.assertEqual(response.status, 401)
        self.assertEqual(json.loads(response.read()), {"error": "unauthorized"})
        connection.close()
        self.assertFalse(self.runner.calls)

    def test_protocol_body_and_busy_errors_are_fixed(self):
        bad_protocol = {**self.headers(), "X-HiChat-JS-Protocol": "unknown"}
        self.assertEqual(self.send(headers=bad_protocol), (400, {"error": "protocol_mismatch"}))
        self.assertEqual(self.send(body=b"not JSON"), (400, {"error": "invalid_request"}))
        self.server.job_slot.acquire()
        try:
            self.assertEqual(self.send(), (429, {"error": "busy"}))
        finally:
            self.server.job_slot.release()
        self.assertEqual(self.send(), (200, RESULT))

    def test_origin_and_ambiguous_framing_are_rejected(self):
        self.assertEqual(self.send(headers={**self.headers(), "Origin": "https://example.com"}),
                         (400, {"error": "invalid_request"}))
        for length, expected in (("9" * 5000, 413), ("invalid", 400), ("-1", 400)):
            connection = socket.create_connection(self.server.server_address, timeout=2)
            headers = ("POST /solve HTTP/1.1\r\nHost: local\r\nAuthorization: Bearer " + TOKEN
                       + "\r\nX-HiChat-JS-Protocol: " + app.PROTOCOL
                       + "\r\nContent-Type: application/json\r\nContent-Length: " + length + "\r\n\r\n")
            connection.sendall(headers.encode())
            response = http.client.HTTPResponse(connection)
            response.begin()
            self.assertEqual(response.status, expected)
            response.read()
            connection.close()
        self.assertFalse(self.runner.calls)

    def test_output_failure_has_no_raw_diagnostics(self):
        with mock.patch.object(self.runner, "solve", return_value=b'{"type":"error","error":"private secret"}'):
            self.assertEqual(self.send(), (502, {"error": "solver_failed"}))
        self.assertEqual(self.send(), (200, RESULT))


@unittest.skipUnless(os.name == "posix", "Linux process lifecycle")
class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.directory.cleanup()

    def runner(self, body, **kwargs):
        filename = Path(self.directory.name) / "fake-deno"
        filename.write_text("#!" + sys.executable + "\nimport os,sys,time,subprocess\n" + body)
        filename.chmod(0o700)
        return app.DenoRunner(("owned-lib", "owned-core"), executable=str(filename), **kwargs)

    def test_process_success_and_stderr_failure(self):
        runner = self.runner("sys.stdin.read()\nprint(" + repr(json.dumps(RESULT)) + ")\n")
        self.assertEqual(json.loads(runner.solve(REQUEST, lambda: False)), RESULT)
        runner = self.runner("sys.stderr.write('secret raw error')\nsys.stderr.flush()\ntime.sleep(30)\n")
        started = time.monotonic()
        with self.assertRaises(app.SolverError) as caught:
            runner.solve(REQUEST, lambda: False)
        self.assertEqual(str(caught.exception), "solver_failed")
        self.assertLess(time.monotonic() - started, 2)

    def test_output_limit_and_deadline(self):
        runner = self.runner("sys.stdout.write('x'*4096)\nsys.stdout.flush()\ntime.sleep(30)\n", output_limit=100)
        with self.assertRaises(app.SolverError) as caught:
            runner.solve(REQUEST, lambda: False)
        self.assertEqual(caught.exception.code, "output_limit")
        runner = self.runner("time.sleep(30)\n", deadline=0.15)
        started = time.monotonic()
        with self.assertRaises(app.SolverError) as caught:
            runner.solve(REQUEST, lambda: False)
        self.assertEqual(caught.exception.code, "timeout")
        self.assertLess(time.monotonic() - started, 2)

    def test_http_disconnect_kills_silent_child_and_descendant(self):
        pidfile = Path(self.directory.name) / "pids"
        runner = self.runner("child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])\n"
                             + "open(" + repr(str(pidfile)) + ",'w').write(str(os.getpid())+' '+str(child.pid))\n"
                             + "time.sleep(30)\n")
        server = app.SolverServer(("127.0.0.1", 0), TOKEN, runner)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        connection = socket.create_connection(server.server_address, timeout=2)
        body = encoded(REQUEST)
        headers = ("POST /solve HTTP/1.1\r\nHost: local\r\nAuthorization: Bearer " + TOKEN
                   + "\r\nX-HiChat-JS-Protocol: " + app.PROTOCOL
                   + "\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)) + "\r\n\r\n")
        try:
            connection.sendall(headers.encode() + body)
            expires = time.monotonic() + 2
            while not pidfile.exists() and time.monotonic() < expires:
                time.sleep(0.01)
            self.assertTrue(pidfile.exists())
            pids = [int(pid) for pid in pidfile.read_text().split()]
            connection.close()
            def running(pid):
                try:
                    return Path(f"/proc/{pid}/stat").read_text().split()[2] != "Z"
                except FileNotFoundError:
                    return False
            expires = time.monotonic() + 2
            while any(running(pid) for pid in pids) and time.monotonic() < expires:
                time.sleep(0.01)
            self.assertFalse(any(running(pid) for pid in pids))
            self.assertTrue(server.job_slot.acquire(timeout=1))
            server.job_slot.release()
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_sigterm_reaps_active_solver_before_service_exit(self):
        pidfile = Path(self.directory.name) / "signal-pids"
        portfile = Path(self.directory.name) / "port"
        runner = self.runner("child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])\n"
                             + "open(" + repr(str(pidfile)) + ",'w').write(str(os.getpid())+' '+str(child.pid))\n"
                             + "time.sleep(30)\n")
        bootstrap = ("import app\nfrom pathlib import Path\n"
                     + "runner=app.DenoRunner(('owned-lib','owned-core'),executable=" + repr(runner.executable) + ")\n"
                     + "server=app.SolverServer(('127.0.0.1',0)," + repr(TOKEN) + ",runner)\n"
                     + "Path(" + repr(str(portfile)) + ").write_text(str(server.server_address[1]))\n"
                     + "app.serve(server)\n")
        service = subprocess.Popen([sys.executable, "-c", bootstrap], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        connection = None
        try:
            expires = time.monotonic() + 2
            while not portfile.exists() and time.monotonic() < expires:
                time.sleep(0.01)
            self.assertTrue(portfile.exists())
            connection = socket.create_connection(("127.0.0.1", int(portfile.read_text())), timeout=2)
            body = encoded(REQUEST)
            headers = ("POST /solve HTTP/1.1\r\nHost: local\r\nAuthorization: Bearer " + TOKEN
                       + "\r\nX-HiChat-JS-Protocol: " + app.PROTOCOL
                       + "\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)) + "\r\n\r\n")
            connection.sendall(headers.encode() + body)
            expires = time.monotonic() + 2
            while not pidfile.exists() and time.monotonic() < expires:
                time.sleep(0.01)
            self.assertTrue(pidfile.exists())
            pids = [int(pid) for pid in pidfile.read_text().split()]
            service.terminate()
            stdout, stderr = service.communicate(timeout=3)
            self.assertEqual(service.returncode, 0)
            self.assertEqual(stdout.strip(), b"solver ready")
            self.assertFalse(stderr)
            for pid in pids:
                try:
                    self.assertEqual(Path(f"/proc/{pid}/stat").read_text().split()[2], "Z")
                except FileNotFoundError:
                    pass
        finally:
            if connection:
                connection.close()
            if service.poll() is None:
                service.kill()
            service.communicate(timeout=3)


@unittest.skipUnless(os.name == "posix" and Path("/usr/local/bin/deno").exists(), "pinned Deno unavailable")
class RealDenoTests(unittest.TestCase):
    def test_fixed_permissions_and_secret_free_environment(self):
        program = '''const checks={env:()=>Deno.env.get("HICHAT_JS_SOLVER_TOKEN"),
          read:()=>Deno.readTextFile("/etc/hostname"),write:()=>Deno.writeTextFile("/tmp/forbidden","x"),
          net:()=>Deno.connect({hostname:"127.0.0.1",port:1}),run:()=>new Deno.Command("/bin/true").output(),
          ffi:()=>Deno.dlopen("/does-not-exist",{})};
          const result={};for(const [key,fn] of Object.entries(checks)){
          try{await fn();result[key]="ALLOWED";}catch(e){result[key]=e.name;}}
          console.log(JSON.stringify(result));'''
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(["/usr/local/bin/deno", *app.DENO_ARGS], input=program.encode(),
                                    capture_output=True, timeout=5, check=True,
                                    env=app.child_environment(directory), cwd=directory)
        self.assertFalse(result.stderr)
        self.assertEqual(json.loads(result.stdout), {key: "NotCapable" for key in ("env", "read", "write", "net", "run", "ffi")})

    def test_owned_ejs_synthetic_player_without_network(self):
        player = '''(function(){
          function Params(){this.values={};}
          Params.prototype.set=function(k,v){this.values[k]=v;};
          Params.prototype.get=function(k){return this.values[k];};
          Params.prototype.update=function(){};
          function transform(url,key,sig){var result=new Params();result.set("alr","yes");
            if(sig)result.set("s",sig);return result;}
        }).call(this);'''
        request = app.parse_request(encoded({**REQUEST, "player": player}))
        runner = app.DenoRunner(app.load_scripts(Path(__file__).parent / "vendor"))
        runner.verify_version()
        output = json.loads(app.validated_output(runner.solve(request, lambda: False), request))
        self.assertEqual(output["responses"][0]["data"], {"test-challenge": "test-challenge"})


if __name__ == "__main__":
    unittest.main()
