/*
 * Player for somewhat_empty.
 *
 * Что здесь починено относительно старой версии:
 *  - длительность больше не залипает на «0:00», если метаданные успели
 *    загрузиться до подключения скрипта (проверяем readyState/duration сразу);
 *  - перемотка не «залипает» в режиме драга: состояние сбрасывается по
 *    pointerup/pointercancel на окне, а не только на самом слайдере;
 *  - пробел не срабатывает дважды, когда фокус на кнопке (click + keydown);
 *  - музыка не стартует от любого случайного клика по странице;
 *  - меню скорости не содержит фокусируемых кнопок в aria-hidden,
 *    закрыто через hidden и управляется с клавиатуры;
 *  - есть обработка ошибки загрузки, буферизации и бесконечной длительности;
 *  - громкость/скорость/повтор сохраняются между визитами;
 *  - добавлен Media Session (управление с экрана блокировки Android).
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var audio = $('audio');
  var player = $('player');
  var playBtn = $('play-btn');
  var seek = $('seek');
  var seekFill = $('seek-fill');
  var seekBuffer = $('seek-buffer');
  var currentTimeEl = $('current-time');
  var durationEl = $('duration-time');
  var volumeSlider = $('volume');
  var volumeFill = $('volume-fill');
  var muteBtn = $('mute-btn');
  var loopBtn = $('loop-btn');
  var speedBtn = $('speed-btn');
  var speedMenu = $('speed-menu');
  var speedLabel = $('speed-label');
  var statusEl = $('player-status');
  var gate = $('enter-gate');
  var enterBtn = $('enter-btn');
  var soundHint = $('sound-hint');

  if (!audio || !player) return;

  /*
   * Режим автозапуска:
   *   'gate'  — если звук без жеста запрещён, показываем экран «click to enter»
   *             (как на zet.is-a.dev): один клик — и трек играет со звуком;
   *   'muted' — трек стартует сразу без звука (это разрешают все браузеры),
   *             а звук включается по первому клику/тапу/клавише;
   *   'off'   — ничего не делаем, ждём нажатия кнопки play.
   */
  var AUTOPLAY_MODE = 'gate';

  var SEEK_MAX = 1000;          // слайдер живёт в промилле, а не в секундах
  var STORE_KEY = 'somewhat-empty.player.v1';
  var TRACK = {
    title: 'Красавица (sped up)',
    artist: 'ЯРЧЕ СОЛНЦА',
    album: 'Somewhat_empty'
  };

  var prefs = loadPrefs();
  var pendingTime = null;       // время, которое пользователь надрагивает
  var scrubbing = false;
  var rafId = 0;
  var autoplayState = 'idle';   // idle | trying | done | muted | gate
  var gateOpen = false;
  var entered = false;
  var autoMuted = false;        // играем тихо в ожидании первого жеста
  var unlockBound = false;

  // ---------- Утилиты ----------

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  function duration() {
    var d = audio.duration;
    return (typeof d === 'number' && isFinite(d) && d > 0) ? d : 0;
  }

  function loadPrefs() {
    var defaults = { volume: 0.8, muted: false, rate: 1, loop: false };
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return defaults;
      var parsed = JSON.parse(raw) || {};
      return {
        volume: clamp(typeof parsed.volume === 'number' ? parsed.volume : defaults.volume, 0, 1),
        muted: !!parsed.muted,
        rate: clamp(typeof parsed.rate === 'number' ? parsed.rate : defaults.rate, 0.5, 2),
        loop: !!parsed.loop
      };
    } catch (err) {
      return defaults;
    }
  }

  var saveTimer = 0;
  function savePrefs() {
    // пишем не чаще раза в 400 мс и в самом конце
    if (saveTimer) return;
    saveTimer = window.setTimeout(function () {
      saveTimer = 0;
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify({
          volume: audio.volume,
          muted: audio.muted,
          rate: audio.playbackRate,
          loop: audio.loop
        }));
      } catch (err) { /* приватный режим — не страшно */ }
    }, 400);
  }

  var STATUS = {
    blocked: 'Нажмите ▶, чтобы включить звук',
    error: 'Аудио не загрузилось — нажмите ▶ для повтора',
    loading: 'Буферизация…'
  };

  function setStatus(text) {
    if (!statusEl) return;
    var next = text || '';
    if (statusEl.textContent === next) return;
    statusEl.textContent = next;
    player.classList.toggle('has-error', next === STATUS.error);
  }

  // ---------- Отрисовка ----------

  function progressTime() {
    return pendingTime !== null ? pendingTime : (audio.currentTime || 0);
  }

  function renderProgress() {
    var d = duration();
    var t = clamp(progressTime(), 0, d || progressTime());
    var ratio = d > 0 ? t / d : 0;

    seekFill.style.width = (ratio * 100).toFixed(3) + '%';
    if (!scrubbing) seek.value = String(Math.round(ratio * SEEK_MAX));

    currentTimeEl.textContent = formatTime(t);
    seek.setAttribute('aria-valuetext', formatTime(t) + ' из ' + formatTime(d));
  }

  function renderBuffer() {
    var d = duration();
    var pct = 0;
    if (d > 0 && audio.buffered && audio.buffered.length) {
      var end = audio.buffered.end(audio.buffered.length - 1);
      pct = clamp((end / d) * 100, 0, 100);
    }
    seekBuffer.style.width = pct.toFixed(2) + '%';
  }

  function renderDuration() {
    var d = duration();
    durationEl.textContent = formatTime(d);
    renderProgress();
    renderBuffer();
    updatePositionState();
  }

  function renderVolume() {
    var v = audio.muted ? 0 : audio.volume;
    volumeFill.style.width = (v * 100).toFixed(1) + '%';
    if (document.activeElement !== volumeSlider) {
      volumeSlider.value = String(Math.round(audio.volume * 100));
    }
    volumeSlider.setAttribute('aria-valuetext', Math.round(v * 100) + '%');

    var muted = audio.muted || audio.volume === 0;
    player.classList.toggle('is-muted', muted);
    muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    muteBtn.setAttribute('aria-label', muted ? 'Включить звук' : 'Выключить звук');
    muteBtn.classList.toggle('is-quiet', !muted && audio.volume > 0 && audio.volume < 0.5);
  }

  function renderPlayState() {
    var playing = !audio.paused && !audio.ended;
    player.classList.toggle('is-playing', playing);
    document.body.classList.toggle('is-audio-playing', playing);
    playBtn.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести');
    if (playing && statusEl && statusEl.textContent !== STATUS.error) setStatus('');
    updatePositionState();
  }

  function renderBuffering(isBuffering) {
    player.classList.toggle('is-buffering', !!isBuffering);
  }

  function renderRate() {
    var r = audio.playbackRate;
    speedLabel.textContent = (Math.round(r * 100) / 100) + '×';
    var items = speedMenu.querySelectorAll('button[data-speed]');
    Array.prototype.forEach.call(items, function (btn) {
      var active = parseFloat(btn.dataset.speed) === r;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }

  function renderLoop() {
    player.classList.toggle('is-looping', audio.loop);
    loopBtn.classList.toggle('is-active', audio.loop);
    loopBtn.setAttribute('aria-pressed', audio.loop ? 'true' : 'false');
    loopBtn.setAttribute('aria-label', audio.loop ? 'Повтор трека: включён' : 'Повтор трека: выключен');
  }

  // Плавная перемотка по requestAnimationFrame вместо редких timeupdate
  function tick() {
    renderProgress();
    rafId = window.requestAnimationFrame(tick);
  }

  function startTicker() {
    if (!rafId) rafId = window.requestAnimationFrame(tick);
  }

  function stopTicker() {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
    renderProgress();
  }

  // ---------- Воспроизведение ----------

  function play() {
    if (audio.error) {
      // Пробуем загрузить источник заново.
      setStatus('');
      audio.load();
    }
    var promise = audio.play();
    if (promise && typeof promise.then === 'function') {
      promise.then(function () {
        setStatus('');
      }).catch(function () {
        if (!audio.error) setStatus(STATUS.blocked);
      });
    }
  }

  function togglePlay() {
    if (audio.paused || audio.ended) play();
    else audio.pause();
  }

  function seekTo(time) {
    var d = duration();
    if (!d) return;
    try {
      audio.currentTime = clamp(time, 0, d);
    } catch (err) { /* источник ещё не готов */ }
    renderProgress();
  }

  playBtn.addEventListener('click', togglePlay);

  audio.addEventListener('play', function () { renderPlayState(); startTicker(); });
  audio.addEventListener('pause', function () { renderPlayState(); stopTicker(); });
  audio.addEventListener('ended', function () {
    renderPlayState();
    stopTicker();
    pendingTime = null;
    if (!audio.loop) seekTo(0);
  });

  audio.addEventListener('waiting', function () { renderBuffering(true); });
  audio.addEventListener('seeking', function () { renderBuffering(true); });
  audio.addEventListener('canplay', function () { renderBuffering(false); });
  audio.addEventListener('playing', function () { renderBuffering(false); setStatus(''); });

  audio.addEventListener('loadedmetadata', renderDuration);
  audio.addEventListener('durationchange', renderDuration);
  audio.addEventListener('progress', renderBuffer);
  audio.addEventListener('timeupdate', function () {
    if (!rafId) renderProgress();   // страховка, если rAF недоступен
  });
  audio.addEventListener('volumechange', function () { renderVolume(); savePrefs(); });
  audio.addEventListener('ratechange', function () { renderRate(); savePrefs(); updatePositionState(); });

  audio.addEventListener('error', function () {
    renderBuffering(false);
    stopTicker();
    setStatus(STATUS.error);
    playBtn.setAttribute('aria-label', 'Повторить загрузку');
  });

  // ---------- Перемотка ----------

  function beginScrub() {
    scrubbing = true;
    player.classList.add('is-scrubbing');
  }

  function updateScrub() {
    var d = duration();
    var ratio = clamp(parseFloat(seek.value) / SEEK_MAX, 0, 1);
    pendingTime = d > 0 ? ratio * d : 0;
    renderProgress();
  }

  function commitScrub() {
    if (pendingTime !== null) seekTo(pendingTime);
    pendingTime = null;
    scrubbing = false;
    player.classList.remove('is-scrubbing');
    renderProgress();
  }

  seek.addEventListener('pointerdown', beginScrub);
  seek.addEventListener('input', updateScrub);
  seek.addEventListener('change', commitScrub);

  // Сбрасываем драг, даже если палец/курсор ушёл за пределы слайдера.
  window.addEventListener('pointerup', function () {
    if (scrubbing) commitScrub();
  });
  window.addEventListener('pointercancel', function () {
    if (scrubbing) commitScrub();
  });
  window.addEventListener('blur', function () {
    if (scrubbing) commitScrub();
  });

  // ---------- Громкость ----------

  function setVolume(v) {
    audio.volume = clamp(v, 0, 1);
    if (audio.volume > 0 && audio.muted) audio.muted = false;
    renderVolume();
    savePrefs();
  }

  function toggleMute() {
    audio.muted = !audio.muted;
    if (!audio.muted && audio.volume === 0) audio.volume = 0.8;
    renderVolume();
    savePrefs();
  }

  volumeSlider.addEventListener('input', function () {
    setVolume(parseFloat(volumeSlider.value) / 100);
  });
  volumeSlider.addEventListener('change', function () {
    setVolume(parseFloat(volumeSlider.value) / 100);
  });

  muteBtn.addEventListener('click', toggleMute);

  loopBtn.addEventListener('click', function () {
    audio.loop = !audio.loop;
    renderLoop();
    savePrefs();
  });

  // ---------- Скорость ----------

  function setSpeed(rate) {
    audio.playbackRate = clamp(parseFloat(rate) || 1, 0.5, 4);
    renderRate();
    savePrefs();
  }

  function menuItems() {
    return Array.prototype.slice.call(speedMenu.querySelectorAll('button[data-speed]'));
  }

  function openMenu() {
    speedMenu.hidden = false;
    speedBtn.setAttribute('aria-expanded', 'true');
    player.classList.add('speed-open');
    var active = menuItems().filter(function (b) { return b.classList.contains('is-active'); })[0];
    (active || menuItems()[0]).focus();
  }

  function closeMenu(returnFocus) {
    if (speedMenu.hidden) return;
    speedMenu.hidden = true;
    speedBtn.setAttribute('aria-expanded', 'false');
    player.classList.remove('speed-open');
    if (returnFocus !== false) speedBtn.focus();
  }

  speedBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (speedMenu.hidden) openMenu();
    else closeMenu(false);
  });

  speedMenu.addEventListener('click', function (e) {
    e.stopPropagation();
    var btn = e.target.closest ? e.target.closest('button[data-speed]') : null;
    if (!btn) return;
    setSpeed(btn.dataset.speed);
    closeMenu();
  });

  speedMenu.addEventListener('keydown', function (e) {
    var items = menuItems();
    var index = items.indexOf(document.activeElement);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        items[(index + 1 + items.length) % items.length].focus();
        break;
      case 'ArrowUp':
        e.preventDefault();
        items[(index - 1 + items.length) % items.length].focus();
        break;
      case 'Home':
        e.preventDefault();
        items[0].focus();
        break;
      case 'End':
        e.preventDefault();
        items[items.length - 1].focus();
        break;
      case 'Escape':
        e.preventDefault();
        closeMenu();
        break;
      case 'Tab':
        closeMenu(false);
        break;
    }
  });

  document.addEventListener('click', function () { closeMenu(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu(false);
  });

  // ---------- Горячие клавиши ----------

  function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    // Пробел/Enter на кнопке уже сам нажимает её — не дублируем.
    if (tag === 'BUTTON' || tag === 'A') return true;
    if (typeof el.closest === 'function' && el.closest('[role="menuitemradio"]')) return true;
    return false;
  }

  document.addEventListener('keydown', function (e) {
    if (gateOpen) return;                  // заставка перехватывает клавиши
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (isTypingTarget(e.target)) return;

    switch (e.code || e.key) {
      case 'Space':
      case 'KeyK':
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowRight':
        e.preventDefault();
        seekTo(audio.currentTime + (e.shiftKey ? 10 : 5));
        break;
      case 'ArrowLeft':
        e.preventDefault();
        seekTo(audio.currentTime - (e.shiftKey ? 10 : 5));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setVolume(audio.volume + 0.05);
        break;
      case 'ArrowDown':
        e.preventDefault();
        setVolume(audio.volume - 0.05);
        break;
      case 'KeyM':
        toggleMute();
        break;
      case 'KeyL':
        loopBtn.click();
        break;
    }
  });

  // ---------- Media Session (экран блокировки / наушники) ----------

  function updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    var d = duration();
    if (!d) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        playbackRate: audio.playbackRate || 1,
        position: clamp(audio.currentTime || 0, 0, d)
      });
    } catch (err) { /* не все браузеры принимают эти значения */ }
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: TRACK.title,
        artist: TRACK.artist,
        album: TRACK.album
      });

      var handlers = {
        play: function () { play(); },
        pause: function () { audio.pause(); },
        seekbackward: function (details) { seekTo(audio.currentTime - (details.seekOffset || 10)); },
        seekforward: function (details) { seekTo(audio.currentTime + (details.seekOffset || 10)); },
        seekto: function (details) { if (details.seekTime != null) seekTo(details.seekTime); }
      };

      Object.keys(handlers).forEach(function (action) {
        try { navigator.mediaSession.setActionHandler(action, handlers[action]); } catch (err) { /* не поддерживается */ }
      });
    } catch (err) { /* MediaMetadata недоступен */ }
  }

  // ---------- Автозапуск ----------
  /*
   * Браузер запрещает включать звук без жеста пользователя, и обойти это
   * нельзя — можно только получить жест как можно раньше. Порядок такой:
   *
   *  1. пробуем со звуком: сработает, если браузер уже разрешает
   *     (высокий Media Engagement Index для сайта, разрешение пользователя,
   *     активация на странице уже есть);
   *  2. не вышло → экран входа «click to enter» (режим 'gate') — клик по нему
   *     и есть тот самый жест, после которого звук разрешён;
   *     либо тихий старт (режим 'muted') + включение звука по первому жесту.
   */

  function hasActivation() {
    try {
      return !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
    } catch (err) {
      return false;
    }
  }

  function startAudible() {
    if (autoMuted) {
      autoMuted = false;
      audio.muted = false;
      renderVolume();
      savePrefs();
    }
    hideSoundHint();
    if (audio.paused) play();
    setStatus('');
  }

  function openGate() {
    if (!gate || gateOpen) return;
    gateOpen = true;
    autoplayState = 'gate';
    gate.hidden = false;
    document.body.classList.add('gate-open');
    // кадр на отрисовку, чтобы переход появления сработал
    window.requestAnimationFrame(function () {
      gate.classList.add('is-visible');
      if (enterBtn) enterBtn.focus();
    });
  }

  function closeGate() {
    if (!gate || !gateOpen) return;
    gateOpen = false;
    document.body.classList.remove('gate-open');
    gate.classList.remove('is-visible');
    window.setTimeout(function () { gate.hidden = true; }, 420);
  }

  function enter(silent) {
    if (entered) return;
    entered = true;
    closeGate();
    if (silent) {
      autoplayState = 'done';
      return;
    }
    autoplayState = 'done';
    startAudible();
  }

  function showSoundHint() {
    if (!soundHint) return;
    soundHint.hidden = false;
    player.classList.add('is-silent');
  }

  function hideSoundHint() {
    if (!soundHint) return;
    soundHint.hidden = true;
    player.classList.remove('is-silent');
  }

  // Режим 'muted': трек уже идёт, звук включаем на первом же жесте.
  function armSoundUnlock() {
    showSoundHint();
    if (unlockBound) return;
    unlockBound = true;

    var unlock = function () {
      if (!autoMuted) return;
      detach();
      startAudible();
    };
    var detach = function () {
      ['pointerdown', 'keydown', 'touchend'].forEach(function (evt) {
        document.removeEventListener(evt, unlock, true);
      });
      unlockBound = false;
    };

    ['pointerdown', 'keydown', 'touchend'].forEach(function (evt) {
      document.addEventListener(evt, unlock, true);   // capture: срабатываем раньше всех
    });
  }

  function attemptAutoplay() {
    if (AUTOPLAY_MODE === 'off' || autoplayState !== 'idle') return;
    autoplayState = 'trying';

    var promise = audio.play();
    if (!promise || typeof promise.then !== 'function') {
      autoplayState = 'done';
      return;
    }

    promise.then(function () {
      autoplayState = 'done';
      setStatus('');
    }).catch(function () {
      if (audio.error) {
        autoplayState = 'done';
        return;   // источник не грузится — заставка тут не поможет
      }

      if (AUTOPLAY_MODE === 'muted') {
        autoMuted = true;
        audio.muted = true;
        renderVolume();
        var quiet = audio.play();
        if (quiet && typeof quiet.then === 'function') {
          quiet.then(function () {
            autoplayState = 'muted';
            armSoundUnlock();
          }).catch(function () {
            autoMuted = false;
            audio.muted = prefs.muted;
            renderVolume();
            openGate();   // даже тихий старт запрещён — остаётся экран входа
          });
        } else {
          autoplayState = 'muted';
          armSoundUnlock();
        }
        return;
      }

      openGate();
    });
  }

  if (gate) gate.addEventListener('click', function () { enter(false); });
  if (soundHint) soundHint.addEventListener('click', function (e) { e.stopPropagation(); startAudible(); });

  document.addEventListener('keydown', function (e) {
    if (!gateOpen) return;
    if (e.key === 'Escape') {
      // Просто убираем заставку, сайт можно смотреть и без музыки.
      e.preventDefault();
      enter(true);
      return;
    }
    // Любой Enter/пробел на заставке = войти со звуком.
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space') {
      e.preventDefault();
      enter(false);
    }
  });

  // ---------- Инициализация ----------

  audio.volume = prefs.volume;
  audio.muted = prefs.muted;
  audio.loop = prefs.loop;
  try {
    audio.playbackRate = prefs.rate;
  } catch (err) {
    prefs.rate = 1;
  }

  seek.max = String(SEEK_MAX);
  volumeSlider.value = String(Math.round(prefs.volume * 100));

  renderVolume();
  renderRate();
  renderLoop();
  renderPlayState();
  renderBuffering(false);
  setupMediaSession();

  // Метаданные могли загрузиться до подключения скрипта — не ждём события.
  renderDuration();

  // Активация уже есть (например, пользователь вернулся на страницу) —
  // заставка не нужна, звук разрешат и так.
  attemptAutoplay();
  audio.addEventListener('canplay', function () {
    if (autoplayState === 'idle' || autoplayState === 'trying') attemptAutoplay();
  });
  if (hasActivation() && autoplayState === 'gate') enter(false);

  window.addEventListener('pagehide', function () {
    stopTicker();
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = 0;
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify({
          volume: audio.volume,
          muted: audio.muted,
          rate: audio.playbackRate,
          loop: audio.loop
        }));
      } catch (err) { /* ignore */ }
    }
  });
})();
