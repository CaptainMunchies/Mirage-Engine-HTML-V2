#!/usr/bin/env python3
"""
Mirage Engine local server — serves static files + proxies Google / kie.ai APIs.
Fixes browser CORS for Interactions and kie Market endpoints.
"""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote
import base64
import hmac
import ipaddress
import json
import mimetypes
import secrets
import socket
import time
import urllib.error
import urllib.request

GEMINI_INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions'
KIE_API = 'https://api.kie.ai'
KIE_UPLOAD = 'https://kieai.redpandaai.co'
PORT = 8080

# Every /api/proxy/* route requires this, handed to the page over a same-origin
# request the browser will not let another site read. Without it, any website open
# in the browser could drive this proxy while Mirage is running.
SESSION_TOKEN = secrets.token_urlsafe(32)

ALLOWED_ORIGINS = frozenset({
    f'http://localhost:{PORT}',
    f'http://127.0.0.1:{PORT}',
    f'http://[::1]:{PORT}',
})

# Hosts the image proxy may fetch a generated result from. Anything else is refused
# outright, and whatever a host resolves to is checked again below — an allowlisted
# name that resolves (or redirects) to a private address is still refused.
IMAGE_HOST_SUFFIXES = (
    'kie.ai',
    'redpandaai.co',
    'redpandaai.com',
    'aiquickdraw.com',
    'googleapis.com',
    'googleusercontent.com',
    'amazonaws.com',
    'cloudfront.net',
    'r2.dev',
    'r2.cloudflarestorage.com',
    'cdn.openai.com',
    'oaidalleapiprodscus.blob.core.windows.net',
    'blob.core.windows.net',
    'fal.media',
    'replicate.delivery',
)


def _host_allowed(host):
    h = (host or '').strip().lower().rstrip('.')
    if not h:
        return False
    return any(h == suf or h.endswith('.' + suf) for suf in IMAGE_HOST_SUFFIXES)


