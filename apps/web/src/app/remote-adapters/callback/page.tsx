'use client';

import { useEffect, useRef } from 'react';

// The provider sends the member back here; the API completes the sign-in and
// redirects on to the remote modules settings page.
export default function RemoteAdapterCallback() {
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const url = new URL('/api/public/auth/remote_adapter/callback', window.location.origin);
    url.search = window.location.search;
    window.location.href = url.toString();
  }, []);

  return <div className="flex h-screen items-center justify-center text-sm text-gray-400">Connecting...</div>;
}
