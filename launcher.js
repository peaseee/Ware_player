const { app, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const NAME = 'Ware';
const COMMENT = 'Ware - music player';
const APP_ID = '';

function winShortcutPath() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${NAME}.lnk`);
}

function linuxDesktopPath() {
  return path.join(os.homedir(), '.local', 'share', 'applications', 'ware.desktop');
}

function linuxIconPath() {
  return path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor', '512x512', 'apps', 'ware.png');
}

function getLauncherInfo() {
  if (process.platform === 'win32') {
    if (!app.isPackaged) return { platform: 'win32', canInstall: false, installed: false, reason: 'Available in the installed app' };
    return { platform: 'win32', canInstall: true, installed: fs.existsSync(winShortcutPath()), reason: '' };
  }
  if (process.platform === 'linux') {
    if (!process.env.APPIMAGE) return { platform: 'linux', canInstall: false, installed: false, reason: 'Available when Ware runs as an AppImage' };
    return { platform: 'linux', canInstall: true, installed: fs.existsSync(linuxDesktopPath()), reason: '' };
  }
  return { platform: process.platform, canInstall: false, installed: false, reason: 'Not supported on this system' };
}

function installWindows() {
  const lnk = winShortcutPath();
  if (fs.existsSync(lnk)) return { ok: true };
  const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  fs.mkdirSync(path.dirname(lnk), { recursive: true });
  const options = { target, cwd: path.dirname(target), description: COMMENT, icon: target, iconIndex: 0 };
  if (APP_ID) options.appUserModelId = APP_ID;
  return { ok: shell.writeShortcutLink(lnk, 'create', options) };
}

function quoteExec(file) {
  return '"' + file.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%') + '"';
}

function installLinux() {
  const image = process.env.APPIMAGE;
  if (!image) return { ok: false };
  try { fs.chmodSync(image, 0o755); } catch (e) {}
  const desktop = linuxDesktopPath();
  const iconDest = linuxIconPath();
  let icon = 'audio-x-generic';
  try {
    fs.mkdirSync(path.dirname(iconDest), { recursive: true });
    fs.writeFileSync(iconDest, fs.readFileSync(path.join(__dirname, 'assets', 'icon.png')));
    icon = iconDest;
  } catch (e) {}
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${NAME}`,
    'GenericName=Music Player',
    `Comment=${COMMENT}`,
    `Exec=${quoteExec(image)} %U`,
    `TryExec=${image}`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=AudioVideo;Audio;Player;Music;',
    `StartupWMClass=${app.getName()}`,
    'StartupNotify=true',
    ''
  ];
  fs.mkdirSync(path.dirname(desktop), { recursive: true });
  fs.writeFileSync(desktop, lines.join('\n'));
  fs.chmodSync(desktop, 0o755);
  execFile('update-desktop-database', [path.dirname(desktop)], () => {});
  return { ok: true };
}

function installLauncher() {
  try {
    if (!getLauncherInfo().canInstall) return { ok: false };
    if (process.platform === 'win32') return installWindows();
    if (process.platform === 'linux') return installLinux();
  } catch (e) {}
  return { ok: false };
}

module.exports = { getLauncherInfo, installLauncher };
