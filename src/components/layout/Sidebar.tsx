export function Sidebar() {
  return (
    <aside
      data-testid="sidebar"
      className="w-56 h-full bg-zinc-900 border-r border-zinc-800 flex flex-col"
    >
      <div className="px-4 py-4">
        <h1 className="text-lg font-semibold text-zinc-100">WhaleCode</h1>
      </div>
      <nav className="flex-1 px-2">
        <button
          type="button"
          className="w-full text-left px-3 py-2 rounded text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
        >
          Claude Code
        </button>
      </nav>
    </aside>
  );
}
