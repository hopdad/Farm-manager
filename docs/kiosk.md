# Sign-in, the wall kiosk and the cab iPads

How people and screens sign in to Farm Ops (slice 1a, decision D8). Everything here works on
the shop Wi-Fi over plain `http://<pc-ip>:3000` (`pnpm pilot`); nothing needs the internet.

## Who signs in, and how

| Who / what | How | Role |
|---|---|---|
| **The wall display** (shared) | Enrolled once with a one-time code; then anyone at it taps their name and enters their PIN | on its own: viewer; with a PIN: that person's role |
| **Cab and truck iPads** (shared) | Same as the wall | on its own: operator (cab) or driver (truck); with a PIN: that person's role |
| **A crew member's phone** (personal) | A manager adds the phone *for that person*; opening the code on the phone signs it in as them | that person's role |
| **Managers and the owner** on their own phone or computer | Open `/login`, tap their name, enter their PIN | manager / owner |

Roles, lowest first: **viewer** (sees the board, fields, fleet, weather) < **driver** (+ marks
machines down, enters soil temperatures) < **operator** (field crew; like a driver in Phase 1) <
**manager** (+ edits fields and notes, admin pages, people, devices) < **owner** (+ manages
managers and owners). A device on its own is never more than an operator.

PINs are 4 to 8 digits (not `1111`, `1234`, `1212`...). **Five wrong PINs lock that person for
15 minutes**; each further lockout in a row lasts twice as long (30 min, 1 h, ... up to a day),
so nobody can try every PIN. The right PIN, or a manager's **Unlock** on **People**, starts the
count over. Someone signed in on a shared
screen is signed out after 12 hours without use, or when they tap **Switch user**.

## First run: you become the owner

1. `pnpm run bootstrap` (or `pnpm dev`) prints an **Owner** link the first time:
   `http://localhost:3000/login/setup?code=…`. Open it **on the PC**.
2. Enter your name and a PIN only you know. You are now the owner, signed in on that browser.
3. On **People** (`/admin/people`): add your managers and crew and set their PINs (with the
   person standing there; nobody can see a PIN afterwards).
4. The demo farm comes with **demo people** (Amy Kovach is a demo manager, the others crew).
   Their PINs are printed by `pnpm dev`. **Switch them off before real use**: the button on
   People, or `pnpm auth:demo-people --off`.

The **Admin** link `pnpm dev` prints still works on the PC (it is the M0 admin key: owner rights
in that browser only, never in production).

## Enroll the wall display (Windows)

1. On the PC, open **Devices** (`/admin/devices`), add a device: name `Shop wall`, kind
   **Wall display**. The page shows a one-time code, its link and a QR code (valid one hour).
2. Open that link once in the kiosk's own Chrome profile, **without** kiosk mode
   (PowerShell, one line; paste your link):

   ```powershell
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir=$env:LOCALAPPDATA\farm-kiosk "http://localhost:3000/enroll?code=K7QD2M9XPA"
   ```

   Press **Enroll as Shop wall**: the board opens. Close that window.
3. From then on start the wall in kiosk mode with the same profile:

   ```powershell
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --user-data-dir=$env:LOCALAPPDATA\farm-kiosk http://localhost:3000/board
   ```

   The enrollment stays in that profile (renewed every day the board is used). The full kiosk
   flags, start-on-boot and the stale-reload watchdog arrive with the 1g kiosk runbook.

**Signing in at the wall:** tap the name chip at the top right of the board, tap your name,
enter your PIN. The chip shows who is signed in; tap it and **Switch user** when you leave.

## Enroll a cab or truck iPad

1. Join the iPad to the shop Wi-Fi.
2. On **Devices**, add `Cab 2` (kind **Cab iPad**) or `Truck 4` (kind **Truck iPad**). If you
   use the PC's own browser (`localhost`), the page also lists the link on the PC's network
   address: that is the one the iPad can reach.
3. On the iPad, point the **Camera** at the QR code and open the link, then tap **Enroll**. The
   iPad lands on `/m`.
4. Optional: Share, **Add to Home Screen**, and Guided Access (Settings, Accessibility) to keep
   the iPad on the app. If the Home Screen icon opens signed out (iOS can keep a home-screen
   app's cookies apart from Safari's), open `/enroll` from the icon and type the code instead
   (ask for a **New code** if it was already used).

People sign in on the iPad exactly like on the wall: name chip, name, PIN.

## A crew member's phone

On **Devices**, add a device of kind **Phone (personal)** and pick the person under **Phone
owner**. Open the link on their phone (or type the code at `http://<pc-ip>:3000/enroll`). The
phone is now signed in as that person until it is revoked or they are switched off. Managers
and the owner can also simply sign in at `/login` on their own phone with name and PIN.

## Lost, replaced, or someone leaves

- **Lost or replaced device:** Devices, **Revoke**. It is signed out on its next request. To
  move the wall to a new PC, or a crew member to a new phone, use **New code** on the existing
  device: the old browser (the old PC, the lost phone) is signed out when the new one enrolls.
  (A crew phone enrolled before Oct 30, 2026 needs one **New code** after this update.)
- **Someone leaves:** People, **Switch off** (ends all their sessions at once). **Sign out
  everywhere** ends their sessions but leaves them able to sign in again.

## Forgot the owner PIN

On the PC:

```powershell
pnpm auth:reset-owner
```

It prints a one-time link (30 minutes) that sets a new owner PIN, unlocks the owner and signs
out their other sessions. Before the owner exists it prints the first-run link again.
(Until the integration adds the script name, the same command is
`pnpm exec tsx src/platform/auth/cli.ts reset-owner`.)

`pnpm auth:links` prints the sign-in lines `pnpm dev` shows (owner setup or sign-in, Devices,
demo PINs); `pnpm auth:demo-people` creates the demo people and prints their PINs.

## Troubleshooting

| You see | Do |
|---|---|
| "Sign in" page instead of the board | This browser isn't enrolled: enter a code, or sign in as a manager |
| "This browser's sign-in has ended" | The device was revoked or enrolled somewhere else: ask for a **New code** |
| "Too many wrong PINs" | Wait (the page says how long), or a manager taps **Unlock** on People |
| The iPad can't open the link | Use the link with the PC's network address, and allow Node.js through the Windows firewall on private networks (README) |
| "No PIN is set for this person yet" | A manager sets one on People |
