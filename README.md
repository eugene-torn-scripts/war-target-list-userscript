# War Target List

A userscript for the faction war page of [Torn](https://www.torn.com). It shows 39th calls, live
statuses and FFScouter battle stats in Torn's own war list. Your faction must use 39th
(ultimata.net) for calls.

**[Install War Target List](https://raw.githubusercontent.com/eugene-torn-scripts/war-target-list-userscript/main/war-target-list.user.js)** (version 0.6.9)

## What it does

- Call and uncall targets on 39th from the war list. The button shows **Call**, **You**, or the
  name of the member who called the target.
- Live statuses from Torn, with hospital timers. Rows move at once when a status changes. The
  default sort puts Okay targets first, then the shortest hospital time.
- The targets that leadership assigned to you on 39th are highlighted, with their order.
- FFScouter battle stats and fair fight. If you use FF Scouter V2, the list uses its column.
- Beeps before a target that you called leaves hospital, when you get a new assigned target, and
  before 39th drops your call.
- Filters for stats, fair fight and player ids, and a column that shows when each player was last
  seen.
- Desktop and phone layouts, in Torn's light and dark themes.

## Install

- **On a computer, use [Violentmonkey](https://violentmonkey.github.io/)**: open the install link
  above, then confirm. Calls are faster there than in Tampermonkey (see
  [Faster calls on a computer](#faster-calls-on-a-computer)).
- **Tampermonkey** (version 5.3.2 or later) also works, but each call takes about 0.13 s longer.
- **Torn PDA**: add a new userscript, paste the content of
  [war-target-list.user.js](war-target-list.user.js), and check that its injection time is
  **Start**.

All three apps check the link in the script for new versions.

## Faster calls on a computer

Tampermonkey holds each request for about 0.1 s before it sends it, so each call takes about
0.13 s longer than in Violentmonkey or Torn PDA. When the script finds this delay, the bar shows a
notice with a **How to move** link to this section. Violentmonkey is available for Chrome, Edge
and Firefox, but not for Safari.

1. Install Violentmonkey from your browser's extension store.
2. In Chrome or Edge, open the extensions page, open **Details** of Violentmonkey, and turn on
   **Allow User Scripts**. In older versions, turn on **Developer mode** instead.
3. In Tampermonkey, delete War Target List. You can keep your other scripts in Tampermonkey: both
   managers can run at the same time.
4. Open the install link above and confirm in Violentmonkey. If Tampermonkey also opens an install
   page, close it.
5. Reload the faction war page. Violentmonkey keeps its own settings, so paste your Torn API key in
   Settings again and tap **Log in**.
6. Make sure that the bar shows **39th live** and **Torn live**.

## First start

1. Open the faction war page.
2. The Settings panel opens. Paste a Torn API key with **public** access, then tap **Log in**. The
   key logs you in to 39th.
3. Optional: paste an FFScouter key in Settings. You do not need it if you use FF Scouter V2.

## The bar

- **39th live**: the script is connected to 39th.
- **Torn live**: the script gets Torn's live status updates. **Torn not live** means that the script
  started too late: in Torn PDA, set the injection time to **Start**, then reload the page.
- **Calls slow**: your userscript manager sends one request at a time, so your calls can wait up to
  25 s. Move the script to Violentmonkey (see
  [Faster calls on a computer](#faster-calls-on-a-computer)), then reload the page.
- A notice says how much slower Tampermonkey makes each call, with a link to the steps above.
  **Hide** keeps it away.

## Your data

- Your Torn API key stays on your device. The script sends it only to 39th (ultimata.net), to log
  you in.
- The script talks to ffscouter.com only if you give it an FFScouter key.
- The script sends no data to any other place.
