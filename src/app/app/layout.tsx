import type { ReactNode } from 'react';
import { Shell } from '@/client/ui/Shell';

export default function AppLayout({ children }: { children: ReactNode }) {
  return <Shell>{children}</Shell>;
}
