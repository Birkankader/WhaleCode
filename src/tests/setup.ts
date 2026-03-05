import { randomFillSync } from 'crypto';
import { afterEach, beforeAll } from 'vitest';

beforeAll(() => {
  // @tauri-apps/api uses window.crypto internally; polyfill for jsdom
  Object.defineProperty(window, 'crypto', {
    value: {
      getRandomValues: (buffer: Uint8Array) => {
        randomFillSync(buffer);
        return buffer;
      },
    },
  });
});

afterEach(() => {
  // clearMocks will be imported from @tauri-apps/api/mocks when available
  // For now, basic cleanup
});
