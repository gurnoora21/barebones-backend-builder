
import { Outlet } from 'react-router-dom';
import { Suspense } from 'react';
import { DesktopNav } from './DesktopNav';
import { MobileNav } from './MobileNav';
import { useMobile } from '@/hooks/use-mobile';

export function AppLayout() {
  const isMobile = useMobile();

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {!isMobile && <DesktopNav />}
      
      <main className="flex-1 container mx-auto px-4 py-6 md:py-8 lg:py-12 mb-16 md:mb-0">
        <Suspense fallback={<div className="animate-pulse">Loading...</div>}>
          <Outlet />
        </Suspense>
      </main>
      
      {isMobile && <MobileNav />}
    </div>
  );
}
