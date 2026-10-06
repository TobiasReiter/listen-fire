import { NextRequest, NextResponse } from 'next/server';
import { isProxiedApiPath, runtimeApiTarget } from '@/lib/api-proxy';

// `/privacy`, `/terms`, `/dpa` are no longer served here — they live in the
// standalone marketing app and are redirected there via next.config redirects
// (which run before middleware), so they don't need to be public paths.
const PUBLIC_PATHS = ['/login', '/signup', '/join', '/magic', '/api/', '/subscriptions/', '/_next/', '/favicon', '/logo', '/manifest', '/.well-known/', '/oauth/', '/integrations/attio', '/listen-fire-icon-1024.png', '/attio.svg', '/listen-fire-arrows.svg', '/listen-fire-builder.skill', '/movement_parser.wasm'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // A self-host image is built without knowing its API, so the rewrites baked
  // into the route manifest are wrong there. Whenever the operator names an API
  // at run time, that name wins for every path the rewrites cover.
  const apiTarget = runtimeApiTarget();
  if (apiTarget && isProxiedApiPath(pathname)) {
    return NextResponse.rewrite(new URL(pathname + request.nextUrl.search, apiTarget));
  }

  // Exact-match the public landing — startsWith('/') would expose the whole app.
  if (pathname === '/') return NextResponse.next();

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const token = request.cookies.get('listen_fire_token');
  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logo.svg|manifest.webmanifest).*)'],
};
