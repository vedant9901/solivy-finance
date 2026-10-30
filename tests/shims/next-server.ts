/**
 * Test-only stand-in for the subset of `next/server` that SOLIVY's server code uses.
 * Next.js could not be installed in the build sandbox (registry blocked), so route
 * handlers and middleware are executed against this shim. It mirrors Next's public
 * semantics for: NextResponse.json/next/redirect, response.cookies.set,
 * request.cookies.get and request.nextUrl. It is NEVER bundled into the app.
 */
type CookieOpts = { httpOnly?: boolean; sameSite?: string; secure?: boolean; path?: string; maxAge?: number; expires?: Date };

class ResponseCookies {
  constructor(private headers: Headers) {}
  set(name: string, value: string, opts: CookieOpts = {}) {
    const parts = [`${name}=${value}`];
    if (opts.path) parts.push(`Path=${opts.path}`);
    if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
    if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
    if (opts.httpOnly) parts.push('HttpOnly');
    if (opts.secure) parts.push('Secure');
    if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
    this.headers.append('set-cookie', parts.join('; '));
    return this;
  }
  delete(name: string) { return this.set(name, '', { path: '/', maxAge: 0 }); }
}

export class NextResponse extends Response {
  cookies: ResponseCookies;
  /** Request headers forwarded by NextResponse.next({ request: { headers } }) — what the route handler will see. */
  __requestHeaders?: Headers;
  __next = false;
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init);
    this.cookies = new ResponseCookies(this.headers);
  }
  static json(body: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new NextResponse(JSON.stringify(body), { ...init, headers });
  }
  static next(init: { request?: { headers?: Headers } } = {}) {
    const res = new NextResponse(null, { status: 200 });
    res.__next = true;
    if (init.request?.headers) res.__requestHeaders = new Headers(init.request.headers);
    return res;
  }
  static redirect(url: string | URL, status = 307) {
    return new NextResponse(null, { status, headers: { location: String(url) } });
  }
}

class RequestCookies {
  constructor(private headers: Headers) {}
  get(name: string) {
    const raw = this.headers.get('cookie') || '';
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() === name) return { name, value: decodeURIComponent(part.slice(i + 1).trim()) };
    }
    return undefined;
  }
}

export class NextRequest extends Request {
  nextUrl: URL;
  cookies: RequestCookies;
  constructor(input: string | URL | Request, init?: RequestInit) {
    super(input as any, init);
    this.nextUrl = new URL(this.url);
    this.cookies = new RequestCookies(this.headers);
  }
}
