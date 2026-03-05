import { Routes, Route } from 'react-router';
import { AppShell } from '../components/layout/AppShell';
import { ProcessPanel } from '../components/terminal/ProcessPanel';

export function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <AppShell>
            <ProcessPanel />
          </AppShell>
        }
      />
    </Routes>
  );
}
