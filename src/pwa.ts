// Cài app ra màn hình chính + tự cập nhật bắt buộc khi có phiên bản mới.

export const APP_VERSION = __APP_VERSION__;
export const BUILD_ID = __BUILD_ID__;

export interface UpdateHooks {
  /** false khi đang thu âm: chờ thu xong mới cập nhật để không mất bản thu */
  canReloadNow: () => boolean;
  /** lưu dữ liệu trước khi tải lại */
  beforeReload: () => void;
}

let overlayShown = false;
let reloading = false;

function overlay(newVersion: string | null, waitingForRecording: boolean) {
  let el = document.getElementById('updateOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'updateOverlay';
    el.className = 'update-overlay';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-live', 'assertive');
    document.body.append(el);
  }
  el.innerHTML = `
    <div class="update-card">
      <div class="update-icon">⬆</div>
      <h3>Có phiên bản mới${newVersion ? ` v${newVersion}` : ''}</h3>
      <p>${
        waitingForRecording
          ? 'Bản cập nhật sẽ được cài ngay khi bạn dừng thu âm.'
          : 'Đang cập nhật, app sẽ tự mở lại sau vài giây. Bài hát của bạn đã được lưu.'
      }</p>
      <div class="update-bar"><div></div></div>
      ${newVersion && newVersion !== APP_VERSION ? `<small>v${APP_VERSION} → v${newVersion}</small>` : ''}
    </div>`;
  el.hidden = false;
}

async function latestVersion(): Promise<{ version: string; build: string } | null> {
  try {
    const r = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function doReload(hooks: UpdateHooks, activate: () => void) {
  const tryNow = () => {
    if (!hooks.canReloadNow()) {
      setTimeout(tryNow, 500);
      return;
    }
    if (reloading) return;
    reloading = true;
    overlay(pendingVersion, false);
    try {
      hooks.beforeReload();
    } catch {
      /* vẫn cập nhật */
    }
    setTimeout(() => {
      activate();
      // phòng khi trình duyệt không báo controllerchange
      setTimeout(() => location.reload(), 4000);
    }, 700);
  };
  tryNow();
}

let pendingVersion: string | null = null;

function forceUpdate(hooks: UpdateHooks, activate: () => void) {
  if (overlayShown) return;
  overlayShown = true;
  void latestVersion().then((v) => {
    pendingVersion = v?.version ?? null;
    overlay(pendingVersion, !hooks.canReloadNow());
  });
  overlay(null, !hooks.canReloadNow());
  doReload(hooks, activate);
}

export function setupUpdates(hooks: UpdateHooks) {
  if (import.meta.env.DEV) return;
  const hasSW = 'serviceWorker' in navigator;

  if (hasSW) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (overlayShown) location.reload();
    });
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        const onWaiting = (w: ServiceWorker) => forceUpdate(hooks, () => w.postMessage('SKIP_WAITING'));
        if (reg.waiting && navigator.serviceWorker.controller) onWaiting(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          nw?.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) onWaiting(nw);
          });
        });
        const check = () => reg.update().catch(() => undefined);
        setInterval(check, 60_000);
        document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
        window.addEventListener('online', check);
      })
      .catch(() => undefined);
  }

  // kiểm tra thêm bằng version.json (kể cả trình duyệt không có service worker)
  const poll = async () => {
    const v = await latestVersion();
    if (!v || v.build === BUILD_ID) return;
    if (hasSW && navigator.serviceWorker.controller) {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.update().catch(() => undefined);
      // nếu sau 20 giây service worker vẫn chưa sẵn sàng thì tải lại trực tiếp
      setTimeout(() => {
        if (!overlayShown) forceUpdate(hooks, () => location.reload());
      }, 20_000);
    } else {
      forceUpdate(hooks, () => location.reload());
    }
  };
  setTimeout(poll, 5_000);
  setInterval(poll, 90_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void poll());
}

// ---------- cài app ----------
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Hiện nút "Cài app" khi trình duyệt cho phép; iPhone/iPad hiện hướng dẫn thêm vào màn hình chính. */
export function setupInstall(buttons: HTMLElement[], showIosHelp: () => void, onInstalled: () => void) {
  let deferred: BeforeInstallPromptEvent | null = null;
  const show = (v: boolean) => buttons.forEach((b) => (b.hidden = !v));
  show(false);
  if (isStandalone()) return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    show(true);
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    show(false);
    onInstalled();
  });
  if (isIos()) show(true);

  buttons.forEach((b) =>
    b.addEventListener('click', async () => {
      if (deferred) {
        await deferred.prompt();
        const r = await deferred.userChoice;
        if (r.outcome === 'accepted') show(false);
        deferred = null;
      } else {
        showIosHelp();
      }
    }),
  );
}
