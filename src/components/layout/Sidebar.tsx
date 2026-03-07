import { useState } from 'react';
import { Settings } from 'lucide-react';
import { ApiKeySettings } from '../settings/ApiKeySettings';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';

export function Sidebar() {
  const [showSettings, setShowSettings] = useState(false);

  return (
    <aside
      data-testid="sidebar"
      className="w-56 h-full bg-zinc-900 border-r border-zinc-800 flex flex-col"
    >
      <div className="px-4 py-4">
        <h1 className="text-lg font-semibold text-zinc-100">WhaleCode</h1>
      </div>
      <nav className="flex-1 px-2">
        {/* Navigation items added as features grow */}
      </nav>

      <Separator className="bg-zinc-800" />

      {/* Settings button at bottom */}
      <div className="px-2 py-3">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-zinc-400 hover:text-zinc-200"
          onClick={() => setShowSettings(!showSettings)}
        >
          <Settings className="size-4" />
          Settings
        </Button>
      </div>

      {/* Settings modal overlay */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl">
            <ApiKeySettings onClose={() => setShowSettings(false)} />
          </div>
        </div>
      )}
    </aside>
  );
}
