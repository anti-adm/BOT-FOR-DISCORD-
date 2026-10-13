const $ = id => document.getElementById(id);
const bars = document.querySelector('.bars');
for (let i = 0; i < 31; i++) { const bar = document.createElement('i'); bar.style.setProperty('--h', `${8 + 33 * Math.sin(i * 1.7) ** 2 * Math.sin((i + 1) / 32 * Math.PI)}px`); bars.append(bar); }
let current, muted = false;
function setStatus(title, message, badge) { $('headline').textContent = title; $('status').textContent = message; $('badge').textContent = badge; }
function volume() { const value = muted ? 0 : Number($('volume').value) / 100; if (current) current.gain.gain.value = value; $('volume-value').textContent = `${Math.round(value * 100)}%`; $('mute').textContent = muted ? '×' : '◖))'; $('mute').setAttribute('aria-label', muted ? 'Включить звук' : 'Выключить звук'); }
$('volume').addEventListener('input', () => { muted = false; volume(); });
$('mute').addEventListener('click', () => { muted = !muted; volume(); });
$('show-key').addEventListener('click', () => { const show = $('key').type === 'password'; $('key').type = show ? 'text' : 'password'; $('show-key').textContent = show ? 'Скрыть' : 'Показать'; });
async function stop(message = 'Нажмите «Слушать войс», чтобы подключиться снова.') {
  const state = current; current = null;
  if (state) { state.abort.abort(); clearInterval(state.clock); await state.context.close().catch(() => {}); }
  $('connect-form').hidden = false; $('disconnect').hidden = true; $('connect').disabled = false; $('dot').classList.remove('on'); $('footer-status').textContent = 'Звук выключен';
  $('clock').textContent = '00:00'; $('caption').textContent = 'Маленькое место для ваших голосов';
  setStatus('Подключимся?', message, 'Не подключено');
}
$('disconnect').addEventListener('click', () => stop());
$('connect-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (current) return;
  let endpoint;
  try { endpoint = new URL($('endpoint').value); if (endpoint.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(endpoint.hostname)) throw new Error(); }
  catch { setStatus('Проверьте адрес', 'Нужен защищённый адрес аудиосервера.', 'Нет подключения'); return; }
  const key = $('key').value.trim();
  if (!key) return;
  const context = new AudioContext({ sampleRate: 16000 });
  const gain = context.createGain(); gain.connect(context.destination);
  const state = { context, gain, abort: new AbortController(), after: 0, next: 0, key, endpoint: endpoint.origin, started: Date.now() };
  current = state; volume(); $('connect').disabled = true;
  setStatus('Подключаемся…', 'Проверяем доступ к вашей комнате.', 'Подключение');
  const request = async path => {
    const response = await fetch(`${state.endpoint}${path}`, { headers: { Authorization: `Bearer ${state.key}` }, cache: 'no-store', signal: AbortSignal.any([state.abort.signal, AbortSignal.timeout(12000)]) });
    if (response.status === 401) throw new Error('Неверный ключ доступа.');
    if (response.status === 403) throw new Error('Этот адрес панели ещё не разрешён на сервере.');
    if (!response.ok) throw new Error(response.status === 429 ? 'Слишком много запросов. Попробуйте через минуту.' : 'Аудиосервер временно недоступен.');
    return response;
  };
  try {
    await context.resume();
    await request('/api/status');
    if (current !== state) return;
    $('connect-form').hidden = true; $('disconnect').hidden = false; $('dot').classList.add('on'); $('footer-status').textContent = 'Подключено';
    $('caption').textContent = 'Прямой звук · задержка несколько секунд';
    state.clock = setInterval(() => { const seconds = Math.floor((Date.now() - state.started) / 1000); $('clock').textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`; }, 1000);
    while (current === state) {
      const response = await request(`/api/live?after=${state.after}`);
      if (current !== state) break;
      if (response.status !== 204) {
        const bytes = await response.arrayBuffer();
        if (current !== state) break;
        const end = Number(response.headers.get('X-Audio-End'));
        const rate = Number(response.headers.get('X-Audio-Rate'));
        if (rate !== 16000 || !Number.isFinite(end) || bytes.byteLength !== 64000) throw new Error('Сервер прислал некорректный аудиофрагмент.');
        const view = new DataView(bytes), buffer = context.createBuffer(1, bytes.byteLength / 2, rate), samples = buffer.getChannelData(0);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
        const source = context.createBufferSource(); source.buffer = buffer; source.connect(gain);
        if (state.after && end - state.after > 2000) state.next = 0;
        if (state.next < context.currentTime || state.next > context.currentTime + 5) state.next = context.currentTime + 0.65;
        source.start(state.next); state.next += buffer.duration; state.after = end;
        const speaking = response.headers.get('X-Audio-Voice') === '1';
        setStatus(speaking ? 'Вы на связи' : 'Сейчас тихо', speaking ? 'Слышно всё, что попадает в аудиобуфер бота.' : 'Ждём голос. Бот должен находиться в войсе.', 'Подключено');
      }
      await new Promise(resolve => setTimeout(resolve, 450));
    }
  } catch (error) {
    if (current === state) await stop(error.name === 'TypeError' ? 'Нет связи с аудиосервером. Проверьте адрес и интернет.' : error.message || 'Соединение прервано.');
  }
});
window.addEventListener('pagehide', () => { if (current) { current.abort.abort(); current.context.close(); } });
