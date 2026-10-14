// In-process fake of the GitHub REST API, limited to the calls js/sync.js makes.
// Where sync.js depends on real GitHub behaviour, this mock follows it:
//  - blob shas are git blob ids: sha1("blob <byteLength>\0" + bytes)
//  - PUT/DELETE on contents need the current file sha (422 if missing, 409 if stale)
//  - a repo without commits answers the tree request with 409 "Git Repository is empty."
//  - tree responses carry an ETag and answer If-None-Match with 304
//  - base64 payloads are wrapped at 60 columns, as GitHub does
import { createHash } from 'node:crypto';

const ORIGIN = 'https://api.github.com';
const BRANCH = 'main';
const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 304: 'Not Modified', 401: 'Unauthorized', 404: 'Not Found',
  409: 'Conflict', 422: 'Unprocessable Entity', 500: 'Internal Server Error',
};

function sha1Hex(bytes) {
  return createHash('sha1').update(bytes).digest('hex');
}

/** Git blob id for a string or Buffer. Identical bytes give identical ids. */
export function gitBlobSha(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return sha1Hex(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
}

function wrapBase64(bytes) {
  return bytes.toString('base64').replace(/.{1,60}/g, (line) => line + '\n');
}

function response(status, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: STATUS_TEXT[status] || '',
    headers: { get: (name) => (h.has(String(name).toLowerCase()) ? h.get(String(name).toLowerCase()) : null) },
    text: async () => text,
  };
}

const err = (status, message) => response(status, { message });
const notFound = () => err(404, 'Not Found');

function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const add = (k, v) => { out[String(k).toLowerCase()] = String(v); };
  if (typeof headers.forEach === 'function') headers.forEach((v, k) => add(k, v));
  else for (const [k, v] of Object.entries(headers)) add(k, v);
  return out;
}

function parseJson(text) {
  try { return JSON.parse(text || 'null'); } catch { return undefined; }
}

/**
 * Returns an object whose `fetch` can be passed to SyncEngine.
 * Test controls: offline, failNext(status, message), requestLog, files, setFile, removeFile, resetRepo.
 */
