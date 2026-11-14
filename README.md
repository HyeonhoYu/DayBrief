# DayBrief

A small desktop app for Mac and Windows that puts your day on one screen:
Outlook meetings, to-dos, and upcoming birthdays and anniversaries.
The first time you open your laptop each day, it pops up in front of every
other window and stays there until you click **Start my day**.

## What it does

- **Today**: your meetings (from Outlook plus any you add by hand), tasks that are due or overdue, and the next birthdays and anniversaries with a D-day countdown.
- **Tasks**: quick add with due date and priority, grouped into Overdue, Today, Tomorrow, This week, Later.
- **Next 7 days**: meetings, due tasks and special dates side by side.
- **Birthdays & dates**: yearly dates with optional birth or wedding year, so it can say "Turns 40" or "10th anniversary".
- **Morning popup**: opens at login and again the first time you wake or unlock the laptop each day.
- **Meeting notifications** a few minutes before each meeting.
- Lives in the menu bar (Mac) or system tray (Windows). Closing the window just hides it.

All data stays on your own computer. Use **Settings > Backup** to move it to another machine.

## Connect Outlook

1. Open Outlook on the web (outlook.office.com), click the gear icon.
2. **Calendar > Shared calendars > Publish a calendar**.
3. Pick your calendar and a permission level, click **Publish**, then copy the **ICS** link.
4. Paste it in DayBrief under **Settings > Outlook calendar**.

DayBrief only reads the calendar. Keep the link private, since anyone with it can view your calendar.
Some university or company accounts turn publishing off; if the Publish option is missing, ask IT or add meetings by hand.
Google Calendar and iCloud links also work.

## Install (for colleagues)

Download the installer for your system from the latest build:

- **Mac**: open `DayBrief-x.y.z-universal.dmg` and drag DayBrief to Applications. The app is not signed with an Apple developer certificate, so the first time, right-click DayBrief in Applications and choose **Open**, then **Open** again. (Or System Settings > Privacy & Security > **Open Anyway**.)
- **Windows**: run `DayBrief Setup x.y.z.exe`. If SmartScreen appears, click **More info > Run anyway**.

## Run from source

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

## Build the installers

The easiest way is GitHub Actions, which builds both versions for free:

1. Push this folder to a GitHub repository.
2. Go to **Actions > Build installers > Run workflow**.
3. When it finishes, download `DayBrief-macOS` and `DayBrief-Windows` from the run's Artifacts.

To build locally instead: `npm run dist:mac` on a Mac, `npm run dist:win` on Windows.

## One-file HTML version

`python3 tools/build-html.py DayBrief.html` bundles the same screens and cat images into a single HTML file that runs in any browser (no Outlook sync or always-on-top popup).
