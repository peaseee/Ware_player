const { app, BrowserWindow, dialog, ipcMain, screen, shell, Tray, Menu, nativeImage, globalShortcut, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { LIBRARY_DIR, DATA_DIR, resolveBinary, tutorialDone, markTutorialDone, readStartupConfig, writeStartupConfig } = require('./platform');
const { getLauncherInfo, installLauncher } = require('./launcher');
const { getSystemAudioOutputInfo } = require('./audio-output');
const { log, tail, LOG_DIR } = require('./logger');
const logger = { log, tail, LOG_DIR, error: (msg, err) => log('ERROR', `${msg}: ${err && err.message ? err.message : err}`) };

process.on('uncaughtException', (err) => {
  try { logger.error('Uncaught exception in main', err); } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('Unhandled rejection in main', err);
  } catch (_) {}
});

const enabledFeatures = [];
if (process.platform === 'linux') {
  enabledFeatures.push('WaylandWindowDecorations', 'UseOzonePlatform', 'WaylandFractionalScaleV1', 'MediaSessionService', 'HardwareMediaKeyHandling');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('disable-features', 'Vulkan,AudioServiceOutOfProcess');

  if (process.env.WARE_SKIP_GPU_BUFFER_FLAGS !== '1') {
    app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
    app.commandLine.appendSwitch('disable-gpu-memory-buffer-compositor-resources');
  }
}

