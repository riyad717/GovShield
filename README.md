# GovShield – restricted-access demo project

This package updates the supplied GovShield project so users must log in, and new users can self-register only if their details match the demo NID database. It uses the project's existing Python + SQLite backend; it does not connect to Supabase.

## Run

1. Install Python 3.8 or newer.
2. Open this folder in VS Code.
3. Open Terminal and run:

   ```bash
   python server.py
   ```

   On Windows, `py server.py` may be used.
4. Open http://localhost:8000. The login screen is shown first.

## Demo login credentials

All records below are fictional test identities. Each login NID is exactly 10 numeric digits. Each account has its own password.

| # | Test NID | Password | Full name |
|---:|---|---|---|
| 1 | `1000000001` | `GovDemo#0001` | Amina Rahman |
| 2 | `1000000002` | `GovDemo#0002` | Hasan Mahmud |
| 3 | `1000000003` | `GovDemo#0003` | Nusrat Jahan |
| 4 | `1000000004` | `GovDemo#0004` | Tanvir Ahmed |
| 5 | `1000000005` | `GovDemo#0005` | Fatema Akter |
| 6 | `1000000006` | `GovDemo#0006` | Sakib Hossain |
| 7 | `1000000007` | `GovDemo#0007` | Mim Sultana |
| 8 | `1000000008` | `GovDemo#0008` | Imran Kabir |
| 9 | `1000000009` | `GovDemo#0009` | Sadia Islam |
| 10 | `1000000010` | `GovDemo#0010` | Arif Hossain |
| 11 | `1000000011` | `GovDemo#0011` | Jannat Ara |
| 12 | `1000000012` | `GovDemo#0012` | Mehedi Hasan |
| 13 | `1000000013` | `GovDemo#0013` | Rafiq Uddin |
| 14 | `1000000014` | `GovDemo#0014` | Sumaiya Noor |
| 15 | `1000000015` | `GovDemo#0015` | Abdullah Karim |

## Self-registration

Click **Register** (top menu or the link under the login form). Enter NID, full name, phone number and a password.
Registration succeeds only if the NID, full name and phone number all match one record in the `nid_registry` table (the demo NID database). Name matching ignores capitals and extra spaces; phone numbers may be typed with or without `+88`.

Demo NID database records that can register (fictional, no account yet):

| NID | Full name | Phone |
|---|---|---|
| `1000000016` | Rubina Yasmin | `01700000016` |
| `1000000017` | Kamrul Islam | `01700000017` |
| `1000000018` | Shirin Sultana | `01700000018` |
| `1000000019` | Nayeem Chowdhury | `01700000019` |
| `1000000020` | Lutfa Begum | `01700000020` |
| `1000000021` | Faisal Ahmed | `01700000021` |
| `1000000022` | Tahmina Khatun | `01700000022` |
| `1000000023` | Shahriar Alam | `01700000023` |
| `1000000024` | Ruma Akter | `01700000024` |
| `1000000025` | Omar Faruk | `01700000025` |

The 15 identities above (1000000001-1000000015) are also in the registry, but they already have accounts, so registering them returns "account already exists".
To add more test identities, insert rows into `nid_registry` (edit `EXTRA_REGISTRY` in `server.py`, or use any SQLite tool). View it with `python server.py sql "SELECT * FROM nid_registry"`.

## How access control works

- `authorized_users` is created automatically in `govshield.db` on first startup.
- Exactly 15 fictional test accounts are seeded if that table is empty.
- Passwords are stored as PBKDF2-HMAC-SHA256 hashes with per-user random salts, not plaintext.
- Registration is checked on the server (`/api/register`); a mismatch gives one generic error, no account is created, and attempts are limited to 10 per 10 minutes per IP.
- The login API requires an exactly 10-digit numeric NID and checks the NID and password on the server. The browser cannot grant itself access.
- Application and payment APIs require a server-issued session token.
- Login tokens are signed with a secret key and last 8 hours. Nothing is stored per session, so a server restart or a Render wake-up does not log anyone out. Set `GOVSHIELD_SECRET` on a real server to a private value.
- Use `Logout` in the portal to end the current session.

