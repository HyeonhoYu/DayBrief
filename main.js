// DayBrief: main process
// Runs quietly in the menu bar / system tray and pops the board up
// in front of everything the first time you open your laptop each day.
const {
  app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor,
  Notification, nativeImage, shell, screen
} = require('electron');
const path = require('path');
const fs = require('fs');
const { loadCalendar } = require('./ics');

const isMac = process.platform === 'darwin';
let win = null;
let tray = null;
let quitting = false;
let popupActive = false;
let data = null;
const notified = new Set();

// ---------- storage ----------
const dataFile = () => path.join(app.getPath('userData'), 'daybrief-data.json');

function defaultData() {
  return {
    version: 1,
    todos: [],
    meetings: [],      // meetings you add by hand
    occasions: [],     // birthdays, anniversaries, other yearly dates
    outlook: { events: [], fetchedAt: null, error: null },
    settings: {
      name: '',
      icsUrl: '',
      launchAtLogin: true,
      popupDaily: true,
      popupAfterHour: 5,      // don't pop before 5am (e.g. a midnight wake)
      meetingReminderMin: 10, // 0 = off
      occasionLeadDays: 14,
      lastPopupDate: null
    }
  };
}

function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    const d = defaultData();
    return { ...d, ...raw, settings: { ...d.settings, ...(raw.settings || {}) }, outlook: { ...d.outlook, ...(raw.outlook || {}) } };
  } catch (e) {
    return defaultData();
  }
}

function saveData() {
  try {
    fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
    const tmp = dataFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, dataFile());
  } catch (e) {
    console.error('Save failed', e);
  }
}

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------- window ----------
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1180, width - 80),
    height: Math.min(800, height - 60),
    minWidth: 760,
    minHeight: 560,
    show: false,
    center: true,
    title: 'DayBrief',
    backgroundColor: '#f6f3ee',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      endPopup();
      win.hide();
    }
  });

  // Open links (e.g. Teams/Zoom links) in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:|^msteams:|^zoommtg:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Bring the board in front of every other window and keep it there
// until the user clicks "Start my day".
function showMorningPopup(reason) {
  if (!win) createWindow();
  popupActive = true;
  data.settings.lastPopupDate = todayKey();
  saveData();

  const doShow = () => {
    win.center();
    win.setAlwaysOnTop(true, 'floating');
    if (isMac) {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      app.focus({ steal: true });
      if (app.dock) app.dock.show();
    }
    win.show();
    win.focus();
    win.moveTop();
    win.webContents.send('popup:mode', true);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', doShow);
  else doShow();
  refreshOutlook().catch(() => {});
}

function endPopup() {
  if (!win || !popupActive) return;
  popupActive = false;
  win.setAlwaysOnTop(false);
  if (isMac) win.setVisibleOnAllWorkspaces(false);
  win.webContents.send('popup:mode', false);
}

function maybeDailyPopup(reason) {
  if (!data.settings.popupDaily) return;
  if (data.settings.lastPopupDate === todayKey()) return;
  if (new Date().getHours() < (data.settings.popupAfterHour ?? 5)) return;
  showMorningPopup(reason);
}

// ---------- Outlook / ICS ----------
let refreshing = null;
async function refreshOutlook() {
  const url = data.settings.icsUrl;
  if (!url) {
    data.outlook = { events: [], fetchedAt: null, error: null };
    return data.outlook;
  }
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const events = await loadCalendar(url);
      data.outlook = { events, fetchedAt: new Date().toISOString(), error: null };
    } catch (e) {
      data.outlook = { ...data.outlook, error: e.message || String(e) };
    }
    saveData();
    if (win) win.webContents.send('outlook:updated', data.outlook);
    return data.outlook;
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

// ---------- meeting reminders ----------
function checkReminders() {
  const lead = Number(data.settings.meetingReminderMin) || 0;
  if (!lead || !Notification.isSupported()) return;
  const now = Date.now();
  const all = [...(data.outlook.events || []), ...(data.meetings || []).map(m => ({
    id: m.id, title: m.title, start: localDateTime(m.date, m.time), allDay: !m.time, location: m.location || ''
  }))];
  for (const ev of all) {
    if (ev.allDay || !ev.start) continue;
    const t = new Date(ev.start).getTime();
    const key = `${ev.id}-${t}`;
    if (t - now <= lead * 60000 && t - now > -60000 && !notified.has(key)) {
      notified.add(key);
      const time = new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const n = new Notification({ title: ev.title, body: `${time}${ev.location ? ' · ' + ev.location : ''}`, silent: false });
      n.on('click', showWindow);
      n.show();
    }
  }
}

function localDateTime(date, time) {
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm).toISOString();
}

