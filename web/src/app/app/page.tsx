import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: 'Workspace | Conductor',
};

export default function WebAppPage() {
  redirect('/app/tasks');
}