## Important limitations

This is a local classroom/demo implementation, not a production government identity system. The 15 users are fictional placeholders, not verified citizens. The server listens on `127.0.0.1` by default. Do not expose it publicly or enter real NID, phone, or address data. A real deployment needs HTTPS, secure persistent sessions, rate limiting, audit logging, account recovery controls, backups, and an authorized source for user eligibility.

## Apply, Track, Pay and Documents

These pages now work and are served from `js/` and `css/`:

- **Apply Online** (`js/apply.js`): saves the application to the database. Name and NID are pre-filled from your login.
- **Track Application** (`js/track.js`): lists applications with search, status filter, counters and a detail view.
- **Pay Bills & Taxes** (`js/pay.js`): saves the payment and shows the transaction ID and payment history.
- **Official Documents** (`js/documents.js`): every application is listed; once its status is Approved, Download saves a demo certificate (HTML file, printable to PDF).

`js/api.js` and `js/helpers.js` hold shared code. The original versions of these files were not supplied, so they were rewritten.

## Administrator Console (separate from the citizen portal)

The administrator console is a separate page at `/admin.html`. The citizen portal does not link to it. Administrators log in there with their own username and password, and the console reads live data from the server:

- **Overview**: six KPI tiles (citizens, applications, payments, logins today, failed logins today, security alerts), four charts (14-day activity, application status, applications by service, payments by method) and the latest activity.
- **Applications**: search, status and service filters, paging, and a details window with the application's timeline and its activity history. An administrator can change the status there.
- **Payments**: search, method filter, paging and totals in BDT.
- **Citizens**: masked NID and phone, application and payment counts, total paid and last login. The **Activity** button opens the activity log for that citizen.
- **Activity log**: every recorded action, with filters for citizen, action and result. Each row shows the IP address, detail and severity.
- **Security**: failed logins by address and the High-severity alerts.
- **Export CSV** on each tab downloads the full list for that tab.
- The page refreshes every 15 seconds while it is open and redraws only when the data changes.
- Recorded actions: Register, Login, Logout, Track (viewing the application list), Application, Payment, Document (download), Status (administrator change), Admin login and Admin logout.
- Administrators have their own accounts (table `admin_users`) and their own sessions. Citizen logins are refused on the administrator page, and administrator logins are refused on the citizen portal.
- The administrator is set by the `GOVSHIELD_ADMIN_USER` variable (default `admin`) and the `GOVSHIELD_ADMIN_PASSWORD` variable. The password is applied on every start. The fallback `GovAdmin#2026` is for the local demo only, so set your own password on the server.
- Charts use Chart.js from a CDN, so they need an internet connection. Without it the tables still work and the chart areas show a short note.
- Admin data comes from `/api/admin/overview`, `/api/admin/applications`, `/api/admin/payments`, `/api/admin/citizens` and `/api/admin/audit`. The status change is `POST /api/admin/applications/<id>/status`. The citizen activity endpoint is `POST /api/activity`.
- Login tokens for citizens and administrators are signed and last 8 hours. Logout is recorded in the `revoked_sessions` table. On Render's free plan the local database (accounts, applications, payments) is still reset on a restart, redeploy or spin-down, but login tokens keep working as long as the demo account exists.
- Administrator login is `POST /api/admin/login`, the session check is `GET /api/admin/me` and logout is `POST /api/admin/logout`. Citizen and administrator tokens are signed with different kinds, so one can never open the other's pages.
- Frontend code is in `admin.html`, `js/admin.js` and `css/admin.css`. Backend code is in `server.py`: the `admin_users` and `audit_log` tables, `record_audit`, the `admin_*` helpers and `_admin_api`.
- Older databases are upgraded on start. The `detail` column is added to `audit_log`, and the `payer_nid` column to `payments`. Payments made before this upgrade have no payer link, so they count toward totals but not toward a citizen's record.
