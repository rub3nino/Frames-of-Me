#!/usr/bin/env python3
"""Server dell'editor pecorella: serve brand-identity/ e accetta POST /save
che scrive pecorella/mascot/layout.json (le posizioni scelte nell'editor)."""
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))              # .../pecorella/mascot
ROOT = os.path.dirname(os.path.dirname(HERE))                  # .../brand-identity
SAVE_PATH = os.path.join(HERE, "layout.json")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_POST(self):
        if self.path != "/save":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw)
            with open(SAVE_PATH, "w") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            body = b'{"ok":true}'
            self.send_response(200)
        except Exception as exc:  # noqa: BLE001
            body = json.dumps({"ok": False, "error": str(exc)}).encode()
            self.send_response(400)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # silenzioso
        pass


if __name__ == "__main__":
    print("Editor su http://127.0.0.1:8788/pecorella/mascot/editor.html — salva in", SAVE_PATH)
    ThreadingHTTPServer(("127.0.0.1", 8788), Handler).serve_forever()
