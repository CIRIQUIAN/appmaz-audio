import {parseRemote, beforeStop, apiURL, extractAnswer, confirmDelivery} from './core.mjs';

const $ = id => document.getElementById(id);
const STORAGE = 'appmaz_audio_touch_v1';
const PENDING_STORAGE = 'appmaz_pending_touch_v1';
let config, session = null, editing = null, holdTimer = null, logLines = [];
let startHold = null;
let pending = null, sendingPending = false;
const read = key => localStorage.getItem(key);
function save() { localStorage.setItem(STORAGE, JSON.stringify(config)); }
function status(message) {
  $('status').textContent = message;
  logLines.push(new Date().toLocaleTimeString() + ' · ' + message);
  logLines = logLines.slice(-30);
  $('log').textContent = logLines.join('\n');
}
function errorText(error) {
  if (error.name === 'NotAllowedError') return 'No hay permiso de micrófono. Actívalo en los ajustes del navegador y vuelve a elegir la lista.';
  if (error.name === 'NotFoundError') return 'No se encuentra un micrófono disponible.';
  if (error.name === 'AbortError') return 'La petición se canceló o superó el tiempo de espera.';
  if (error instanceof TypeError) return 'No se pudo conectar. Comprueba Internet y que appmaz.vip permite el acceso desde esta web (CORS).';
  return error.message || 'Error inesperado.';
}
function showPending() {
  $('pendingPanel').hidden = !pending;
  $('pendingText').textContent = pending?.answer || '';
  $('pendingInfo').textContent = pending ? `Usuario ${pending.user}. La respuesta se conserva hasta confirmar su envío.` : '';
  $('retrySend').disabled = sendingPending;
  $('discardPending').disabled = sendingPending;
}
function keepPending(value) {
  // Retain the in-memory copy even if the browser runs out of storage.
  pending = value;
  if (value) localStorage.setItem(PENDING_STORAGE, JSON.stringify(value));
  else localStorage.removeItem(PENDING_STORAGE);
  showPending();
}
function saveSettings() {
  config.user = $('userCode').value.trim();
  config.key = $('apiKey').value.trim();
  config.stop = $('stopPhrase').value.trim();
  config.delay = $('delay').value;
  config.model = $('languageModel').value;
  save();
}
function renderLists() {
  $('lists').replaceChildren();
  if (!config.lists.length) {
    const p = document.createElement('p'); p.className = 'hint';
    p.textContent = 'Crea tu primera lista con un nombre y un prompt.'; $('lists').append(p);
  }
  for (const list of config.lists) {
    const card = document.createElement('article'); card.className = 'list-card';
    const title = document.createElement('h3'); title.textContent = list.name;
    const prompt = document.createElement('p'); prompt.textContent = list.prompt;
    const actions = document.createElement('div'); actions.className = 'actions';
    for (const [label, action, secondary] of [
      ['Usar lista', () => enter(list), false],
      ['Editar', () => edit(list), true],
      ['Eliminar', () => {
        if (!confirm(`¿Eliminar la lista «${list.name}»?`)) return;
        config.lists = config.lists.filter(l => l.id !== list.id);
        try { save(); renderLists(); } catch (e) { status(errorText(e)); }
      }, true]
    ]) {
      const button = document.createElement('button'); button.textContent = label;
      if (secondary) button.className = 'secondary';
      button.disabled = !!session || sendingPending;
      button.addEventListener('click', action); actions.append(button);
    }
    card.append(title, prompt, actions); $('lists').append(card);
  }
}
function edit(list) {
  editing = list?.id || null; $('editor').hidden = false;
  $('editorTitle').textContent = list ? 'Editar lista' : 'Nueva lista';
  $('listName').value = list?.name || ''; $('listPrompt').value = list?.prompt || '';
  $('listName').focus();
}
function current(s) { return session === s && !s.controller.signal.aborted; }
function mute(s) { s.stream?.getAudioTracks().forEach(track => { track.enabled = false; }); }
function closeRTC(s) {
  $('listeningLabel').hidden = true;
  mute(s); clearTimeout(s.connectTimer);
  const pc = s.pc, dc = s.dc; s.pc = null; s.dc = null;
  if (dc) { dc.onmessage = dc.onclose = dc.onerror = null; dc.close(); }
  if (pc) { pc.onconnectionstatechange = null; pc.close(); }
}
function fail(s, error) {
  if (!current(s)) return;
  s.state = 'error'; cancelStartHold(); closeRTC(s);
  $('screenMessage').textContent = errorText(error) + ' Mantén Volver 2 segundos para revisar.';
  status(errorText(error) + ' Mantén Volver 2 segundos para revisar.');
}
async function request(url, options = {}, s = null, timeout = 20000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeout);
  if (s?.controller.signal.aborted) controller.abort();
  s?.controller.signal.addEventListener('abort', abort, {once: true});
  try {
    const response = await fetch(url, {...options, signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'});
    const text = await response.text();
    if (!response.ok) {
      let detail = '';
      try { detail = JSON.parse(text).error?.message || ''; } catch { /* Do not display server HTML. */ }
      throw new Error(`Petición rechazada (HTTP ${response.status}). ${detail}`);
    }
    return text;
  } finally {
    clearTimeout(timer); s?.controller.signal.removeEventListener('abort', abort);
  }
}
async function wake(s) {
  if (!current(s) || document.visibilityState !== 'visible' || !navigator.wakeLock || s.wake) return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!current(s)) { await lock.release(); return; }
    s.wake = lock; lock.addEventListener('release', () => { if (s.wake === lock) s.wake = null; });
  } catch { /* The OS may refuse the wake lock. */ }
}
async function enter(list) {
  if (session || sendingPending) return;
  let s;
  try {
    saveSettings();
    if (!/^[A-Za-z]{3}$/.test(config.user)) throw new Error('Introduce un código de usuario de tres letras.');
    if (!config.key) throw new Error('Introduce tu API key de OpenAI.');
    if (!config.stop.match(/[\p{L}\p{N}]/u)) throw new Error('Introduce una frase de detención.');
    if (!list.prompt.trim()) throw new Error('Esta lista necesita un prompt.');
    if (pending) throw new Error('Envía o descarta primero la respuesta pendiente.');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Abre la app por HTTPS para usar el micrófono.');
    if (!['gpt-5-nano', 'gpt-4.1-mini'].includes(config.model)) throw new Error('Selecciona un modelo de lenguaje válido.');
    s = {user: config.user, key: config.key, stop: config.stop, delay: config.delay, model:config.model,
      list: {...list}, state: 'permission', controller: new AbortController(),
      items: new Map()};
    session = s; renderLists();
    $('editor').hidden = true; $('settings').hidden = true; $('settings').inert = true;
    $('blackScreen').hidden = false; document.body.classList.add('active-session');
    $('blackResult').textContent = ''; $('blackResult').hidden = true;
    $('listeningLabel').hidden = true;
    $('screenMessage').textContent = 'Preparando micrófono…';
    history.pushState({appmazSession:true}, ''); s.history = true;
    $('startSurface').focus();
    status('Preparando permiso de micrófono…');
    // Acquire from the list click; retain a disabled track between cycles.
    const stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation:true, noiseSuppression:true, autoGainControl:true}});
    stream.getTracks().forEach(t => { t.enabled = false; });
    if (!current(s)) { stream.getTracks().forEach(t => t.stop()); return; }
    s.stream = stream;
    stream.getAudioTracks().forEach(t => t.addEventListener('ended', () => fail(s, new Error('El micrófono se ha desconectado. Vuelve a elegir la lista.'))));
    s.state = 'waiting'; $('screenMessage').textContent = '';
    status('Mantén la pantalla negra pulsada 1 segundo para escuchar · ' + list.name);
    void wake(s);
  } catch (error) {
    if (s && current(s)) exitSession();
    status(errorText(error));
  }
}
async function startAudio(s) {
  if (!current(s) || s.state !== 'waiting') return;
  s.state = 'connecting'; s.items.clear();
  $('blackResult').textContent = ''; $('blackResult').hidden = true;
  $('screenMessage').textContent = 'Conectando…';
  $('transcript').textContent = ''; $('response').textContent = '';
  if (!s.stream.getAudioTracks().some(t => t.readyState === 'live')) throw new Error('El micrófono ya no está disponible. Vuelve a elegir la lista.');
  status('Pulsación recibida. Conectando audio…');
  const pc = new RTCPeerConnection(); s.pc = pc;
  s.stream.getTracks().forEach(t => pc.addTrack(t, s.stream));
  const dc = pc.createDataChannel('oai-events'); s.dc = dc;
  s.connectTimer = setTimeout(() => fail(s, new Error('La conexión de audio no se ha abierto.')), 30000);
  dc.onopen = () => {
    if (!current(s) || s.state !== 'connecting') return;
    clearTimeout(s.connectTimer); s.state = 'listening';
    s.stream.getAudioTracks().forEach(t => { t.enabled = true; });
    $('listeningLabel').hidden = false;
    $('screenMessage').textContent = '';
    status('Escuchando · ' + s.list.name);
  };
  dc.onmessage = event => {
    if (!current(s) || s.state !== 'listening') return;
    let data; try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'error' || data.type === 'conversation.item.input_audio_transcription.failed') {
      fail(s, new Error(data.error?.message || 'Error de transcripción.')); return;
    }
    const delta = data.type === 'conversation.item.input_audio_transcription.delta';
    const completed = data.type === 'conversation.item.input_audio_transcription.completed';
    if (!delta && !completed) return;
    const id = (data.item_id || 'stream') + ':' + (data.content_index || 0);
    const item = s.items.get(id) || {text:'', complete:false};
    if (completed) { item.text = data.transcript || ''; item.complete = true; }
    else if (!item.complete) item.text += data.delta || '';
    s.items.set(id, item);
    const transcript = [...s.items.values()].map(i => i.text).join(' ');
    $('transcript').textContent = transcript;
    const content = beforeStop(transcript, s.stop);
    if (content !== null) void finish(s, content);
  };
  dc.onerror = () => fail(s, new Error('Error del canal de audio.'));
  dc.onclose = () => { if (['connecting','listening'].includes(s.state)) fail(s, new Error('Se ha cerrado la conexión de audio.')); };
  pc.onconnectionstatechange = () => {
    if (['failed','disconnected'].includes(pc.connectionState)) fail(s, new Error('Se ha interrumpido la conexión del micrófono.'));
  };
  const offer = await pc.createOffer();
  if (!current(s) || s.state !== 'connecting') return;
  await pc.setLocalDescription(offer);
  const form = new FormData(); form.append('sdp', offer.sdp);
  form.append('session', JSON.stringify({type:'transcription',audio:{input:{turn_detection:null,transcription:{model:'gpt-realtime-whisper',language:'es',delay:s.delay}}}}));
  const answer = await request('https://api.openai.com/v1/realtime/calls', {method:'POST',headers:{Authorization:'Bearer ' + s.key},body:form}, s);
  if (!current(s) || s.state !== 'connecting') return;
  await pc.setRemoteDescription({type:'answer',sdp:answer});
}
async function finish(s, transcript) {
  if (!current(s) || s.state !== 'listening') return;
  s.state = 'processing'; closeRTC(s);
  $('screenMessage').textContent = 'Procesando…';
  try {
    if (!transcript.trim()) throw new Error('No hay contenido antes de la frase de detención.');
    const modelStart = Date.now();
    status('Analizando con ' + s.model + ' y el prompt de ' + s.list.name + '…');
    const raw = await request('https://api.openai.com/v1/responses', {
      method:'POST', headers:{Authorization:'Bearer ' + s.key,'Content-Type':'application/json'},
      body:JSON.stringify({model:s.model,...(s.model === 'gpt-5-nano' ? {reasoning:{effort:'minimal'}} : {}),input:[
        {role:'system',content:[{type:'input_text',text:s.list.prompt}]},
        {role:'user',content:[{type:'input_text',text:'TRANSCRIPCIÓN:\n\n' + transcript}]}
      ]})
    }, s, 120000);
    if (!current(s)) return;
    const answer = extractAnswer(JSON.parse(raw)); $('response').textContent = answer;
    status('Respuesta del modelo en ' + ((Date.now() - modelStart) / 1000).toFixed(1) + ' s.');
    // Display independently of Appmaz availability; never interpret model text as HTML.
    $('blackResult').textContent = answer; $('blackResult').hidden = false;
    $('blackResult').scrollTop = 0;
    $('screenMessage').textContent = 'Enviando resultado…';
    keepPending({user:s.user, answer, createdAt:new Date().toISOString()});
    s.state = 'sending'; status('Enviando la respuesta final…');
    await deliver(pending, s);
    if (!current(s)) return;
    keepPending(null);
    s.state = 'waiting'; $('screenMessage').textContent = '';
    status('Respuesta enviada. Mantén la pantalla pulsada 1 segundo para otra escucha.');
  } catch (error) { fail(s, error); }
}
async function deliver(item, s = null) {
  const started = Date.now();
  await confirmDelivery(item.answer, {
    signal:s?.controller.signal,
    write:signal => request(apiURL('/api/storedata.php', item.user, item.answer), {method:'GET'}, {controller:{signal}}, 10000),
    read:async signal => parseRemote(await request(apiURL('/api/getdata.php', item.user), {}, {controller:{signal}}, 10000)),
    onAttempt:number => {
      if (s && current(s)) $('screenMessage').textContent = number === 1 ? 'Enviando resultado…' : 'Comprobando envío · intento ' + number;
    }
  });
  status('Resultado guardado y comprobado en ' + ((Date.now() - started) / 1000).toFixed(1) + ' s.');
}
function cancelHold() { clearTimeout(holdTimer); holdTimer = null; $('backBtn').classList.remove('holding'); }
function beginHold() {
  if (!session || holdTimer) return;
  cancelStartHold();
  $('backBtn').classList.add('holding');
  holdTimer = setTimeout(exitSession, 2000);
}
function exitSession() {
  const s = session; if (!s) return;
  session = null; cancelHold(); cancelStartHold(); s.controller.abort(); closeRTC(s);
  s.stream?.getTracks().forEach(t => t.stop()); s.wake?.release().catch(() => {});
  $('blackScreen').hidden = true; $('settings').hidden = false; $('settings').inert = false;
  document.body.classList.remove('active-session');
  if (s.history && history.state?.appmazSession) history.back();
  status(pending ? 'Sesión cerrada. Hay una respuesta pendiente de confirmar.' : 'Sesión cerrada. Micrófono apagado.');
  renderLists(); showPending(); $('newList').focus();
}

