"""
Entry point for cPanel "Setup Python App" (Passenger).

It runs the same GovShield handler (server.Handler) through the WSGI interface,
so every page and API route behaves exactly as with `python server.py`.
Render and a normal computer do not need this file: use `python server.py`.
"""
import io
import os
import sys
from http import HTTPStatus

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import server  # the GovShield module in this same folder

server.init_db()


class _Headers(dict):
    """Case-insensitive header lookup, as the handler expects."""

    def get(self, name, default=None):
        for key, value in self.items():
            if key.lower() == name.lower():
                return value
        return default


class _WsgiRequest(server.Handler):
    """Lets the existing handler run without a socket."""

    def __init__(self, environ):
        self.headers = _Headers()
        for key, value in environ.items():
            if key.startswith("HTTP_"):
                self.headers[key[5:].replace("_", "-").title()] = value
        if environ.get("CONTENT_TYPE"):
            self.headers["Content-Type"] = environ["CONTENT_TYPE"]
        if environ.get("CONTENT_LENGTH"):
            self.headers["Content-Length"] = environ["CONTENT_LENGTH"]
        self.command = environ["REQUEST_METHOD"]
        query = environ.get("QUERY_STRING", "")
        self.path = environ.get("PATH_INFO", "/") + ("?" + query if query else "")
        self.client_address = (environ.get("REMOTE_ADDR", "127.0.0.1"), 0)
        self.rfile = environ["wsgi.input"]
        self.wfile = io.BytesIO()
        self.status_code = 500
        self.response_headers = []

    def send_response(self, code, message=None):
        self.status_code = code

    def send_header(self, keyword, value):
        self.response_headers.append((keyword, value))

    def end_headers(self):
        pass


def application(environ, start_response):
    request = _WsgiRequest(environ)
    method = environ["REQUEST_METHOD"]
    if method == "GET":
        request.do_GET()
    elif method == "POST":
        request.do_POST()
    elif method == "OPTIONS":
        request.do_OPTIONS()
    else:
        request._json(405, {"error": "Method not allowed."})
    body = request.wfile.getvalue()
    status = "%d %s" % (request.status_code, HTTPStatus(request.status_code).phrase)
    start_response(status, request.response_headers)
    return [body]
