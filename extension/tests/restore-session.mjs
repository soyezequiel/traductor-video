import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const profileRoot = resolve('../data');
const profile = mkdtempSync(resolve(profileRoot, 'playwright-restore-'));
const pairing = JSON.parse(readFileSync(resolve('../data/pairing.json'), 'utf8'));
const response = await fetch('http://127.0.0.1:8765/v1/status', {
  headers: { Authorization: `Bearer ${pairing.token}` },
});
assert.equal(response.ok, true, 'El servicio local debe estar activo');
const { session } = await response.json();
assert.ok(session, 'Iniciá una sesión de doblaje antes de ejecutar esta prueba');
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`],
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.evaluate(({ token, session }) => Promise.all([
    chrome.storage.local.set({ token }),
    chrome.storage.session.set({ current: { ...session, tab_id: -1 } }),
  ]), { token: pairing.token, session });
  const state = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'UI_STATUS' }));
  assert.equal(state.session?.session_id, session.session_id);
  const audio = await popup.evaluate(() => chrome.runtime.sendMessage({
    recipient: 'offscreen', type: 'AUDIO_DIAG',
  }));
  assert.equal(audio.generation, session.generation,
    `El reproductor no recuperó la generación de la sesión: ${JSON.stringify(audio)}`);
  console.log(JSON.stringify({ restored_session: true, generation: audio.generation }));
} finally {
  await context.close();
  if (dirname(profile) !== profileRoot || !basename(profile).startsWith('playwright-restore-'))
    throw new Error('Ruta del perfil temporal inesperada');
  rmSync(profile, { recursive: true, force: true });
}
