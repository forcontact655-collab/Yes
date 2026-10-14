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
  var eq = $('eq');
  var eqBars = eq ? Array.prototype.slice.call(eq.querySelectorAll('span')) : [];
  var mskTimeEl = $('msk-time');
  var mskTimeText = $('msk-time-text');
  var particlesCanvas = $('bg-particles');
  var langSwitch = $('lang-switch');
  var ownerViewsEl = $('owner-views');
  var ownerViewsCountEl = $('owner-views-count');

  var OWNER_STORE_KEY = 'somewhat-empty.owner.v1';
  var VISITED_STORE_KEY = 'somewhat-empty.visited.v1';
  var OWNER_HASH = '2535c2ecc91cddd231a9f367dbccb3b341344c8626bc300259d64c3918750997';
  var COUNTER_BASE = 'https:' + '/' + '/abacus.jasoncameron.dev/';
  var COUNTER_GET_URL = COUNTER_BASE + 'get/empty.is-a.dev/unique-visitors';
  var COUNTER_HIT_URL = COUNTER_BASE + 'hit/empty.is-a.dev/unique-visitors';

  var currentLang = 'ru';
  var statusKey = '';
  var lastTimeStr = '--:--';
  var revealed = false;

  document.body.classList.add('has-reveal');

  function triggerReveal() {
    if (revealed) return;
    revealed = true;
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        document.body.classList.add('is-revealed');
        window.setTimeout(function () {
          document.body.classList.add('reveal-done');
        }, 1650);
      });
    });
  }

  var I18N = {
    ru: {
      skip: 'Перейти к содержимому',
      unmuteHint: 'включить звук',
      xiosDesc: 'Меняет внешний вид телеграм под iOS стиль.',
      xassistDesc: 'Умный помощник на базе ИИ прямо в телеграм.',
      xdevelopDesc: 'Мой канал со всеми проектами и последними обновлениями для них.',
      channelCta: 'Перейти',
      mskPrefix: 'МСК · ',
      mskLabel: 'Московское время',
      play: 'Воспроизвести',
      pause: 'Пауза',
      retry: 'Повторить загрузку',
      seekLabel: 'Перемотка',
      seekOf: ' из ',
      volumeLabel: 'Громкость',
      mute: 'Выключить звук',
      unmute: 'Включить звук',
      loopOn: 'Повтор трека: включён',
      loopOff: 'Повтор трека: выключен',
      speedLabel: 'Скорость воспроизведения',
      statusBlocked: 'Нажмите ▶, чтобы включить звук',
      statusError: 'Аудио не загрузилось — нажмите ▶ для повтора',
      statusLoading: 'Буферизация…',
      viewsTitle: 'Уникальные посетители'
    },
    en: {
      skip: 'Skip to content',
      unmuteHint: 'unmute',
      xiosDesc: 'Transforms Telegram appearance into an iOS-inspired style.',
      xassistDesc: 'Smart AI-powered assistant right inside Telegram.',
      xdevelopDesc: 'My channel featuring all projects and their latest updates.',
      channelCta: 'Open',
      mskPrefix: 'MSK · ',
      mskLabel: 'Moscow time',
      play: 'Play',
      pause: 'Pause',
      retry: 'Retry loading',
      seekLabel: 'Seek',
      seekOf: ' of ',
      volumeLabel: 'Volume',
      mute: 'Mute',
      unmute: 'Unmute',
      loopOn: 'Loop: on',
      loopOff: 'Loop: off',
      speedLabel: 'Playback speed',
      statusBlocked: 'Press ▶ to enable sound',
      statusError: 'Audio failed to load — press ▶ to retry',
      statusLoading: 'Buffering…',
      viewsTitle: 'Unique visitors'
    }
  };

  function t(key) {
    var dict = I18N[currentLang] || I18N.ru;
    return dict[key] || I18N.ru[key] || '';
  }

  initMoscowClock();
  initBackgroundParticles();
  initLangSwitch();
  initVisitorCounter();

  if (!audio || !player) {
    applyLang();
    return;
  }

  var AUTOPLAY_MODE = 'gate';
  var SEEK_MAX = 1000;
  var STORE_KEY = 'somewhat-empty.player.v1';
  var TRACK = {
    title: 'Красавица (sped up)',
    artist: 'ЯРЧЕ СОЛНЦА',
    album: 'Somewhat_empty'
  };

  var prefs = loadPrefs();
  var pendingTime = null;
  var scrubbing = false;
  var rafId = 0;
  var autoplayState = 'idle';
  var gateOpen = false;
  var entered = false;
  var autoMuted = false;
  var unlockBound = false;

  var audioCtx = null;
  var analyser = null;
  var freqData = null;
  var webAudioFailed = false;
  var eqSmooth = [0.3, 0.3, 0.3, 0.3];
  var EQ_BANDS = [
    { from: 1, to: 3, boost: 1.05 },
    { from: 4, to: 9, boost: 1.22 },
    { from: 10, to: 20, boost: 1.42 },
    { from: 21, to: 38, boost: 1.68 }
  ];

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
      } catch (err) {}
    }, 400);
  }

  function setStatus(key) {
    statusKey = key || '';
    if (!statusEl) return;
    var next = statusKey ? t(statusKey) : '';
    if (statusEl.textContent !== next) statusEl.textContent = next;
    player.classList.toggle('has-error', statusKey === 'statusError');
  }

  function ensureAudioGraph() {
    if (webAudioFailed || !eqBars.length) return;
    if (!audioCtx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        webAudioFailed = true;
        return;
      }
      try {
        audioCtx = new Ctx();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.72;
        var source = audioCtx.createMediaElementSource(audio);
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        freqData = new Uint8Array(analyser.frequencyBinCount);
      } catch (err) {
        webAudioFailed = true;
        audioCtx = null;
        analyser = null;
        return;
      }
    }
    if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
      try {
        var p = audioCtx.resume();
        if (p && typeof p.then === 'function') {
          p.then(function () {
            if (eq && audioCtx.state === 'running') eq.classList.add('is-live');
          }).catch(function () {});
        }
      } catch (err) {}
    }
    if (eq && audioCtx.state === 'running') {
      eq.classList.add('is-live');
    }
  }

  function resetEqualizerBars() {
    if (!eqBars.length) return;
    for (var i = 0; i < eqBars.length; i++) {
      eqSmooth[i] = 0.3;
      eqBars[i].style.height = '';
      eqBars[i].style.opacity = '';
    }
  }

  function renderEqualizer() {
    if (!analyser || !freqData || !eqBars.length || !audioCtx || audioCtx.state !== 'running') return;
    if (eq && !eq.classList.contains('is-live')) eq.classList.add('is-live');

    if (audio.paused || audio.ended || audio.muted || audio.volume === 0) {
      for (var j = 0; j < eqBars.length; j++) {
        eqSmooth[j] = eqSmooth[j] * 0.8 + 0.24 * 0.2;
        eqBars[j].style.height = (eqSmooth[j] * 100).toFixed(1) + '%';
        eqBars[j].style.opacity = '0.5';
      }
      return;
    }

    analyser.getByteFrequencyData(freqData);
    var maxBin = freqData.length - 1;

    for (var i = 0; i < eqBars.length; i++) {
      var band = EQ_BANDS[i] || EQ_BANDS[0];
      var start = clamp(band.from, 0, maxBin);
      var end = clamp(band.to, start, maxBin);
      var sum = 0;
      var count = 0;
      for (var b = start; b <= end; b++) {
        sum += freqData[b];
        count++;
      }
      var avg = count > 0 ? (sum / count) / 255 : 0;
      var shaped = Math.pow(avg, 0.85) * band.boost;
      var target = clamp(0.18 + shaped * 0.86, 0.18, 1);
      eqSmooth[i] = eqSmooth[i] * 0.42 + target * 0.58;
      eqBars[i].style.height = (eqSmooth[i] * 100).toFixed(1) + '%';
      eqBars[i].style.opacity = (0.55 + eqSmooth[i] * 0.45).toFixed(2);
    }
  }

  function progressTime() {
    return pendingTime !== null ? pendingTime : (audio.currentTime || 0);
  }

  function renderProgress() {
    var d = duration();
    var cur = clamp(progressTime(), 0, d || progressTime());
    var ratio = d > 0 ? cur / d : 0;

    seekFill.style.width = (ratio * 100).toFixed(3) + '%';
    if (!scrubbing) seek.value = String(Math.round(ratio * SEEK_MAX));

    currentTimeEl.textContent = formatTime(cur);
    seek.setAttribute('aria-valuetext', formatTime(cur) + t('seekOf') + formatTime(d));
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
    muteBtn.setAttribute('aria-label', muted ? t('unmute') : t('mute'));
    muteBtn.classList.toggle('is-quiet', !muted && audio.volume > 0 && audio.volume < 0.5);
  }

  function renderPlayState() {
    var playing = !audio.paused && !audio.ended;
    player.classList.toggle('is-playing', playing);
    document.body.classList.toggle('is-audio-playing', playing);
    if (statusKey === 'statusError') {
      playBtn.setAttribute('aria-label', t('retry'));
    } else {
      playBtn.setAttribute('aria-label', playing ? t('pause') : t('play'));
    }
    if (playing && statusKey !== 'statusError') setStatus('');
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
    loopBtn.setAttribute('aria-label', audio.loop ? t('loopOn') : t('loopOff'));
  }

  function tick() {
    renderProgress();
    renderEqualizer();
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
    resetEqualizerBars();
    renderProgress();
  }

  function play() {
    if (audio.error) {
      setStatus('');
      audio.load();
    }
    if (audioCtx && audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
      try { audioCtx.resume(); } catch (err) {}
    }
    var promise = audio.play();
    if (promise && typeof promise.then === 'function') {
      promise.then(function () {
        ensureAudioGraph();
        setStatus('');
      }).catch(function () {
        if (!audio.error) setStatus('statusBlocked');
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
    } catch (err) {}
    renderProgress();
  }

  playBtn.addEventListener('click', togglePlay);

  audio.addEventListener('play', function () {
    ensureAudioGraph();
    renderPlayState();
    startTicker();
  });
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
  audio.addEventListener('playing', function () {
    ensureAudioGraph();
    renderBuffering(false);
    setStatus('');
  });

  audio.addEventListener('loadedmetadata', renderDuration);
  audio.addEventListener('durationchange', renderDuration);
  audio.addEventListener('progress', renderBuffer);
  audio.addEventListener('timeupdate', function () {
    if (!rafId) renderProgress();
  });
  audio.addEventListener('volumechange', function () { renderVolume(); savePrefs(); });
  audio.addEventListener('ratechange', function () { renderRate(); savePrefs(); updatePositionState(); });

  audio.addEventListener('error', function () {
    renderBuffering(false);
    stopTicker();
    setStatus('statusError');
    playBtn.setAttribute('aria-label', t('retry'));
  });

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

  window.addEventListener('pointerup', function () {
    if (scrubbing) commitScrub();
  });
  window.addEventListener('pointercancel', function () {
    if (scrubbing) commitScrub();
  });
  window.addEventListener('blur', function () {
    if (scrubbing) commitScrub();
  });

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

  function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    if (tag === 'BUTTON' || tag === 'A') return true;
    if (typeof el.closest === 'function' && el.closest('[role="menuitemradio"]')) return true;
    return false;
  }

  document.addEventListener('keydown', function (e) {
    if (gateOpen) return;
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
    } catch (err) {}
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
        try { navigator.mediaSession.setActionHandler(action, handlers[action]); } catch (err) {}
      });
    } catch (err) {}
  }

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
    ensureAudioGraph();
    if (audio.paused) play();
    setStatus('');
  }

  function openGate() {
    if (!gate || gateOpen) return;
    gateOpen = true;
    autoplayState = 'gate';
    gate.hidden = false;
    document.body.classList.add('gate-open');
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
    triggerReveal();
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
      document.addEventListener(evt, unlock, true);
    });
  }

  function attemptAutoplay() {
    if (AUTOPLAY_MODE === 'off' || autoplayState !== 'idle') {
      if (AUTOPLAY_MODE === 'off') triggerReveal();
      return;
    }
    autoplayState = 'trying';

    var promise = audio.play();
    if (!promise || typeof promise.then !== 'function') {
      autoplayState = 'done';
      triggerReveal();
      return;
    }

    promise.then(function () {
      ensureAudioGraph();
      autoplayState = 'done';
      triggerReveal();
      setStatus('');
    }).catch(function () {
      if (audio.error) {
        autoplayState = 'done';
        triggerReveal();
        return;
      }

      if (AUTOPLAY_MODE === 'muted') {
        autoMuted = true;
        audio.muted = true;
        renderVolume();
        var quiet = audio.play();
        if (quiet && typeof quiet.then === 'function') {
          quiet.then(function () {
            autoplayState = 'muted';
            triggerReveal();
            armSoundUnlock();
          }).catch(function () {
            autoMuted = false;
            audio.muted = prefs.muted;
            renderVolume();
            openGate();
          });
        } else {
          autoplayState = 'muted';
          triggerReveal();
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
      e.preventDefault();
      enter(true);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space') {
      e.preventDefault();
      enter(false);
    }
  });

  function renderClockText() {
    if (!mskTimeText) return;
    mskTimeText.textContent = t('mskPrefix') + lastTimeStr;
    if (mskTimeEl) mskTimeEl.setAttribute('aria-label', t('mskLabel'));
  }

  function initMoscowClock() {
    if (!mskTimeText) return;
    var formatter = null;
    try {
      formatter = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
    } catch (err) {}

    function updateClock() {
      var now = new Date();
      var timeStr = '';
      if (formatter) {
        try {
          timeStr = formatter.format(now);
        } catch (err) {}
      }
      if (!timeStr) {
        var utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
        var msk = new Date(utcMs + 3 * 3600000);
        var hh = msk.getHours();
        var mm = msk.getMinutes();
        timeStr = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
      }
      lastTimeStr = timeStr;
      renderClockText();
    }

    updateClock();
    window.setInterval(updateClock, 10000);
  }

  function applyLang() {
    document.documentElement.lang = currentLang;

    var nodes = document.querySelectorAll('[data-i18n]');
    Array.prototype.forEach.call(nodes, function (el) {
      var key = el.getAttribute('data-i18n');
      var val = t(key);
      if (val) el.textContent = val;
    });

    if (langSwitch) {
      var btns = langSwitch.querySelectorAll('button[data-lang]');
      Array.prototype.forEach.call(btns, function (btn) {
        var active = btn.getAttribute('data-lang') === currentLang;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    if (ownerViewsEl) {
      ownerViewsEl.setAttribute('title', t('viewsTitle'));
      ownerViewsEl.setAttribute('aria-label', t('viewsTitle'));
    }

    renderClockText();

    if (!audio || !player) return;
    if (seek) seek.setAttribute('aria-label', t('seekLabel'));
    if (volumeSlider) volumeSlider.setAttribute('aria-label', t('volumeLabel'));
    if (speedBtn) speedBtn.setAttribute('aria-label', t('speedLabel'));
    if (speedMenu) speedMenu.setAttribute('aria-label', t('speedLabel'));
    setStatus(statusKey);
    renderPlayState();
    renderVolume();
    renderLoop();
    renderProgress();
  }

  function setLang(lang) {
    var next = lang === 'en' ? 'en' : 'ru';
    if (next === currentLang) return;
    currentLang = next;
    applyLang();
  }

  function initLangSwitch() {
    if (!langSwitch) return;
    langSwitch.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-lang]') : null;
      if (btn) {
        var targetLang = btn.getAttribute('data-lang');
        if (targetLang === currentLang) {
          setLang(currentLang === 'ru' ? 'en' : 'ru');
        } else {
          setLang(targetLang);
        }
      } else {
        setLang(currentLang === 'ru' ? 'en' : 'ru');
      }
    });
  }

  function sha256(ascii) {
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }
    var mathPow = Math.pow;
    var maxWord = mathPow(2, 32);
    var i;
    var j;
    var result = '';
    var words = [];
    var asciiBitLength = ascii.length * 8;
    var hash = [];
    var k = [];
    var primeCounter = 0;
    var isComposite = {};
    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = 0; i < 313; i += candidate) {
          isComposite[i] = candidate;
        }
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += '\x80';
    while ((ascii.length % 64) - 56) ascii += '\x00';
    for (i = 0; i < ascii.length; i++) {
      j = ascii.charCodeAt(i);
      if (j >> 8) return '';
      words[i >> 2] |= j << ((3 - (i % 4)) * 8);
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (j = 0; j < words.length;) {
      var w = words.slice(j, (j += 16));
      var oldHash = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15];
        var w2 = w[i - 2];
        var a = hash[0];
        var e = hash[4];
        var temp1 =
          hash[7] +
          (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
          ((e & hash[5]) ^ (~e & hash[6])) +
          k[i] +
          (w[i] =
            i < 16
              ? w[i]
              : (w[i - 16] +
                  (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                  w[i - 7] +
                  (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
                0);
        var temp2 =
          (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
          ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (i = 0; i < 8; i++) {
        hash[i] = (hash[i] + oldHash[i]) | 0;
      }
    }
    for (i = 0; i < 8; i++) {
      for (j = 3; j + 1; j--) {
        var b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? 0 : '') + b.toString(16);
      }
    }
    return result;
  }

  function extractOwnerToken() {
    var sources = [window.location.hash || '', window.location.search || ''];
    for (var i = 0; i < sources.length; i++) {
      var raw = sources[i].replace(/^[#?]/, '');
      if (!raw) continue;
      var parts = raw.split('&');
      for (var j = 0; j < parts.length; j++) {
        var kv = parts[j].split('=');
        var k = decodeURIComponent(kv[0] || '');
        if (k === 'key' || k === 'owner') {
          return decodeURIComponent(kv.slice(1).join('=') || '').trim();
        }
      }
    }
    return '';
  }

  function initVisitorCounter() {
    var token = extractOwnerToken();
    if (token && sha256(token) === OWNER_HASH) {
      try {
        window.localStorage.setItem(OWNER_STORE_KEY, OWNER_HASH);
        window.localStorage.setItem(VISITED_STORE_KEY, '1');
      } catch (err) {}
      if (window.history && typeof window.history.replaceState === 'function') {
        try {
          window.history.replaceState(null, '', window.location.pathname);
        } catch (err) {}
      }
    }

    var isOwner = false;
    try {
      isOwner = window.localStorage.getItem(OWNER_STORE_KEY) === OWNER_HASH;
    } catch (err) {}

    if (isOwner) {
      if (ownerViewsEl) ownerViewsEl.hidden = false;
      if (typeof window.fetch === 'function') {
        window.fetch(COUNTER_GET_URL, { cache: 'no-store' })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) {
            if (data && typeof data.value === 'number' && ownerViewsCountEl) {
              ownerViewsCountEl.textContent = String(data.value);
            }
          })
          .catch(function () {});
      }
      return;
    }

    var alreadyVisited = false;
    try {
      alreadyVisited = window.localStorage.getItem(VISITED_STORE_KEY) === '1';
    } catch (err) {}

    if (!alreadyVisited && typeof window.fetch === 'function') {
      try {
        window.localStorage.setItem(VISITED_STORE_KEY, '1');
      } catch (err) {}
      window.fetch(COUNTER_HIT_URL, { cache: 'no-store' }).catch(function () {});
    }
  }

  function initBackgroundParticles() {
    if (!particlesCanvas || !particlesCanvas.getContext) return;
    var ctx = particlesCanvas.getContext('2d');
    if (!ctx) return;

    var reducedMotion = false;
    try {
      reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (err) {}

    var width = 0;
    var height = 0;
    var dpr = 1;
    var particles = [];
    var animId = 0;
    var COLORS = [
      '169, 139, 250',
      '201, 184, 255',
      '240, 171, 252',
      '139, 92, 246'
    ];

    function resize() {
      width = window.innerWidth || document.documentElement.clientWidth || 360;
      height = window.innerHeight || document.documentElement.clientHeight || 640;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      particlesCanvas.width = Math.round(width * dpr);
      particlesCanvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      var targetCount = width < 600 ? 26 : 40;
      while (particles.length < targetCount) {
        particles.push(createParticle(true));
      }
      if (particles.length > targetCount) {
        particles.length = targetCount;
      }
    }

    function createParticle(randomY) {
      return {
        x: Math.random() * (width || 360),
        y: randomY ? Math.random() * (height || 640) : (height || 640) + 10,
        r: 0.9 + Math.random() * 1.7,
        vx: (Math.random() - 0.5) * 0.22,
        vy: -(0.12 + Math.random() * 0.24),
        alpha: 0.16 + Math.random() * 0.36,
        phase: Math.random() * Math.PI * 2,
        color: COLORS[Math.floor(Math.random() * COLORS.length)]
      };
    }

    function drawFrame() {
      ctx.clearRect(0, 0, width, height);
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        if (!reducedMotion) {
          p.x += p.vx;
          p.y += p.vy;
          p.phase += 0.018;

          if (p.y < -10) {
            p.y = height + 10;
            p.x = Math.random() * width;
          }
          if (p.x < -10) p.x = width + 10;
          else if (p.x > width + 10) p.x = -10;
        }

        var twinkle = reducedMotion ? 1 : (0.75 + 0.25 * Math.sin(p.phase));
        var a = clamp(p.alpha * twinkle, 0.06, 0.65);

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + p.color + ', ' + a.toFixed(3) + ')';
        ctx.fill();
      }

      if (!reducedMotion && !document.hidden) {
        animId = window.requestAnimationFrame(drawFrame);
      } else {
        animId = 0;
      }
    }

    resize();
    drawFrame();

    window.addEventListener('resize', function () {
      resize();
      if (reducedMotion) drawFrame();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (animId) {
          window.cancelAnimationFrame(animId);
          animId = 0;
        }
      } else if (!reducedMotion && !animId) {
        animId = window.requestAnimationFrame(drawFrame);
      }
    });
  }

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

  applyLang();
  renderRate();
  renderBuffering(false);
  setupMediaSession();
  renderDuration();

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
      } catch (err) {}
    }
  });
})();
