'use client';

import { useAuth } from '@/lib/auth';
import { AppShell } from '@/components/app-shell';
import { ImpersonationBanner } from '@/components/impersonation-banner';
import { ToastProvider } from '@/components/portfolio';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { isLoading } = useAuth();

  if (isLoading) {
    return null;
  }

  return (
    <ToastProvider>
      <div className="flex h-dvh flex-col">
        <ImpersonationBanner />
        <div className="flex-1 overflow-hidden">
          <AppShell>
            {children}
          </AppShell>
        </div>
      </div>
    </ToastProvider>
  );
}
