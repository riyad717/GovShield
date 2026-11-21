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
- Sessions are held in server memory for 8 hours and are cleared when the server restarts.
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

## Security Admin Dashboard

Open **Admin** from the top menu after logging in. The dashboard reads live data from the server:

- **Total Logins / Failed Logins / Security Alerts** cards and the **Live Audit Logs** table are filled from the `audit_log` table in `govshield.db`.
- The search boxes and dropdowns above the table filter the rows.
- The page refreshes every 10 seconds while it is open.
- The audit log starts empty. It fills as people log in, log out, register, apply and pay.
- Logins are checked against the same rules as before. A 5th failed login from the same address within 10 minutes is marked High severity.
- Admin data is served by `/api/admin/summary` and `/api/admin/audit`. Both need a logged-in session. The demo has no admin roles, so any logged-in demo account can open the dashboard.
- Frontend code is in `js/admin.js`. Backend changes are the `audit_log` table, the `record_audit` / `admin_*` helpers and the `_audit` method in `server.py`.
