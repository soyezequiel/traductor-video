import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const extension = resolve('dist');
const profileRoot = resolve('../data');
mkdirSync(profileRoot, { recursive: true });
const profile = mkdtempSync(resolve(profileRoot, 'playwright-smoke-'));
const reports = resolve('../reports');
mkdirSync(reports, { recursive: true });
assert.ok(existsSync(resolve(extension, 'manifest.json')), 'Compilá la extensión primero');

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  let worker = context.serviceWorkers()[0];
  worker ||= await context.waitForEvent('serviceworker', { timeout: 20000 });
  const id = new URL(worker.url()).host;
  assert.match(id, /^[a-p]{32}$/);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByRole('heading', { name: /Escuchá YouTube/ }).waitFor();
  await popup.getByLabel('Volumen del doblaje').waitFor();
  await popup.screenshot({ path: resolve(reports, 'popup.png') });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.getByRole('heading', { name: 'Configurá el doblaje' }).waitFor();
  await options.getByLabel('Transcripción exacta de la muestra').waitFor();
  await options.screenshot({ path: resolve(reports, 'options.png'), fullPage: true });
  console.log(JSON.stringify({ extension_id: id, popup: 'ok', options: 'ok', screenshots: reports }));
} finally {
  await context.close();
  if (dirname(profile) !== profileRoot || !basename(profile).startsWith('playwright-smoke-'))
    throw new Error('Ruta del perfil temporal inesperada');
  rmSync(profile, { recursive: true, force: true });
}