if (process.platform === 'win32') {
  enabledFeatures.push('HardwareMediaKeyHandling');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

if (enabledFeatures.length > 0) {
  app.commandLine.appendSwitch('enable-features', enabledFeatures.join(','));
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('renderer-process-limit', '1');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-speech-api');
app.commandLine.appendSwitch('js-flags', '--expose-gc');

const extraFlags = (process.env.WARE_FLAGS || '').split(';').map((s) => s.trim()).filter(Boolean);
for (const flag of extraFlags) {
  const eq = flag.indexOf('=');
  if (eq > 0) app.commandLine.appendSwitch(flag.slice(0, eq), flag.slice(eq + 1));
  else app.commandLine.appendSwitch(flag);
}

if (process.env.WARE_DEBUG === '1') {
  app.whenReady().then(async () => {
    console.log('[gpu] features', JSON.stringify(app.getGPUFeatureStatus()));
    try {
      console.log('[gpu] info', JSON.stringify(await app.getGPUInfo('basic')));
    } catch (e) {}
    setInterval(() => {
      const rows = app.getAppMetrics().map((m) => `${m.type}:${Math.round(m.cpu.percentCPUUsage)}%`);
      console.log('[cpu]', rows.join('  '));
    }, 5000).unref();
  });
}

if (process.argv.includes('lyrics') || process.argv.includes('--lyrics')) {
  const cliPath = path.join(__dirname, 'cli.js');
  const child = spawn(process.execPath, [cliPath, 'lyrics'], { stdio: 'inherit', env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) });
  child.on('exit', (code) => process.exit(code || 0));
} else {
  runGUI();
}

function runGUI() {
  // Must run before the server module loads, because that module reads the
  // library index from disk as soon as it is required.
  try {
    const result = require('./migrate').run();
    if (result && result.imported) logger.log('MIGRATE', `imported ${result.imported} file(s) from the previous profile`);
  } catch (e) {
    try { logger.error('Profile import failed', e); } catch (_) {}
  }

  const { startServer, PORT, getServerToken } = require('./server');
  const discordRPC = require('./discord-rpc');

  let mainWindow = null;
  const allowMulti = !!readStartupConfig().multiInstance;
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock && !allowMulti) { app.quit(); return; }
  if (!gotLock && allowMulti) app.setPath('userData', `${app.getPath('userData')}-instance-${process.pid}`);
  app.on('second-instance', () => {
    if (allowMulti) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  let serverPort = PORT;
  let tray = null;
  let isQuitting = false;
  let trayOnClose = process.platform !== 'linux';
  let isMiniWindow = false;
  let preMiniBounds = null;

  const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');

  function readWindowState() {
    try {
      const raw = fs.readFileSync(windowStatePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function clampBoundsToDisplay(bounds) {
    const primaryDisplay = screen.getPrimaryDisplay();
    const primaryWorkArea = primaryDisplay.workArea;
    const scaleFactor = primaryDisplay.scaleFactor;

    const sourceBounds = bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)
    ? { ...bounds }
    : {};

    const minW = 360;
    const minH = 500;

    const width = Math.max(minW, Math.min(sourceBounds.width || 0, primaryWorkArea.width));
    const height = Math.max(minH, Math.min(sourceBounds.height || 0, primaryWorkArea.height));

    const display = screen.getDisplayMatching({
      x: sourceBounds.x ?? primaryWorkArea.x,
      y: sourceBounds.y ?? primaryWorkArea.y,
      width,
      height
    }) || primaryDisplay;

    const workArea = display.workArea;
    const x = Math.min(
      Math.max(sourceBounds.x ?? workArea.x + Math.round((workArea.width - width) / 2), workArea.x),
                       workArea.x + Math.max(0, workArea.width - width)
    );
    const y = Math.min(
      Math.max(sourceBounds.y ?? workArea.y + Math.round((workArea.height - height) / 2), workArea.y),
                       workArea.y + Math.max(0, workArea.height - height)
    );

    return { x, y, width, height };
  }

  function getResponsiveWindowBounds() {
    const { workArea } = screen.getPrimaryDisplay();
    const persisted = readWindowState();
    const responsiveBounds = {
      width: Math.round(workArea.width * 0.82),
      height: Math.round(workArea.height * 0.86),
      x: workArea.x + Math.round(workArea.width * 0.09),
      y: workArea.y + Math.round(workArea.height * 0.07)
    };
    const merged = {
      ...responsiveBounds,
      ...(persisted && persisted.bounds ? persisted.bounds : {})
    };
    return clampBoundsToDisplay(merged);
  }

  function persistWindowState() {
    if (isMiniWindow) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const isMaximized = mainWindow.isMaximized();
    const isFullScreen = mainWindow.isFullScreen();
    const bounds = isMaximized || isFullScreen ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    try {
      fs.mkdirSync(path.dirname(windowStatePath), { recursive: true });
      fs.writeFileSync(windowStatePath, JSON.stringify({
        bounds,
        isMaximized,
        isFullScreen
      }, null, 2));
    } catch (error) {
      console.warn('Failed to persist window state:', error);
    }
  }

  async function createWindow() {
    serverPort = await startServer(PORT);
    const firstRun = !tutorialDone();
    const initialBounds = getResponsiveWindowBounds();
    const savedState = readWindowState();

    const primaryDisplay = screen.getPrimaryDisplay();
    const scaleFactor = primaryDisplay.scaleFactor;

    app.setAppUserModelId('com.ware.player');
    mainWindow = new BrowserWindow({
      x: initialBounds.x,
      y: initialBounds.y,
      width: initialBounds.width,
      height: initialBounds.height,
      minWidth: 360,
                                   minHeight: 500,
                                   backgroundColor: firstRun ? '#8d5ef2' : '#000000',
                                   title: 'Ware',
                                   icon: path.join(__dirname, 'assets', 'icon.png'),
                                   frame: false,
                                   titleBarStyle: 'hidden',
                                   show: false,
                                   useContentSize: true,
                                   webPreferences: {
                                     preload: path.join(__dirname, 'preload.js'),
                                   additionalArguments: [`--ware-token=${getServerToken()}`],
                                   nodeIntegration: false,
                                   contextIsolation: true,
                                   webSecurity: false,
                                   backgroundThrottling: true,
                                   spellcheck: false
                                   }
    });

    if (savedState?.isMaximized) {
      mainWindow.maximize();
    }

    mainWindow.once('ready-to-show', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.show();
    });

    mainWindow.loadFile(path.join(__dirname, firstRun ? 'welcome.html' : 'index.html'));
    if (firstRun) {
      ipcMain.removeAllListeners('welcome-finish');
      ipcMain.once('welcome-finish', (e, detail) => {
        markTutorialDone();
        if (detail && detail.launcher) installLauncher();
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const result = detail && !detail.skipped ? detail : null;
        mainWindow.setBackgroundColor('#000000');
        mainWindow.webContents.once('did-finish-load', () => { if (result) mainWindow.webContents.send('welcome-result', result); });
        mainWindow.loadFile(path.join(__dirname, 'index.html'));
        require('./updater').initUpdater(() => mainWindow);
      });
    }

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    mainWindow.on('minimize', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-visibility', false);
        if (global.gc) global.gc();
      }
    });

    mainWindow.on('blur', () => {
      if (global.gc) global.gc();
    });

    mainWindow.on('restore', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-visibility', true);
      }
    });

    mainWindow.on('hide', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-visibility', false);
      }
    });

    mainWindow.on('show', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-visibility', true);
      }
    });
    mainWindow.on('resize', persistWindowState);
    mainWindow.on('move', persistWindowState);
    mainWindow.on('maximize', persistWindowState);
    mainWindow.on('unmaximize', persistWindowState);
    mainWindow.on('enter-full-screen', persistWindowState);
    mainWindow.on('leave-full-screen', persistWindowState);
    mainWindow.on('close', (e) => {
      persistWindowState();
      if (trayOnClose && tray && !isQuitting) {
        e.preventDefault();
        mainWindow.hide();
      }
    });

    discordRPC.initRPC();
  }

  ipcMain.removeHandler('get-server-port');
  ipcMain.removeHandler('discord-rpc-get-enabled');
  ipcMain.removeHandler('discord-rpc-get-connected');
  ipcMain.removeHandler('pick-media');
  ipcMain.removeHandler('import-audio-files');

  ipcMain.on('window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

    ipcMain.on('window-maximize', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
      }
    });

    ipcMain.on('window-close', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });

    ipcMain.on('open-external', (e, u) => {
      if (/^https:\/\/accounts\.spotify\.com\//.test(String(u))) shell.openExternal(u);
    });

    let mainLogCount = 0;
    let mainLogReset = Date.now();
    ipcMain.on('log-error', (e, data) => {
      const now = Date.now();
      if (now - mainLogReset > 60000) {
        mainLogReset = now;
        mainLogCount = 0;
      }
      if (mainLogCount < 20) {
        mainLogCount++;
        if (data && typeof data === 'object') {
          logger.log(data.level || 'ERROR', data.message || '', data.stack || null);
        }
      }
    });

    ipcMain.handle('get-diagnostics', async () => {
      const lines = [`Ware ${app.getVersion()}`, `OS ${process.platform} ${process.arch} ${os.release()}`, `Electron ${process.versions.electron} Chromium ${process.versions.chrome} Node ${process.versions.node}`, `Locale ${app.getLocale()}`, `Data ${DATA_DIR}`];
      for (const name of ['yt-dlp', 'ffmpeg']) {
        const bin = resolveBinary(name);
        lines.push(`${name}: ${bin || 'NOT FOUND'}`);
      }
      lines.push('--- last log lines ---', ...tail(60));
      return lines.join('\n');
    });
    ipcMain.on('open-logs-folder', () => { shell.openPath(LOG_DIR); });

      ipcMain.handle('get-server-port', () => serverPort);
      ipcMain.handle('get-gpu-compositing', () => { try { return String(app.getGPUFeatureStatus().gpu_compositing || ''); } catch (e) { return ''; } });
      ipcMain.handle('launcher-info', () => getLauncherInfo());
      ipcMain.handle('get-audio-output-info', async () => getSystemAudioOutputInfo());
      require('./themes').register(() => mainWindow);
      require('./plugins').register(() => mainWindow);

      ipcMain.on('discord-rpc-update', (event, trackInfo) => {
        discordRPC.updatePresence(trackInfo);
      });

      ipcMain.on('discord-rpc-clear', () => {
        discordRPC.clearPresence();
      });

      ipcMain.on('discord-rpc-set-enabled', (event, enabled) => {
        discordRPC.setEnabled(enabled);
      });

      ipcMain.handle('discord-rpc-get-enabled', () => discordRPC.getEnabled());
      ipcMain.handle('discord-rpc-get-connected', () => discordRPC.getConnected());

      ipcMain.handle('get-cache-size', async () => {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const { session } = require('electron');

        let webSize = 0;
        try { webSize = await session.defaultSession.getCacheSize(); } catch(e) {}

        let audioSize = 0;
        const tracksDir = require('./platform').CACHE_DIR;
        const thumbnailsDir = require('./platform').THUMBNAILS_DIR;
        const audioExtRegex = /\.(opus|webm|m4a|mp3)$/i;
        try {
          if (fs.existsSync(tracksDir)) {
            for (const file of fs.readdirSync(tracksDir)) {
              if (audioExtRegex.test(file)) {
                try { audioSize += fs.statSync(path.join(tracksDir, file)).size; } catch(e) {}
              }
            }
          }
        } catch(e) {}
        try {
          if (fs.existsSync(thumbnailsDir)) {
            for (const file of fs.readdirSync(thumbnailsDir)) {
              try { audioSize += fs.statSync(path.join(thumbnailsDir, file)).size; } catch(e) {}
            }
          }
        } catch(e) {}

        return { audio: audioSize, web: webSize };
      });

      ipcMain.handle('clear-cache', async () => {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const { session } = require('electron');
        
        try { await session.defaultSession.clearCache(); } catch(e) {}
        try { await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }); } catch(e) {}

        const tracksDir = require('./platform').CACHE_DIR;
        const thumbnailsDir = require('./platform').THUMBNAILS_DIR;
        const audioExtRegex = /\.(opus|webm|m4a|mp3)$/i;
        try {
          if (fs.existsSync(tracksDir)) {
            for (const file of fs.readdirSync(tracksDir)) {
              if (audioExtRegex.test(file)) {
                try { fs.unlinkSync(path.join(tracksDir, file)); } catch(e) {}
              }
            }
          }
        } catch(e) {}
        try {
          if (fs.existsSync(thumbnailsDir)) {
            for (const file of fs.readdirSync(thumbnailsDir)) {
              try { fs.unlinkSync(path.join(thumbnailsDir, file)); } catch(e) {}
            }
          }
        } catch(e) {}

        return true;
      });

      ipcMain.handle('pick-media', async () => {
        const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Media', extensions: ['png','jpg','jpeg','webp','gif','mp4','webm'] }] });
        return r.canceled ? null : pathToFileURL(r.filePaths[0]).href;
      });

      ipcMain.handle('import-audio-files', async () => {
        const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Audio', extensions: ['mp3','wav','flac','opus','ogg','oga','m4a','aac','webm','weba'] }] });
        if (r.canceled) return [];
        fs.mkdirSync(LIBRARY_DIR, { recursive: true });
        const out = [];
        for (const src of r.filePaths) {
          const st = fs.statSync(src), ext = path.extname(src).slice(1).toLowerCase();
          const id = 'local_' + crypto.createHash('sha1').update(path.basename(src) + st.size).digest('hex').slice(0, 12);
          const file = `${id}.${ext}`;
          if (!fs.existsSync(path.join(LIBRARY_DIR, file))) await fs.promises.copyFile(src, path.join(LIBRARY_DIR, file));
          out.push({ id, file, ext, name: path.basename(src, path.extname(src)) });
        }
        return out;
      });

      ipcMain.handle('get-data-dir', () => {
        const platform = require('./platform');
        return {
          dir: platform.DATA_DIR,
          defaultDir: platform.DEFAULT_DATA_DIR,
          isCustom: platform.DATA_DIR !== platform.DEFAULT_DATA_DIR
        };
      });

      ipcMain.handle('pick-data-dir', async () => {
        const platform = require('./platform');
        const r = await dialog.showOpenDialog(mainWindow, {
          title: 'Choose music folder',
          defaultPath: platform.DATA_DIR,
          properties: ['openDirectory', 'createDirectory']
        });
        return r.canceled ? null : r.filePaths[0];
      });

      ipcMain.handle('set-data-dir', async (event, payload) => {
        const platform = require('./platform');
        const target = payload && payload.dir ? path.resolve(String(payload.dir)) : null;
        const move = !!(payload && payload.move);
        if (!target) return { ok: false, error: 'No folder selected' };

        const current = path.resolve(platform.DATA_DIR);
        if (target === current) return { ok: true, dir: target, moved: false };

        const rel = path.relative(current, target);
        const insideCurrent = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        const relBack = path.relative(target, current);
        const currentInsideTarget = relBack === '' || (!relBack.startsWith('..') && !path.isAbsolute(relBack));
        if (insideCurrent || currentInsideTarget) {
          return { ok: false, error: 'Choose a folder outside the current music folder' };
        }

        try {
          fs.mkdirSync(target, { recursive: true });
          fs.accessSync(target, fs.constants.W_OK);
        } catch (e) {
          return { ok: false, error: 'That folder is not writable' };
        }

        if (move) {
          try {
            await platform.copyDirContents(current, target);
          } catch (e) {
            return { ok: false, error: 'Could not move files: ' + e.message };
          }
        }

        platform.setDataDir(target);

        if (move) {
          try { await platform.removeDirContents(current); } catch (e) {}
        }

        return { ok: true, dir: target, moved: move };
      });

      const defaultDownloadsDir = () => {
        try { return app.getPath('downloads'); } catch (e) { return null; }
      };

      ipcMain.handle('get-download-dir', () => {
        const platform = require('./platform');
        const def = defaultDownloadsDir();
        const custom = platform.resolveDownloadDir();
        return {
          dir: custom || def,
          defaultDir: def,
          isCustom: !!custom
        };
      });

      ipcMain.handle('pick-download-dir', async () => {
        const platform = require('./platform');
        const r = await dialog.showOpenDialog(mainWindow, {
          title: 'Choose download folder',
          defaultPath: platform.resolveDownloadDir() || defaultDownloadsDir() || undefined,
          properties: ['openDirectory', 'createDirectory']
        });
        return r.canceled ? null : r.filePaths[0];
      });

      ipcMain.handle('set-download-dir', async (event, payload) => {
        const platform = require('./platform');
        const reset = !!(payload && payload.reset);
        if (reset) {
          platform.setDownloadDir(null);
          return { ok: true, dir: defaultDownloadsDir(), reset: true };
        }
        const target = payload && payload.dir ? path.resolve(String(payload.dir)) : null;
        if (!target) return { ok: false, error: 'No folder selected' };
        try {
          fs.mkdirSync(target, { recursive: true });
          fs.accessSync(target, fs.constants.W_OK);
        } catch (e) {
          return { ok: false, error: 'That folder is not writable' };
        }
        platform.setDownloadDir(target);
        return { ok: true, dir: target };
      });

      ipcMain.on('restart-app', () => {
        app.relaunch();
        app.exit(0);
      });

      ipcMain.on('set-tray-on-close', (e, v) => {
        trayOnClose = !!v;
      });

      ipcMain.handle('get-multi-instance', () => !!readStartupConfig().multiInstance);
      ipcMain.on('set-multi-instance', (e, value) => { writeStartupConfig({ multiInstance: !!value }); });

      const MEDIA_KEYS = { MediaPlayPause: 'toggle', MediaNextTrack: 'next', MediaPreviousTrack: 'prev', MediaStop: 'stop' };
      let mediaKeysWanted = true;
      let mediaKeysActive = false;
      const sendMedia = (cmd) => {
        if (process.env.WARE_DEBUG === '1') console.log('[media] globalShortcut', cmd);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('media-command', cmd);
      };
      function unregisterMediaKeys() {
        for (const k of Object.keys(MEDIA_KEYS)) {
          try { globalShortcut.unregister(k); } catch (e) {}
        }
      }
      function registerMediaKeys() {
        if (process.platform !== 'win32') return;
        unregisterMediaKeys();
        if (!mediaKeysWanted || !mediaKeysActive) return;
        for (const [k, cmd] of Object.entries(MEDIA_KEYS)) {
          try {
            if (!globalShortcut.register(k, () => sendMedia(cmd))) {
              console.warn('[media] could not register', k);
            }
          } catch (e) {}
        }
      }
      ipcMain.on('set-media-keys', (e, enabled) => { mediaKeysWanted = !!enabled; registerMediaKeys(); });
      ipcMain.on('media-keys-active', () => { if (!mediaKeysActive) { mediaKeysActive = true; registerMediaKeys(); } });
      powerMonitor.on('resume', registerMediaKeys);
      powerMonitor.on('unlock-screen', registerMediaKeys);
      app.on('will-quit', () => globalShortcut.unregisterAll());

      ipcMain.removeHandler('toggle-mini-window');
      ipcMain.handle('toggle-mini-window', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return false;
        if (!isMiniWindow) {
          isMiniWindow = true;
          preMiniBounds = mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
          if (mainWindow.isMaximized()) mainWindow.unmaximize();
          mainWindow.setMinimumSize(320, 120);
          mainWindow.setSize(380, 160);
          mainWindow.setAlwaysOnTop(true);
          return true;
        } else {
          isMiniWindow = false;
          mainWindow.setAlwaysOnTop(false);
          mainWindow.setMinimumSize(360, 500);
          if (preMiniBounds) {
            mainWindow.setBounds(clampBoundsToDisplay(preMiniBounds));
          } else {
            mainWindow.setSize(1000, 700);
          }
          return false;
        }
      });

      function setupTray() {
        try {
          const iconPath = path.join(__dirname, 'assets', 'icon.png');
          let trayIcon = nativeImage.createFromPath(iconPath);
          trayIcon = trayIcon.resize({ width: 22, height: 22 });
          tray = new Tray(trayIcon);
          tray.setToolTip('Ware');
          const contextMenu = Menu.buildFromTemplate([
            {
              label: 'Show/Hide',
              click: () => {
                if (!mainWindow || mainWindow.isDestroyed()) return;
                if (mainWindow.isVisible()) mainWindow.hide();
                else { mainWindow.show(); mainWindow.focus(); }
              }
            },
            {
              label: 'Play/Pause',
              click: () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('media-command', 'toggle');
                }
              }
            },
            { type: 'separator' },
            {
              label: 'Quit',
              click: () => {
                isQuitting = true;
                app.quit();
              }
            }
          ]);
          tray.setContextMenu(contextMenu);
          tray.on('click', () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            if (mainWindow.isVisible()) mainWindow.hide();
            else { mainWindow.show(); mainWindow.focus(); }
          });
        } catch (err) {
          console.warn('Tray creation failed:', err);
          tray = null;
        }
      }

      app.on('before-quit', () => {
        isQuitting = true;
      });

      app.whenReady().then(() => {
        setupTray();
        createWindow();
        if (tutorialDone()) require('./updater').initUpdater(() => mainWindow);
        app.on('activate', () => {
          if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
      });

      app.on('window-all-closed', () => {
        discordRPC.destroyRPC();
        if (process.platform !== 'darwin') app.quit();
      });
}