export function createMockGitHub({ token = 'test-token', repo = 'me/data' } = {}) {
  const objects = new Map();   // blob sha -> bytes. Like git's object store, old versions stay readable.
  let hasCommits = true;       // false = repo exists but has no commit yet
  let commitSeq = 0;
  let injected = null;         // one-shot error set by failNext()

  const newCommit = () => {
    hasCommits = true;
    commitSeq += 1;
    return sha1Hex(`commit ${commitSeq} ${Date.now()} ${Math.random()}`);
  };

  function writeFile(path, text) {
    const bytes = Buffer.from(text, 'utf8');
    const sha = gitBlobSha(bytes);
    objects.set(sha, bytes);
    api.files.set(path, { content: text, sha });
    return { sha, commitSha: newCommit() };
  }

  function getTree(branch, headers) {
    if (branch !== BRANCH) return notFound();
    if (!hasCommits) return err(409, 'Git Repository is empty.');
    const entries = [...api.files.keys()].sort().map((path) => {
      const f = api.files.get(path);
      return { path, mode: '100644', type: 'blob', sha: f.sha, size: Buffer.byteLength(f.content, 'utf8') };
    });
    const sha = sha1Hex(JSON.stringify(entries.map((e) => [e.path, e.sha])));
    const etag = `"${sha}"`;
    if (headers['if-none-match'] === etag) return response(304, undefined, { ETag: etag });
    return response(200, { sha, tree: entries, truncated: false }, { ETag: etag });
  }

  function getBlob(sha) {
    const bytes = objects.get(sha);
    if (!bytes) return notFound();
    return response(200, { sha, size: bytes.length, encoding: 'base64', content: wrapBase64(bytes) });
  }

  function getContent(path, url) {
    const ref = url.searchParams.get('ref');
    if (ref && ref !== BRANCH) return notFound();
    const f = api.files.get(path);
    if (!f) return notFound();
    const bytes = Buffer.from(f.content, 'utf8');
    return response(200, {
      type: 'file', name: path.split('/').pop(), path, sha: f.sha, size: bytes.length,
      encoding: 'base64', content: wrapBase64(bytes),
    });
  }

  function putContent(path, body) {
    if (!body || typeof body !== 'object') return err(400, 'Problems parsing JSON');
    if (typeof body.content !== 'string') return err(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
    if (body.branch && body.branch !== BRANCH) return err(404, 'Branch not found');
    const cur = api.files.get(path);
    const sha = body.sha || undefined;
    if (cur && !sha) return err(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if ((cur ? cur.sha : undefined) !== sha) return err(409, `"sha" does not match the current version of ${path}`);
    const text = Buffer.from(body.content, 'base64').toString('utf8');
    const written = writeFile(path, text);
    return response(cur ? 200 : 201, {
      content: { sha: written.sha, path, name: path.split('/').pop(), size: Buffer.byteLength(text, 'utf8') },
      commit: { sha: written.commitSha, message: body.message },
    });
  }

  function deleteContent(path, body) {
    const cur = api.files.get(path);
    if (!cur) return notFound();
    const sha = (body && body.sha) || undefined;
    if (!sha) return err(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (sha !== cur.sha) return err(409, `"sha" does not match the current version of ${path}`);
    api.files.delete(path);
    return response(200, { content: null, commit: { sha: newCommit(), message: body.message } });
  }

  function route(method, url, headers, bodyText) {
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m || `${m[1]}/${m[2]}`.toLowerCase() !== api.repo.toLowerCase()) return notFound();
    const rest = m[3] || '';

    if (rest === '') {
      if (method !== 'GET') return notFound();
      return response(200, {
        full_name: api.repo, default_branch: BRANCH, private: true,
        permissions: { admin: false, push: true, pull: true },
      });
    }

    let t = /^\/git\/trees\/([^/]+)$/.exec(rest);
    if (method === 'GET' && t) return getTree(decodeURIComponent(t[1]), headers);

    t = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
    if (method === 'GET' && t) return getBlob(t[1]);

    t = /^\/contents\/(.+)$/.exec(rest);
    if (t) {
      const path = decodeURIComponent(t[1]);
      if (method === 'GET') return getContent(path, url);
      if (method === 'PUT') return putContent(path, parseJson(bodyText));
      if (method === 'DELETE') return deleteContent(path, parseJson(bodyText));
    }
    return notFound();
  }

  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    const method = String(init.method || 'GET').toUpperCase();
    // Logged even when the request then fails, so tests can see that an attempt was made.
    api.requestLog.push(`${method} ${url.pathname}${url.search}`);
    if (api.offline) throw new TypeError('fetch failed');
    if (url.origin !== ORIGIN) throw new TypeError(`unexpected host ${url.host}`);
    if (injected) {
      const f = injected;
      injected = null;
      return err(f.status, f.message);
    }
    const headers = normalizeHeaders(init.headers);
    if (headers.authorization !== `Bearer ${api.token}`) return err(401, 'Bad credentials');
    return route(method, url, headers, typeof init.body === 'string' ? init.body : '');
  }

  const api = {
    token,
    repo,
    offline: false,
    requestLog: [],          // 'METHOD /path?query' per request
    files: new Map(),        // 'notes/<id>.json' -> { content: string, sha: string }
    fetch: fetchImpl,
    /** The next request (any endpoint) fails with this HTTP status and message. */
    failNext(status, message = '') { injected = { status, message }; },
    /** Writes a remote file as if another client committed it. */
    setFile(path, text) { return writeFile(path, text).sha; },
    removeFile(path) { return api.files.delete(path); },
    /** Empties the repo and drops its commit history: the next tree request answers 409 "empty". */
    resetRepo() { api.files.clear(); hasCommits = false; },
  };
  return api;
}
