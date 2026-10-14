(function () {
  'use strict';

  const audio = document.getElementById('audio');
  const player = document.getElementById('player');
  const playBtn = document.getElementById('play-btn');
  const seek = document.getElementById('seek');
  const seekFill = document.getElementById('seek-fill');
  const currentTimeEl = document.getElementById('current-time');
  const durationEl = document.getElementById('duration-time');
  const volumeSlider = document.getElementById('volume');
  const volumeFill = document.getElementById('volume-fill');
  const muteBtn = document.getElementById('mute-btn');
  const speedBtn = document.getElementById('speed-btn');
  const speedMenu = document.getElementById('speed-menu');
  const speedLabel = document.getElementById('speed-label');
  const autoplayStatus = document.getElementById('autoplay-status');

  if (!audio || !player) return;

  // ---------- Utilities ----------

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function updateSeekFill() {
    const val = parseFloat(seek.value);
    seekFill.style.width = val + '%';
  }

  function updateVolumeFill() {
    const v = parseFloat(volumeSlider.value);
    volumeFill.style.width = (v * 100) + '%';
  }

  // ---------- Play / Pause ----------

  let isSeeking = false;

  function togglePlay() {
    if (audio.paused) {
      audio.play().catch(() => {
        autoplayStatus.textContent = 'Tap Play to start';
        autoplayStatus.classList.add('is-blocked');
      });
    } else {
      audio.pause();
    }
  }

  playBtn.addEventListener('click', togglePlay);

  audio.addEventListener('play', () => {
    player.classList.add('is-playing');
    playBtn.setAttribute('aria-label', 'Pause');
    autoplayStatus.textContent = '';
    autoplayStatus.classList.remove('is-blocked');
  });

  audio.addEventListener('pause', () => {
    player.classList.remove('is-playing');
    playBtn.setAttribute('aria-label', 'Play');
  });

  // ---------- Time / Seek ----------

  audio.addEventListener('loadedmetadata', () => {
    seek.max = audio.duration || 100;
    durationEl.textContent = formatTime(audio.duration);
    updateSeekFill();
  });

  audio.addEventListener('timeupdate', () => {
    if (!isSeeking && audio.duration) {
      seek.value = audio.currentTime;
      seek.max = audio.duration;
      updateSeekFill();
      currentTimeEl.textContent = formatTime(audio.currentTime);
    }
  });

  audio.addEventListener('ended', () => {
    audio.currentTime = 0;
    player.classList.remove('is-playing');
  });

  const startSeek = () => { isSeeking = true; };
  const endSeek = () => {
    isSeeking = false;
    audio.currentTime = parseFloat(seek.value);
  };

  seek.addEventListener('input', () => {
    updateSeekFill();
    currentTimeEl.textContent = formatTime(parseFloat(seek.value));
  });
  seek.addEventListener('mousedown', startSeek);
  seek.addEventListener('touchstart', startSeek, { passive: true });
  seek.addEventListener('change', endSeek);
  seek.addEventListener('mouseup', endSeek);
  seek.addEventListener('touchend', endSeek);

  // ---------- Volume ----------

  let lastVolume = 0.8;

  function setVolume(v) {
    v = Math.max(0, Math.min(1, v));
    audio.volume = v;
    volumeSlider.value = v;
    updateVolumeFill();
    if (v > 0) {
      player.classList.remove('is-muted');
      muteBtn.setAttribute('aria-label', 'Mute');
      lastVolume = v;
    } else {
      player.classList.add('is-muted');
      muteBtn.setAttribute('aria-label', 'Unmute');
    }
  }

  volumeSlider.addEventListener('input', () => {
    setVolume(parseFloat(volumeSlider.value));
  });

  muteBtn.addEventListener('click', () => {
    if (audio.volume > 0) {
      lastVolume = audio.volume;
      setVolume(0);
    } else {
      setVolume(lastVolume || 0.8);
    }
  });

  // Initialize volume
  setVolume(0.8);

  // ---------- Playback Speed ----------

  function setSpeed(speed) {
    speed = parseFloat(speed);
    audio.playbackRate = speed;
    speedLabel.textContent = speed + '×';
    const btns = speedMenu.querySelectorAll('button');
    btns.forEach((b) => {
      b.classList.toggle('is-active', parseFloat(b.dataset.speed) === speed);
    });
  }

  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = speedMenu.classList.toggle('is-open');
    speedMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
  });

  speedMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-speed]');
    if (!btn) return;
    setSpeed(btn.dataset.speed);
    speedMenu.classList.remove('is-open');
    speedMenu.setAttribute('aria-hidden', 'true');
    speedBtn.focus();
  });

  document.addEventListener('click', (e) => {
    if (!speedMenu.contains(e.target) && e.target !== speedBtn) {
      speedMenu.classList.remove('is-open');
      speedMenu.setAttribute('aria-hidden', 'true');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      speedMenu.classList.remove('is-open');
      speedMenu.setAttribute('aria-hidden', 'true');
    }
  });

  // ---------- Keyboard shortcuts ----------

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        if (e.shiftKey) {
          audio.currentTime = Math.max(0, audio.currentTime - 10);
        } else {
          audio.currentTime = Math.max(0, audio.currentTime - 5);
        }
        break;
      case 'ArrowRight':
        if (e.shiftKey) {
          audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10);
        } else {
          audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
        }
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
        muteBtn.click();
        break;
    }
  });

  // ---------- Autoplay attempt ----------
  // Strategy: try to play unmuted first. If blocked, most browsers will
  // reject the promise; we surface a subtle hint instead of auto-muting
  // (which would bypass autoplay policy but is a bad UX).

  function attemptAutoplay() {
    const promise = audio.play();
    if (promise !== undefined) {
      promise.then(() => {
        autoplayStatus.textContent = '';
        autoplayStatus.classList.remove('is-blocked');
      }).catch(() => {
        // Autoplay with sound blocked by the browser.
        // We do NOT silently mute — show a gentle prompt.
        autoplayStatus.textContent = 'Click Play to unmute';
        autoplayStatus.classList.add('is-blocked');
      });
    }
  }

  // Try immediately
  attemptAutoplay();

  // Some browsers need a brief moment; retry once after a tick.
  window.addEventListener('load', () => {
    if (audio.paused) {
      setTimeout(attemptAutoplay, 200);
    }
  });

  // If user interacts anywhere on the page before they've played, try again
  // (browsers count this as a user activation gesture).
  let interacted = false;
  const resumeOnInteract = () => {
    if (interacted || !audio.paused) return;
    interacted = true;
    audio.play().then(() => {
      autoplayStatus.textContent = '';
      autoplayStatus.classList.remove('is-blocked');
    }).catch(() => { /* still blocked, leave the prompt */ });
  };

  ['click', 'touchstart', 'keydown'].forEach((evt) => {
    document.addEventListener(evt, resumeOnInteract, { once: true, passive: true });
  });
})();
