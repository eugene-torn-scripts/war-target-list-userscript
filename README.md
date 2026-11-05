# War Target List

A userscript for the faction war page of [Torn](https://www.torn.com). It shows 39th calls, live
statuses and FFScouter battle stats in Torn's own war list. Your faction must use 39th
(ultimata.net) for calls.

**[Install War Target List](https://raw.githubusercontent.com/eugene-torn-scripts/war-target-list-userscript/main/war-target-list.user.js)** (version 0.6.8)

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

- **Tampermonkey** (version 5.3.2 or later): open the install link above, then confirm.
- **Torn PDA**: add a new userscript, paste the content of
  [war-target-list.user.js](war-target-list.user.js), and check that its injection time is
  **Start**.

Both apps check the link in the script for new versions.

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
  25 s. Update Tampermonkey to 5.3.2 or later, then reload the page.

## Your data

- Your Torn API key stays on your device. The script sends it only to 39th (ultimata.net), to log
  you in.
- The script talks to ffscouter.com only if you give it an FFScouter key.
- The script sends no data to any other place.