// ---------- login item ----------
function applyLoginItem() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!data.settings.launchAtLogin,
      args: ['--login']
    });
  } catch (e) { /* not supported in dev on some platforms */ }
}

function openedAtLogin() {
  if (process.argv.includes('--login')) return true;
  try { return isMac && app.getLoginItemSettings().wasOpenedAtLogin; } catch (e) { return false; }
}

// ---------- tray ----------
function trayIcon() {
  if (isMac) {
    const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(path.join(__dirname, 'build', 'tray-win.png'));
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open DayBrief', click: showWindow },
    { label: 'Show morning popup now', click: () => showMorningPopup('manual') },
    { label: 'Refresh Outlook calendar', click: () => refreshOutlook() },
    { type: 'separator' },
    {
      label: 'Open at login', type: 'checkbox', checked: !!data.settings.launchAtLogin,
      click: (item) => { data.settings.launchAtLogin = item.checked; applyLoginItem(); saveData(); }
    },
    {
      label: 'Pop up first thing each day', type: 'checkbox', checked: !!data.settings.popupDaily,
      click: (item) => { data.settings.popupDaily = item.checked; saveData(); }
    },
    { type: 'separator' },
    { label: 'Quit DayBrief', click: () => { quitting = true; app.quit(); } }
  ]);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('DayBrief');
  tray.setContextMenu(buildTrayMenu());
  if (!isMac) tray.on('click', showWindow);
}

// ---------- IPC ----------
ipcMain.handle('data:load', () => data);
ipcMain.handle('data:save', (_e, incoming) => {
  const prevLogin = data.settings.launchAtLogin;
  const prevUrl = data.settings.icsUrl;
  data = { ...data, ...incoming, outlook: data.outlook, settings: { ...data.settings, ...(incoming.settings || {}), lastPopupDate: data.settings.lastPopupDate } };
  saveData();
  if (prevLogin !== data.settings.launchAtLogin) applyLoginItem();
  if (tray) tray.setContextMenu(buildTrayMenu());
  if (prevUrl !== data.settings.icsUrl) refreshOutlook();
  return true;
});
ipcMain.handle('outlook:refresh', () => refreshOutlook());
ipcMain.handle('popup:dismiss', () => { endPopup(); return true; });
ipcMain.handle('popup:test', () => { showMorningPopup('test'); return true; });
ipcMain.handle('app:info', () => ({ platform: process.platform, version: app.getVersion() }));
ipcMain.handle('app:openExternal', (_e, url) => {
  if (/^https?:|^mailto:|^msteams:|^zoommtg:/.test(url)) shell.openExternal(url);
});

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    if (isMac) app.setActivationPolicy('regular');
    data = loadData();
    createWindow();
    createTray();
    applyLoginItem();
    refreshOutlook().catch(() => {});

    const firstRun = !fs.existsSync(dataFile());
    if (firstRun) saveData();

    if (openedAtLogin()) {
      maybeDailyPopup('login');
    } else if (firstRun || data.settings.lastPopupDate !== todayKey()) {
      maybeDailyPopup('launch');
      if (!popupActive) showWindow();
    } else {
      showWindow();
    }

    // Opening the lid / waking the laptop / logging back in.
    const onWake = () => setTimeout(() => {
      refreshOutlook().catch(() => {});
      maybeDailyPopup('wake');
    }, 4000);
    powerMonitor.on('resume', onWake);
    powerMonitor.on('unlock-screen', onWake);
    powerMonitor.on('user-did-become-active', onWake);

    // Safety net: catches a new day if the laptop never slept.
    setInterval(() => maybeDailyPopup('timer'), 5 * 60 * 1000);
    setInterval(() => refreshOutlook().catch(() => {}), 30 * 60 * 1000);
    setInterval(checkReminders, 30 * 1000);
  });

  app.on('activate', showWindow); // clicking the Dock icon
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', (e) => { /* keep running in tray */ });
}