try {
  config = JSON.parse(read(STORAGE) || read('appmaz_audio_v1') || 'null') || {
    user:'', key:read('openai_api_key') || '', stop:read('stop_phrase') || 'parar transcripción', delay:'low',
    lists:read('audio_prompt') ? [{id:crypto.randomUUID(),name:'Mi primera lista',prompt:read('audio_prompt')}] : []
  };
  if (!Array.isArray(config.lists)) throw new Error('Las listas guardadas no tienen un formato válido.');
  if (!['gpt-5-nano', 'gpt-4.1-mini'].includes(config.model)) config.model = 'gpt-5-nano';
  pending = JSON.parse(read(PENDING_STORAGE) || 'null');
  for (const [id,key] of [['userCode','user'],['apiKey','key'],['stopPhrase','stop'],['delay','delay'],['languageModel','model']]) {
    $(id).value = config[key] || '';
    $(id).addEventListener('input', () => { try { saveSettings(); } catch { status('No se puede guardar en este navegador. Comprueba su almacenamiento.'); } });
  }
  renderLists(); showPending();
} catch (e) { status('No se pudo leer el almacenamiento local: ' + errorText(e)); }
$('newList').addEventListener('click', () => edit(null));
$('cancelEdit').addEventListener('click', () => { $('editor').hidden = true; });
$('editor').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('listName').value.trim(), prompt = $('listPrompt').value.trim();
  if (!name || !prompt) return;
  const value = {id:editing || crypto.randomUUID(),name,prompt};
  const index = config.lists.findIndex(l => l.id === editing);
  if (index >= 0) config.lists[index] = value; else config.lists.push(value);
  try { save(); $('editor').hidden = true; renderLists(); status('Lista guardada.'); } catch (e) { status(errorText(e)); }
});
$('backBtn').addEventListener('pointerdown', e => {
  e.stopPropagation(); cancelStartHold();
  if (!e.isPrimary || e.button !== 0) return;
  e.preventDefault(); $('backBtn').setPointerCapture(e.pointerId); beginHold();
});
for (const type of ['pointerup','pointercancel','lostpointercapture']) $('backBtn').addEventListener(type, cancelHold);
$('backBtn').addEventListener('pointermove', e => {
  const r = $('backBtn').getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) cancelHold();
});
$('backBtn').addEventListener('contextmenu', e => e.preventDefault());
$('backBtn').addEventListener('keydown', e => { if ([' ','Enter'].includes(e.key)) { e.preventDefault(); if (!e.repeat) beginHold(); } });
$('backBtn').addEventListener('keyup', cancelHold);
$('backBtn').addEventListener('blur', cancelHold);
window.addEventListener('blur', () => { cancelHold(); cancelStartHold(); });
window.addEventListener('popstate', () => { if (session?.history) history.pushState({appmazSession:true}, ''); });
window.addEventListener('pagehide', () => { if (session) { session.history = false; exitSession(); } });
document.addEventListener('visibilitychange', () => {
  cancelHold(); cancelStartHold();
  if (!session) return;
  if (document.visibilityState === 'visible') void wake(session);
  else if (['listening','connecting'].includes(session.state)) fail(session, new Error('La app dejó de estar en primer plano. Vuelve a elegir la lista.'));
});
$('retrySend').addEventListener('click', async () => {
  if (!pending || sendingPending || session) return;
  sendingPending = true; showPending(); renderLists();
  try {
    await deliver(pending); keepPending(null);
    status('Respuesta enviada y comprobada. Ya puedes elegir una lista.');
  } catch (error) { status(errorText(error)); }
  finally { sendingPending = false; showPending(); renderLists(); }
});
$('discardPending').addEventListener('click', () => {
  if (!sendingPending && confirm('¿Descartar la respuesta pendiente sin enviarla?')) {
    try { keepPending(null); status('Respuesta descartada. Ya puedes elegir una lista.'); } catch(e) { status(errorText(e)); }
  }
});
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => status('No se pudo preparar la instalación sin conexión. La app puede seguir funcionando con Internet.'));

