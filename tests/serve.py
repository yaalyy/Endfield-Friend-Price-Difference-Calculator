"""Static server for local tests. Serves the repo root; POST /result writes the body to tests/.last-result.txt.

Usage: python -I tests/serve.py [port]
"""
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
RESULT = ROOT / 'tests' / '.last-result.txt'


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.wasm': 'application/wasm', '.js': 'text/javascript'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self):
        if self.path != '/result':
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        RESULT.write_bytes(body)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
