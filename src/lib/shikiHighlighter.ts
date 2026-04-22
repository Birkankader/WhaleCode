/**
 * Lazy Shiki highlighter singleton for diff previews.
 *
 * Shiki is heavy (WASM runtime + language grammars) and only needed when
 * the user expands a file in a diff popover. We keep it out of the main
 * bundle by dynamic-importing `shiki/core`, the oniguruma engine, its WASM
 * loader, and the specific theme / language grammars on first call.
 *
 * Subsequent calls reuse the cached highlighter. Concurrent callers share
 * the in-flight load Promise so we never double-initialise the engine.
 */

import type { HighlighterCore, ThemedToken } from 'shiki';

/**
 * Minimal subset of Shiki we consume from DiffPopover — typed here so
 * downstream code doesn't depend on `@shikijs/types` directly.
 */
export type HighlighterLike = HighlighterCore;
export type TokenizedLine = ThemedToken[];

type LangLoader = () => Promise<unknown>;

/**
 * File-extension → Shiki language id. Extensions are matched case-insensitive
 * against the *last* dot segment of the path, so `Cargo.toml` → `toml` fails
 * gracefully (we fall back to plain text) and `src/main.rs` → `rust` works.
 *
 * Loaders are dynamic imports so grammars only land in the bundle the first
 * time a matching file is expanded.
 */
const LANG_LOADERS: Record<string, { id: string; loader: LangLoader }> = {
  ts: { id: 'typescript', loader: () => import('shiki/langs/typescript.mjs') },
  mts: { id: 'typescript', loader: () => import('shiki/langs/typescript.mjs') },
  cts: { id: 'typescript', loader: () => import('shiki/langs/typescript.mjs') },
  tsx: { id: 'tsx', loader: () => import('shiki/langs/tsx.mjs') },
  js: { id: 'javascript', loader: () => import('shiki/langs/javascript.mjs') },
  mjs: { id: 'javascript', loader: () => import('shiki/langs/javascript.mjs') },
  cjs: { id: 'javascript', loader: () => import('shiki/langs/javascript.mjs') },
  jsx: { id: 'jsx', loader: () => import('shiki/langs/jsx.mjs') },
  rs: { id: 'rust', loader: () => import('shiki/langs/rust.mjs') },
  css: { id: 'css', loader: () => import('shiki/langs/css.mjs') },
  html: { id: 'html', loader: () => import('shiki/langs/html.mjs') },
  htm: { id: 'html', loader: () => import('shiki/langs/html.mjs') },
  json: { id: 'json', loader: () => import('shiki/langs/json.mjs') },
  md: { id: 'markdown', loader: () => import('shiki/langs/markdown.mjs') },
  markdown: { id: 'markdown', loader: () => import('shiki/langs/markdown.mjs') },
  sh: { id: 'shellscript', loader: () => import('shiki/langs/shellscript.mjs') },
  bash: { id: 'shellscript', loader: () => import('shiki/langs/shellscript.mjs') },
  zsh: { id: 'shellscript', loader: () => import('shiki/langs/shellscript.mjs') },
  py: { id: 'python', loader: () => import('shiki/langs/python.mjs') },
};

const THEME_ID = 'dark-plus';

let cached: HighlighterCore | null = null;
let loading: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();

async function bootstrap(): Promise<HighlighterCore> {
  const [core, engineMod, wasmMod, themeMod] = await Promise.all([
    import('shiki/core'),
    import('shiki/engine/oniguruma'),
    import('shiki/wasm'),
    import('shiki/themes/dark-plus.mjs'),
  ]);
  const engine = await engineMod.createOnigurumaEngine(wasmMod.default);
  const highlighter = await core.createHighlighterCore({
    engine,
    themes: [themeMod.default],
    langs: [],
  });
  return highlighter;
}

/**
 * Resolve the shared highlighter. The first call kicks off the async
 * bootstrap (engine + theme); concurrent callers await the same promise.
 */
export async function getHighlighter(): Promise<HighlighterCore> {
  if (cached) return cached;
  if (loading) return loading;
  loading = bootstrap().then((h) => {
    cached = h;
    loading = null;
    return h;
  });
  return loading;
}

/**
 * Map a file path to a Shiki language id, or `null` if unsupported.
 * Callers must treat `null` as "render plain text, no tokenisation".
 */
export function detectLanguage(path: string): string | null {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return LANG_LOADERS[ext]?.id ?? null;
}

/**
 * Ensure the grammar for `langId` is registered on the shared highlighter.
 * Resolves to the highlighter (grammar loaded) or `null` if `langId` isn't
 * in our supported set (caller then falls back to plain-text rendering).
 */
export async function loadLanguage(langId: string): Promise<HighlighterCore | null> {
  const entry = Object.values(LANG_LOADERS).find((e) => e.id === langId);
  if (!entry) return null;
  const highlighter = await getHighlighter();
  if (!loadedLangs.has(langId)) {
    const mod = (await entry.loader()) as { default: unknown };
    await highlighter.loadLanguage(mod.default as Parameters<typeof highlighter.loadLanguage>[0]);
    loadedLangs.add(langId);
  }
  return highlighter;
}

/**
 * Tokenise `code` with the given language. Returns per-line token arrays
 * using the loaded dark-plus theme. Shiki preserves embedded newlines as
 * line breaks in its output.
 */
export function tokenizeCode(
  highlighter: HighlighterCore,
  code: string,
  langId: string,
): ThemedToken[][] {
  return highlighter.codeToTokensBase(code, {
    lang: langId,
    theme: THEME_ID,
  });
}

/** Test-only reset hook. */
export function __resetHighlighterCacheForTests(): void {
  cached = null;
  loading = null;
  loadedLangs.clear();
}
