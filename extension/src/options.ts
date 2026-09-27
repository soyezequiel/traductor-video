import './ui.css';
import { api, BASE } from './shared';

const app = document.getElementById('app')!;
app.innerHTML = `<main class="options">
  <p class="eyebrow">DOBLAJE LOCAL · CONFIGURACIÓN</p>
  <h1>Configurá el doblaje</h1>
  <p>El doblaje toma la voz original de cada frase del video. Si cambian los hablantes entre frases, cambia también la voz generada.</p>
  <section><h2>1. Vincular servicio</h2><p>Ejecutá <code>scripts/start.ps1</code> y buscá el código de seis dígitos que aparece en la consola o en <code>data/pairing.json</code>.</p>
    <label class="field"><span>Código local</span><input id="code" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="off"></label>
    <button id="pair" class="secondary">Vincular</button><p id="pair-result" class="output" role="status"></p></section>
  <section><h2>2. Voz opcional</h2><p id="available-voice" role="status">Comprobando voces guardadas…</p><p>La voz del video se usa automáticamente. Tu muestra sirve de respaldo si el comienzo no tiene una voz utilizable: grabá entre 15 y 30 segundos de habla limpia, sin música. Un archivo WAV mono o estéreo sirve.</p>
    <label class="field"><span>Nombre de la voz</span><input id="name" value="Voz argentina"></label>
    <label class="field"><span>Archivo WAV</span><input id="file" type="file" accept=".wav,audio/wav"></label>
    <label class="field"><span>Transcripción exacta de la muestra</span><textarea id="transcript" placeholder="Escribí exactamente lo que dice la grabación…"></textarea></label>
    <button id="import" class="primary">Guardar voz</button><p id="voice-result" class="output" role="status"></p>
    <p class="hint">La grabación permanece en esta computadora. Podés reemplazarla en cualquier momento.</p></section>
</main>`;

function output(id: string, message: string, failed = false): void {
  const element = document.getElementById(id)!;
  element.textContent = message;
  element.className = failed ? 'output error' : 'output';
}

async function updateVoices(): Promise<void> {
  const status = document.getElementById('available-voice')!;
  try {
    const voices = await api<{ id: string; name: string }[]>('/v1/voices');
    status.textContent = voices.length
      ? `Voz opcional guardada: ${voices.map(voice => voice.name).join(', ')}. El doblaje usa la voz del video.`
      : 'No hay voces guardadas. El doblaje usa la voz del video; no hace falta importar nada.';
  } catch {
    status.textContent = 'Vinculá el servicio para comprobar la voz disponible.';
  }
}

document.getElementById('pair')!.addEventListener('click', async () => {
  const code = (document.getElementById('code') as HTMLInputElement).value.trim();
  if (!/^\d{6}$/.test(code)) { output('pair-result', 'Ingresá los seis dígitos.', true); return; }
  try {
    const response = await fetch(`${BASE}/v1/pair`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    if (!response.ok) throw new Error('Código incorrecto o servicio desconectado.');
    const { token } = await response.json() as { token: string };
    await chrome.storage.local.set({ token });
    output('pair-result', 'Servicio vinculado. Ya podés doblar videos.');
    await updateVoices();
  } catch (cause) { output('pair-result', String(cause), true); }
});

document.getElementById('import')!.addEventListener('click', async () => {
  const name = (document.getElementById('name') as HTMLInputElement).value.trim();
  const file = (document.getElementById('file') as HTMLInputElement).files?.[0];
  const transcript = (document.getElementById('transcript') as HTMLTextAreaElement).value.trim();
  if (!name || !file || !transcript) { output('voice-result', 'Completá nombre, archivo y transcripción.', true); return; }
  if (file.size > 15_000_000) { output('voice-result', 'El archivo supera 15 MB.', true); return; }
  output('voice-result', 'Guardando la voz…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    await api('/v1/voices', 'POST', { name, transcript, audio_base64: btoa(binary) });
    output('voice-result', 'Voz guardada. Ya podés abrir YouTube.');
    await updateVoices();
  } catch (cause) { output('voice-result', String(cause), true); }
});

void updateVoices();
