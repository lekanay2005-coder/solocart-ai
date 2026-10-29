/**
 * Byte's state machine (phase 4).
 *
 * Real states driven by real desk events — think while the AI runs, work
 * while something is being processed, celebrate a capture, look worried on a
 * failure, sleep when the desk is quiet. The state names, durations and
 * transitions follow Butler's little-butler behavior spec; the art is
 * SoloCart's own (the inline SVG already in the page) posed with CSS.
 *
 * - Optional: Settings > "Byte's reactions" (localStorage, device-local).
 * - prefers-reduced-motion: no breathing, no blink loop, no drag sway —
 *   poses still change, just instantly.
 * - The existing corner layout is untouched: only data-state and a small
 *   transform change.
 */
(() => {
  const STATES = {
    idle: { dur: 3200, next: 'idle' },
    blink: { dur: 180, next: 'idle' },
    peek: { dur: 1600, next: 'idle' },
    listen: { dur: 2000, next: 'idle' },
    think: { dur: 0, next: 'think' }, // waits for the host's next event
    work: { dur: 0, next: 'work' },   // waits for the host's next event
    success: { dur: 850, next: 'idle' },
    error: { dur: 650, next: 'idle' },
    attention: { dur: 0, next: 'attention' }, // waiting for a yes/no
    sleep: { dur: 0, next: 'sleep' },
    speak: { dur: 700, next: 'idle' },
    hide: { dur: 400, next: 'peek' },
    drag: { dur: 1100, next: 'idle' },
  };

  const IDLE_TO_SLEEP_MS = 60_000;
  const BLINK_MIN_MS = 3_500;
  const BLINK_JITTER_MS = 4_000;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const avatars = () => document.querySelectorAll('.pet-avatar');

  let state = 'idle';
  let enabled = localStorage.getItem('solocart-byte-reactions') !== 'false';
  let stateTimer = null;
  let sleepTimer = null;
  let blinkTimer = null;
  let listenersBound = false;

  function apply() {
    for (const avatar of avatars()) avatar.dataset.state = enabled ? state : 'idle';
  }

  function clearStateTimer() {
    if (stateTimer) clearTimeout(stateTimer);
    stateTimer = null;
  }

  /** Moves to `name`, honouring its end behavior. */
  function setState(name) {
    if (!STATES[name]) return;
    state = name;
    apply();
    clearStateTimer();
    const spec = STATES[name];
    if (spec.dur > 0) {
      stateTimer = setTimeout(() => setState(spec.next), spec.dur);
    }
    if (name !== 'sleep') armSleep();
    if (name === 'idle' && enabled && !reducedMotion.matches) armBlink();
  }

  function armSleep() {
    if (sleepTimer) clearTimeout(sleepTimer);
    sleepTimer = setTimeout(() => setState('sleep'), IDLE_TO_SLEEP_MS);
  }

  function armBlink() {
    if (blinkTimer) clearTimeout(blinkTimer);
    if (!enabled || reducedMotion.matches || state !== 'idle') return;
    blinkTimer = setTimeout(() => {
      if (state !== 'idle') return;
      setState('blink');
    }, BLINK_MIN_MS + Math.random() * BLINK_JITTER_MS);
  }

  /**
   * Desk events in, poses out. Unknown events only re-arm the idle clock, so
   * wiring a new event can never break the pet.
   */
  const EVENTS = {
    'ai:start': 'think',
    'ai:done': 'success',
    'ai:speak': 'speak',
    'ai:error': 'error',
    'ai:confirm': 'attention',
    work: 'work',
    success: 'success',
    error: 'error',
    attention: 'attention',
    listen: 'listen',
    sleep: 'sleep',
    wake: 'idle',
    peek: 'peek',
    hide: 'hide',
    drag: 'drag',
    quiet: 'idle',
  };

  function event(name) {
    if (!enabled && name !== 'wake') return;
    const target = EVENTS[name];
    if (target) setState(target);
    else armSleep();
  }

  function setEnabled(next) {
    enabled = Boolean(next);
    localStorage.setItem('solocart-byte-reactions', String(enabled));
    if (!enabled) {
      clearStateTimer();
      if (blinkTimer) clearTimeout(blinkTimer);
      state = 'idle';
    } else {
      armSleep();
      setState('idle');
    }
    apply();
  }

  // A light drag: pointer moves more than 7px (the behavior spec's threshold)
  // and Byte dangles; release docks it back. Disabled under reduced motion.
  function bindDrag() {
    if (listenersBound) return;
    listenersBound = true;
    document.addEventListener('pointerdown', (pointer) => {
      if (!enabled || reducedMotion.matches) return;
      const avatar = pointer.target.closest?.('.pet-avatar');
      if (!avatar) return;
      const startX = pointer.clientX;
      const startY = pointer.clientY;
      let dragging = false;

      const move = (event) => {
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) < 7) return;
        dragging = true;
        setState('drag');
        const svg = avatar.querySelector('svg');
        if (svg) {
          const clamp = (value) => Math.max(-8, Math.min(8, value));
          svg.style.transform = `translate(${clamp(dx)}px, ${clamp(dy)}px) rotate(${clamp(dx / 4)}deg)`;
        }
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        if (!dragging) return;
        const svg = avatar.querySelector('svg');
        if (svg) svg.style.transform = '';
        setState('idle');
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  }

  window.Byte = {
    event,
    setState,
    get state() { return state; },
    get enabled() { return enabled; },
    setEnabled,
    reducedMotion,
  };

  const start = () => {
    apply();
    armSleep();
    bindDrag();
    if (enabled && !reducedMotion.matches) armBlink();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