def _resolves_to_private(host):
    """True only when the host positively resolves to an address inside this machine
    or the LAN. The backstop behind the allowlist: it catches an allowlisted name
    that points somewhere internal.

    A resolution *failure* is not treated as private — the host is already on the
    allowlist, and failing closed here would break image download on any network
    where the proxy resolves DNS rather than the client. (There is a small TOCTOU
    window against DNS rebinding, since urllib resolves again when it connects;
    closing that needs IP pinning, and the allowlist is the real control here.)
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr.split('%', 1)[0])
        except ValueError:
            continue
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified):
            return True
    return False


def _image_url_ok(url):
    """(ok, reason) for a URL the image proxy has been asked to fetch."""
    try:
        parts = urlparse(url)
    except ValueError:
        return False, 'Malformed image url'
    if parts.scheme not in ('http', 'https'):
        return False, 'Image url must be http(s)'
    host = parts.hostname
    if not host:
        return False, 'Image url has no host'
    if not _host_allowed(host):
        return False, f'Refusing to fetch from unlisted host: {host}'
    if _resolves_to_private(host):
        return False, f'Refusing to fetch from a non-public address: {host}'
    return True, ''


class GuardedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-check every hop — an allowlisted host must not be able to bounce us
    to http://127.0.0.1:22 or into the LAN."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        ok, reason = _image_url_ok(newurl)
        if not ok:
            raise urllib.error.HTTPError(newurl, 403, f'Blocked redirect: {reason}', headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_IMAGE_OPENER = urllib.request.build_opener(GuardedRedirectHandler)

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
        # Never let the browser reuse app code without checking with us first.
        #
        # Static files went out with only Last-Modified and no Cache-Control, so
        # Chrome applied heuristic freshness: a file untouched for a fortnight is
        # treated as fresh for a day or more, with no request made at all. The
        # `?v=` query on every script tag was the intended defence, but it is a
        # hand-maintained constant that had not moved since the project was
        # imported — so every edit since shipped under a cache key the browser
        # already had an answer for.
        #
        # The result is the worst kind of failure: index.html has no version query,
        # so it revalidates and the new markup appears, while the JS behind it is
        # months old. Buttons render and do nothing, and modules that were changed
        # together load as a mismatched set. Nothing errors — it just quietly is
        # not the app you edited.
        #
        # `no-cache` does not mean "do not store": the browser keeps the file and
        # revalidates it, so an unchanged file still answers 304 off local disk.
        # There is no CDN and no bandwidth to save here, and a stale module costs
        # far more than a conditional request on localhost.
        if not self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def _request_origin(self):
        return (self.headers.get('Origin') or '').strip()

    def _origin_allowed(self):
        """No Origin means same-origin or a non-browser client; otherwise it must
        be one of this server's own origins."""
        origin = self._request_origin()
        return not origin or origin in ALLOWED_ORIGINS

    def _cors_origin(self):
        """Echo the caller's origin only when we recognise it. Returning '*' here is
        what let any page on the internet read this proxy's responses."""
        origin = self._request_origin()
        return origin if origin in ALLOWED_ORIGINS else None

    def _send_cors(self):
        origin = self._cors_origin()
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')

    def _authorized(self):
        """Constant-time check of the per-run session token."""
        if not self._origin_allowed():
            return False
        supplied = (self.headers.get('X-Mirage-Session') or '').strip()
        return bool(supplied) and hmac.compare_digest(supplied, SESSION_TOKEN)

    def _require_session(self):
        if self._authorized():
            return True
        self._json_response(403, {'error': {'message': (
            'Missing or invalid Mirage session token. Reload the Mirage tab — '
            'the token is issued per server run.'
        )}})
        return False

    def _serve_session_token(self):
        """Bootstrap for the page itself. Deliberately carries no CORS header, so a
        cross-origin fetch cannot read it, and refuses a recognisably foreign Origin."""
        if not self._origin_allowed():
            self._json_response(403, {'error': {'message': 'Cross-origin request refused'}})
            return
        payload = json.dumps({'token': SESSION_TOKEN}).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        path = self.path.split('?', 1)[0]
        if path.startswith('/api/proxy/'):
            if not self._cors_origin():
                self.send_error(403, 'Cross-origin request refused')
                return
            self.send_response(204)
            self._send_cors()
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header(
                'Access-Control-Allow-Headers',
                'Content-Type, X-Mirage-Api-Key, X-Mirage-Session, Authorization'
            )
            self.end_headers()
            return
        self.send_error(501, 'Unsupported method (OPTIONS)')

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/proxy/session':
            self._serve_session_token()
            return
        if path.startswith('/api/proxy/') and not self._require_session():
            return
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
        if path.startswith('/api/proxy/') and not self._require_session():
            return
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
        # This route used to fetch *any* http(s) URL the browser named and hand the
        # body back base64'd, which made the proxy a read primitive for anything
        # reachable from this machine. Both checks matter: the allowlist keeps it to
        # result CDNs, and the address check catches an allowlisted name pointing
        # somewhere internal. Redirects are re-checked per hop by GuardedRedirectHandler.
        ok, reason = _image_url_ok(url)
        if not ok:
            self._json_response(400, {'error': {'message': reason}})
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
            with _IMAGE_OPENER.open(req, timeout=120) as resp:
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
                self._send_cors()
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
            self._send_cors()
            self.end_headers()
            self.wfile.write(err_body)
        except Exception as e:
            self._json_response(502, {'error': {'message': f'Proxy error: {e}'}})

    def _json_response(self, code, obj):
        payload = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self._send_cors()
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        print(f"[Mirage] {self.address_string()} - {format % args}")


class MirageServer(ThreadingHTTPServer):
    daemon_threads = True
    # SO_REUSEADDR. This was False, which meant a restart was refused for the whole
    # TIME_WAIT window — up to a minute after the browser had an open connection —
    # so stopping Mirage and starting it again just failed. bind_server only retries
    # for 5s, so it gave up well before the port came back.
    #
    # It bought nothing: on Linux SO_REUSEADDR does not let two processes listen on
    # the same port (that needs SO_REUSEPORT), so an already-running Mirage is still
    # detected and still reported below. All it changes is that sockets left in
    # TIME_WAIT by the previous run stop blocking the next one.
    allow_reuse_address = True


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