function cancelStartHold() {
  if (startHold) clearTimeout(startHold.timer);
  startHold = null;
}
function beginStartHold(pointerId = null, x = 0, y = 0) {
  const s = session;
  if (!s || s.state !== 'waiting' || holdTimer || startHold || document.visibilityState !== 'visible') return;
  const gesture = {pointerId, x, y, timer:null};
  startHold = gesture;
  gesture.timer = setTimeout(() => {
    if (startHold !== gesture) return;
    cancelStartHold();
    if (!current(s) || s.state !== 'waiting' || document.visibilityState !== 'visible') return;
    void startAudio(s).catch(error => fail(s, error));
  }, 1000);
}
$('blackScreen').addEventListener('pointerdown', e => {
  if (e.target.closest('#backBtn')) return;
  if (!e.isPrimary) { cancelStartHold(); return; }
  if (e.button !== 0) return;
  // Keep result scrolling native. Moving a finger cancels the listening gesture.
  beginStartHold(e.pointerId, e.clientX, e.clientY);
});
window.addEventListener('pointermove', e => {
  if (startHold?.pointerId !== e.pointerId) return;
  if (Math.hypot(e.clientX - startHold.x, e.clientY - startHold.y) > 12) cancelStartHold();
});
for (const type of ['pointerup','pointercancel','lostpointercapture']) window.addEventListener(type, e => {
  if (startHold?.pointerId === e.pointerId) cancelStartHold();
});
$('blackScreen').addEventListener('contextmenu', e => e.preventDefault());
$('startSurface').addEventListener('keydown', e => {
  if ([' ','Enter'].includes(e.key)) { e.preventDefault(); if (!e.repeat) beginStartHold(); }
});
$('startSurface').addEventListener('keyup', cancelStartHold);
$('startSurface').addEventListener('blur', cancelStartHold);
