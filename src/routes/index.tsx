import { Routes, Route } from 'react-router';
import { AppShell } from '../components/layout/AppShell';
import { OutputConsole } from '../components/terminal/OutputConsole';

export function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <AppShell>
            <OutputConsole />
          </AppShell>
        }
      />
    </Routes>
  );
}
