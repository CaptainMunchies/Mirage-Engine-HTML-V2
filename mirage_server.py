#!/usr/bin/env python3
"""
Mirage Engine local server — serves static files + proxies Google / kie.ai APIs.
Fixes browser CORS for Interactions and kie Market endpoints.
"""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote
import base64
import json
import mimetypes
import time
import urllib.error
import urllib.request

GEMINI_INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions'
KIE_API = 'https://api.kie.ai'
KIE_UPLOAD = 'https://kieai.redpandaai.co'
PORT = 8080

# Cloudflare Browser Integrity Check bans Python-urllib/* (error 1010).
KIE_BROWSER_UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/126.0.0.0 Safari/537.36'
)


class MirageHandler(SimpleHTTPRequestHandler):
    # Windows registry often maps .js → text/plain, which Firefox warns on
    # and some browsers refuse to execute.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.wasm': 'application/wasm',
    }

    def guess_type(self, path):
        ext = ''
        if '.' in path:
            ext = '.' + path.rsplit('.', 1)[-1].lower()
        mapped = self.extensions_map.get(ext)
        if mapped:
            return mapped
        guessed = mimetypes.guess_type(path)[0]
        return guessed or super().guess_type(path)

    def end_headers(self):
        super().end_headers()

    def do_OPTIONS(self):
        path = self.path.split('?', 1)[0]
        if path.startswith('/api/proxy/'):
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header(
                'Access-Control-Allow-Headers',
                'Content-Type, X-Mirage-Api-Key, Authorization'
            )
            self.end_headers()
            return
        self.send_error(501, 'Unsupported method (OPTIONS)')

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/proxy/kie/jobs/status':
            self._kie_job_status()
            return
        if path == '/api/proxy/kie/flux-kontext/status':
            self._kie_flux_kontext_status()
            return
        if path == '/api/proxy/kie/credits':
            self._kie_credits()
            return
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/api/proxy/interactions':
            self._proxy_interactions()
            return
        if path == '/api/proxy/kie/chat':
            self._kie_chat()
            return
        if path == '/api/proxy/kie/jobs':
            self._kie_create_job()
            return
        if path == '/api/proxy/kie/flux-kontext':
            self._kie_flux_kontext_generate()
            return
        if path == '/api/proxy/kie/upload':
            self._kie_upload()
            return
        if path == '/api/proxy/kie/fetch-image':
            self._kie_fetch_image()
            return
        self.send_error(404, 'Not Found')

    def _read_json_body(self):
        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length) if length else b'{}'
        try:
            return json.loads(raw.decode('utf-8') or '{}')
        except json.JSONDecodeError:
            return None

    def _api_key(self):
        return (self.headers.get('X-Mirage-Api-Key') or '').strip()

    def _proxy_interactions(self):
        api_key = self._api_key()
        if not api_key:
            self._json_response(400, {'error': {'message': 'Missing X-Mirage-Api-Key header'}})
            return

        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length else b''

        req = urllib.request.Request(
            GEMINI_INTERACTIONS,
            data=body,
            method='POST',
            headers={
                'Content-Type': 'application/json',
                'x-goog-api-key': api_key,
            },
        )
        self._forward(req)

    def _kie_headers(self, api_key, content_type='application/json'):
        headers = {
            'Authorization': f'Bearer {api_key}',
            'User-Agent': KIE_BROWSER_UA,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Origin': 'https://kie.ai',
            'Referer': 'https://kie.ai/',
        }
        if content_type:
            headers['Content-Type'] = content_type
        return headers

    def _cloudflare_blocked(self, status, body_bytes):
        text = (body_bytes or b'').decode('utf-8', errors='replace')
        low = text.lower()
        return status == 403 and (
            'error code: 1010' in low
            or 'error 1010' in low
            or ('browser' in low and 'signature' in low)
        )

    def _kie_chat(self):
        api_key = self._api_key()
        if not api_key:
            self._json_response(400, {'error': {'message': 'Missing X-Mirage-Api-Key header'}})
            return
        payload = self._read_json_body()
        if payload is None:
            self._json_response(400, {'error': {'message': 'Invalid JSON body'}})
            return

        chat_path = str(payload.get('path') or '').strip()
        if not chat_path.startswith('/'):
            self._json_response(400, {'error': {'message': 'Invalid kie chat path'}})
            return
        # Allow OpenAI-compatible chat completions + Responses APIs (Grok / GPT Codex)
        allowed = (
            '/v1/chat/completions' in chat_path
            or 'chat/completions' in chat_path
            or '/v1/responses' in chat_path
            or chat_path.endswith('/responses')
        )
        if not allowed:
            self._json_response(400, {
                'error': {
                    'message': (
                        f'Refusing non-chat kie path: {chat_path}. '
                        'Restart START MIRAGE.bat to load the latest proxy.'
                    )
                }
            })
            return

        body = json.dumps(payload.get('payload') or {}).encode('utf-8')
        req = urllib.request.Request(
            f'{KIE_API}{chat_path}',
            data=body,
            method='POST',
            headers=self._kie_headers(api_key),
        )
        self._forward(req, timeout=180)

    def _kie_create_job(self):
        api_key = self._api_key()
        if not api_key:
            self._json_response(400, {'error': {'message': 'Missing X-Mirage-Api-Key header'}})
            return
        payload = self._read_json_body()
        if payload is None:
            self._json_response(400, {'error': {'message': 'Invalid JSON body'}})
            return

        body = json.dumps({
            'model': payload.get('model'),
            'input': payload.get('input') or {},
        }).encode('utf-8')
        req = urllib.request.Request(
            f'{KIE_API}/api/v1/jobs/createTask',
            data=body,
            method='POST',
            headers=self._kie_headers(api_key),
        )
        self._forward(req, timeout=60)

    def _kie_job_status(self):
        api_key = self._api_key()
        if not api_key:
            self._json_response(400, {'error': {'message': 'Missing X-Mirage-Api-Key header'}})
            return
        qs = parse_qs(urlparse(self.path).query)
        task_id = (qs.get('taskId') or [''])[0].strip()
        if not task_id:
            self._json_response(400, {'error': {'message': 'taskId required'}})
            return

        url = f'{KIE_API}/api/v1/jobs/recordInfo?taskId={quote(task_id)}'
        req = urllib.request.Request(url, method='GET', headers=self._kie_headers(api_key, None))
        self._forward(req, timeout=60)

    def _kie_flux_kontext_generate(self):
        api_key = self._api_key()
        if not api_key:
            self._json_response(400, {'error': {'message': 'Missing X-Mirage-Api-Key header'}})
            return
        payload = self._read_json_body()
        if payload is None:
            self._json_response(400, {'error': {'message': 'Invalid JSON body'}})
            return

        body = json.dumps(payload if isinstance(payload, dict) else {}).encode('utf-8')
        req = urllib.request.Request(
            f'{KIE_API}/api/v1/flux/kontext/generate',
            data=body,
            method='POST',
            headers=self._kie_headers(api_key),
        )
        self._forward(req, timeout=60)

    def _kie_flux_kontext_status(self):
        api_key = self._api_key()
        if not api_key:
            self._json_response(400, {'error': {'message': 'Missing X-Mirage-Api-Key header'}})
            return
        qs = parse_qs(urlparse(self.path).query)
        task_id = (qs.get('taskId') or [''])[0].strip()
        if not task_id:
            self._json_response(400, {'error': {'message': 'taskId required'}})
            return

        url = f'{KIE_API}/api/v1/flux/kontext/record-info?taskId={quote(task_id)}'
        req = urllib.request.Request(url, method='GET', headers=self._kie_headers(api_key, None))
        self._forward(req, timeout=60)

    def _kie_credits(self):
        api_key = self._api_key()
        if not api_key:
            self._json_response(400, {'error': {'message': 'Missing X-Mirage-Api-Key header'}})
            return
        req = urllib.request.Request(
            f'{KIE_API}/api/v1/chat/credit',
            method='GET',
            headers=self._kie_headers(api_key, None),
        )
        self._forward(req, timeout=30)

    def _kie_upload(self):
        api_key = self._api_key()
        if not api_key:
            self._json_response(400, {'error': {'message': 'Missing X-Mirage-Api-Key header'}})
            return
        payload = self._read_json_body()
        if payload is None:
            self._json_response(400, {'error': {'message': 'Invalid JSON body'}})
            return

        body = json.dumps({
            'base64Data': payload.get('base64Data'),
            'uploadPath': payload.get('uploadPath') or 'mirage-refs',
            'fileName': payload.get('fileName'),
        }).encode('utf-8')
        req = urllib.request.Request(
            f'{KIE_UPLOAD}/api/file-base64-upload',
            data=body,
            method='POST',
            headers=self._kie_headers(api_key),
        )
        self._forward(req, timeout=120)

    def _kie_fetch_image(self):
        api_key = self._api_key()
        if not api_key:
            self._json_response(400, {'error': {'message': 'Missing X-Mirage-Api-Key header'}})
            return
        payload = self._read_json_body()
        if payload is None:
            self._json_response(400, {'error': {'message': 'Invalid JSON body'}})
            return
        url = str(payload.get('url') or '').strip()
        if not url.startswith('http://') and not url.startswith('https://'):
            self._json_response(400, {'error': {'message': 'Invalid image url'}})
            return

        # Result URLs are usually public tempfiles; Bearer can break some CDNs.
        req = urllib.request.Request(
            url,
            method='GET',
            headers={
                'User-Agent': KIE_BROWSER_UA,
                'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                raw = resp.read()
                ctype = resp.headers.get('Content-Type') or 'image/png'
                if ';' in ctype:
                    ctype = ctype.split(';', 1)[0].strip()
                if not ctype.startswith('image/'):
                    ctype = 'image/png'
                data_url = f'data:{ctype};base64,' + base64.b64encode(raw).decode('ascii')
                self._json_response(200, {'dataUrl': data_url})
        except urllib.error.HTTPError as e:
            err_body = e.read()
            if self._cloudflare_blocked(e.code, err_body):
                self._json_response(403, {
                    'error': {
                        'message': (
                            'Cloudflare blocked image download (error 1010). '
                            'Restart START MIRAGE.bat and retry.'
                        )
                    }
                })
                return
            preview = err_body.decode('utf-8', errors='replace')[:300]
            self._json_response(e.code, {'error': {'message': f'Image fetch failed: {preview}'}})
        except Exception as e:
            self._json_response(502, {'error': {'message': f'Image fetch error: {e}'}})

    def _forward(self, req, timeout=300):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            err_body = e.read()
            if self._cloudflare_blocked(e.code, err_body):
                print('[Mirage] kie Cloudflare 1010 blocked outbound request — check User-Agent headers')
                self._json_response(403, {
                    'code': 403,
                    'msg': (
                        'Cloudflare blocked the kie.ai request (error 1010 — browser signature). '
                        'Restart START MIRAGE.bat so the proxy sends a browser User-Agent. '
                        'If it persists, your network/IP may be blocked by kie\'s Cloudflare.'
                    ),
                    'data': None,
                })
                return
            # Non-JSON Cloudflare / gateway bodies → wrap so the browser always gets JSON
            ctype = (e.headers.get('Content-Type') or '') if e.headers else ''
            if 'json' not in ctype.lower():
                preview = err_body.decode('utf-8', errors='replace')[:240].strip()
                self._json_response(e.code, {
                    'code': e.code,
                    'msg': preview or f'Upstream HTTP {e.code}',
                    'data': None,
                })
                return
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(err_body)
        except Exception as e:
            self._json_response(502, {'error': {'message': f'Proxy error: {e}'}})

    def _json_response(self, code, obj):
        payload = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        print(f"[Mirage] {self.address_string()} - {format % args}")


class MirageServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def bind_server(attempts=10, delay=0.5):
    for remaining in range(attempts - 1, -1, -1):
        try:
            return MirageServer(('127.0.0.1', PORT), MirageHandler)
        except OSError:
            if not remaining:
                raise
            time.sleep(delay)


if __name__ == '__main__':
    try:
        server = bind_server()
    except OSError:
        print(f'Port {PORT} is already in use — Mirage is probably already running.')
        print(f'Open http://localhost:{PORT}, or run "STOP MIRAGE.bat" and try again.')
        raise SystemExit(1)

    print(f'Mirage Engine running at http://localhost:{PORT}')
    print('Providers: Google AI + kie.ai (proxied)')
    print('Press Ctrl+C to stop.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
