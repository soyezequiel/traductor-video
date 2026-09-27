import './ui.css';
import { api } from './shared';

const app = document.getElementById('app')!;
app.innerHTML = `<main class="shell">
  <p class="eyebrow">DOBLAJE LOCAL</p>
  <h1 class="title">Escuchá YouTube<br>en español argentino</h1>
  <p class="intro">Tu computadora transcribe, traduce y genera la voz.</p>
  <div class="status"><span id="dot" class="dot"></span><div><strong id="status">Comprobando el servicio…</strong><small id="detail"></small></div></div>
  <button id="action" class="primary" disabled>Preparando…</button>
  <label class="volume-control" for="dub-volume"><span>Volumen del doblaje</span><output id="volume-value">100%</output></label>
  <input id="dub-volume" class="volume-slider" type="range" min="0" max="100" value="100" aria-label="Volumen del doblaje">
  <p id="error" class="error-message" role="alert"></p>
  <div class="footer"><span class="muted">Videos grabados · voz del video</span><button id="options" class="link">Configuración</button></div>
</main>`;

const status = document.getElementById('status')!;
const detail = document.getElementById('detail')!;
const dot = document.getElementById('dot')!;
const action = document.getElementById('action') as HTMLButtonElement;
const error = document.getElementById('error')!;
const volumeSlider = document.getElementById('dub-volume') as HTMLInputElement;
const volumeValue = document.getElementById('volume-value')!;
let running = false;

void chrome.storage.local.get('dubVolume').then(({ dubVolume }) => {
  const value = Number.isFinite(Number(dubVolume)) ? Math.round(Number(dubVolume) * 100) : 100;
  volumeSlider.value = String(Math.max(0, Math.min(100, value)));
  volumeValue.textContent = `${volumeSlider.value}%`;
});
volumeSlider.addEventListener('input', () => {
  volumeValue.textContent = `${volumeSlider.value}%`;
  void chrome.storage.local.set({ dubVolume: Number(volumeSlider.value) / 100 });
});

function setStatus(title: string, note: string, kind: 'ok' | 'error' | 'wait' = 'wait'): void {
  status.textContent = title;
  detail.textContent = note;
  dot.className = `dot ${kind === 'wait' ? '' : kind}`;
}

async function refresh(): Promise<void> {
  error.textContent = '';
  const reply = await chrome.runtime.sendMessage({ type: 'UI_STATUS' }) as {
    paired?: boolean; session?: { state: string }; error?: string };
  if (!reply?.paired) {
    setStatus('Falta vincular la extensión', 'Ingresá el código del servicio local en Configuración.', 'error');
    action.textContent = 'Vincular servicio'; action.disabled = false;
    return;
  }
  try {
    const backend = await api<{ models: Record<string, boolean>; session?: { state: string; detail?: string } }>('/v1/status');
    if (!backend.models.translation || !backend.models.tts) {
      setStatus('Faltan modelos locales', 'Ejecutá scripts/download-models.ps1.', 'error');
      action.textContent = 'Ver configuración'; action.disabled = false;
      return;
    }
    if (backend.session?.state === 'ERROR') {
      setStatus('No se pudo doblar este video', backend.session.detail || 'Revisá el servicio local.', 'error');
      action.textContent = 'Reintentar'; action.disabled = false;
      return;
    }
    running = Boolean(reply.session && reply.session.state !== 'STOPPED' && reply.session.state !== 'ERROR');
    setStatus(running ? 'Doblaje activo' : 'Listo para doblar',
      running ? reply.session!.state : 'Abrí un video de YouTube y activalo.', 'ok');
    action.textContent = running ? 'Detener doblaje' : 'Doblar este video';
    action.disabled = false;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes('Credencial local inválida')) {
      setStatus('Volvé a vincular el servicio', 'El código de acceso guardado cambió. Ingresá el código local en Configuración.', 'error');
      action.textContent = 'Vincular servicio';
    } else {
      setStatus('Servicio desconectado', message, 'error');
      action.textContent = 'Reintentar';
    }
    action.disabled = false;
  }
}

document.getElementById('options')!.addEventListener('click', () => void chrome.runtime.openOptionsPage());
action.addEventListener('click', async () => {
  action.disabled = true;
  error.textContent = '';
  try {
    if (action.textContent === 'Vincular servicio' || action.textContent === 'Ver configuración') {
      await chrome.runtime.openOptionsPage(); return;
    }
    if (running) {
      await chrome.runtime.sendMessage({ type: 'STOP' });
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url?.startsWith('https://www.youtube.com/'))
        throw new Error('Abrí un video de YouTube en la pestaña actual.');
      const result = await chrome.runtime.sendMessage({ type: 'START', tabId: tab.id }) as { error?: string };
      if (result?.error) throw new Error(result.error);
    }
    await refresh();
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : String(cause);
    action.disabled = false;
  }
});

void refresh();
