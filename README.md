# VTR OT System

Online OT planning, request, approval, actual hours and payroll summary for the plant.

- **Planner:** the production plan comes from the planning workbook (Plan2026-930) twice a day; OT per person is calculated from the plan and the machine rates.
- **Department manager:** requests OT (filled in from the plan), edits and resends, enters actual run hours.
- **Division manager:** approves, sends back or rejects; green / yellow / red against the calculation, with the reason.
- **Plant manager:** approves the whole day; dashboard by division.
- **Accountant / HR:** uploads the daily fingerprint export, checks OT against the scans, downloads the payroll CSV.
- **Admin:** settings, machines and rates, user list from the HR authorization sheet, data import and backup.

The page is a single `index.html` served by GitHub Pages. Data and sign-in are in Google Firebase (Firestore + Authentication).
No company data is stored in this repository; it is loaded into Firestore by an admin.

## Setup

### 1. Firebase project
1. Go to <https://console.firebase.google.com> → **Add project** (for example `vtr-ot`).
2. **Build → Firestore Database → Create database**, location `asia-southeast1`, production mode.
3. **Build → Authentication → Get started → Google → Enable**.
4. **Authentication → Settings → Authorized domains → Add domain**: `pongpong-bam26161.github.io`.
5. **Project settings → Your apps → Web app** → copy the config into [`firebase-config.js`](firebase-config.js).
6. **Firestore → Rules**: paste the contents of [`firestore.rules`](firestore.rules) → **Publish**.
7. **Firestore → Data → Start collection** `users`, document ID = your company email in lower case, with fields:
   - `roleNames` (array): `Admin`
   - `active` (boolean): `true`
   - `depts` (array, empty), `divisions` (array, empty)

   This first admin can then load everyone else from the HR sheet.

### 2. GitHub Pages
**Settings → Pages → Build and deployment → Deploy from a branch → `main` / root → Save.**
The app is then at <https://pongpong-bam26161.github.io/VTR-OT-SYSTEM/>.

### 3. Load the data (first admin)
1. Open the app and sign in with Google.
2. **Admin → Data → Choose data file**: the `vtr-ot-data.json` file (settings, departments, machines and rates, staff list). It is not in this repository because it contains staff names.
3. **Admin → Users → Choose HR sheet**: the filled HR authorization workbook (Users tab). Only rows with a login email, a role and Active = Yes are loaded.

### 4. Plan sync from the planning files
The script reads three Google Sheets whose links are saved in **Admin → Setup**: Plan2026-930 (Radial), Plan2026-Bias and Capacity VTR (daily capacity per line).

1. Go to <https://script.google.com> → **New project** (name it, for example, *VTR OT plan sync*).
2. Paste [`apps-script/PlanSync.gs`](apps-script/PlanSync.gs) into `Code.gs`. In **Project settings**, tick *Show "appsscript.json" manifest file* and replace it with [`apps-script/appsscript.json`](apps-script/appsscript.json).
3. Set `FIREBASE_PROJECT_ID` at the top of the script.
4. Run **setupTriggers** once and allow the permissions. It syncs right away and then every day around 08:00 and 17:00 (Bangkok time).

The Google account that runs `setupTriggers` must be able to open the three files and be a member of the Firebase project (Google Cloud console → IAM → *Cloud Datastore User* or *Editor*).

How OT hours are worked out:
- **Detailed plan tabs, per machine:** 172 FBM / SBM, 161 (rate by rim size), 162 (43 per 8 h), ply cutting Stock 1–5 and MT1/MT2 (rolls per hour), bead Radial and Bias (as a whole department).
- **Capacity VTR daily tab:** every other line (mixing, calenders, tubbers, belt, gum calender, cap ply, Searim, MT, band building, curing, uniformity) uses the planner's working hours for that date and shift. Curing runs 12 h, so 4 h OT per shift.
- Working hours are rounded up to the next whole hour; OT = working hours − normal hours.

## Roles and permissions
Enforced by [`firestore.rules`](firestore.rules), using the user list loaded from the HR sheet:

| Role | Can |
|---|---|
| Department manager | Create, edit, resend and withdraw requests for their own departments; enter actual hours |
| Division manager | Approve, send back or reject requests of their division |
| Plant manager | Approve the whole day or send it back |
| Planner | Edit production plans |
| Accountant / HR | Upload fingerprint scans, payroll summary |
| Admin | Everything, including settings and users |

## Files
| File | What it is |
|---|---|
| `index.html` | The app |
| `firebase-config.js` | Firebase web config (not secret) |
| `firestore.rules` | Database permissions |
| `apps-script/` | Plan sync script for the planning workbook |
