'use client';

import { useAuth } from '@/lib/auth';
import { AppShell } from '@/components/app-shell';
import { ImpersonationBanner } from '@/components/impersonation-banner';
import { ToastProvider } from '@/components/portfolio';
import { ParserProvider } from '@/lib/parser-provider';

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
            <ParserProvider>{children}</ParserProvider>
          </AppShell>
        </div>
      </div>
    </ToastProvider>
  );
}
