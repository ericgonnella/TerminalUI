# PGManager → Netlify App Integration Spec

## Goal

After PGManager creates a local PostgreSQL instance on the VPS, configure it so a Netlify-hosted frontend can safely use it through a backend API.

The intended architecture is:

```text
Netlify frontend → VPS backend API → local PGManager PostgreSQL instance
```

The frontend should **not** connect directly to PostgreSQL.

---

## Starting Point

PGManager has already created a PostgreSQL instance like this:

```text
Instance: TrackerTest
Port: 5434
PostgreSQL: 17.9
Admin user: postgres
Data dir: /home/eric/.pgmanager/data/TrackerTest

Admin connection URL:
postgresql://postgres:<admin-password>@127.0.0.1:5434/postgres

psql:
psql -h 127.0.0.1 -p 5434 -U postgres -d postgres
```

At this point, the PostgreSQL server exists and is running locally on the VPS.

---

## Important Rules

1. PostgreSQL should stay bound to `127.0.0.1`.
2. Do **not** expose port `5434` publicly.
3. Do **not** put the PostgreSQL URL in Netlify frontend environment variables.
4. Do **not** use the `postgres` superuser inside the application.
5. Create a dedicated app database and app user.
6. The backend API running on the VPS should own the `DATABASE_URL`.

---

## Required Next Step

Create a dedicated database and app user for the project.

Example target:

```text
Database: tracker_test
User: tracker_app
Host: 127.0.0.1
Port: 5434
```

The resulting app database URL should look like this:

```env
DATABASE_URL=postgresql://tracker_app:<generated-password>@127.0.0.1:5434/tracker_test
```

---

## Idempotent Setup Commands

Use these commands on the VPS after the PGManager instance is created.

```bash
read -s -p "Postgres admin password: " PG_SUPERPASS; echo
export PGPASSWORD="$PG_SUPERPASS"

psql -h 127.0.0.1 -p 5434 -U postgres -d postgres -c "select version();"
```

Then create the app DB/user:

```bash
APP_DB=tracker_test
APP_USER=tracker_app
APP_PASS=$(openssl rand -hex 24)

psql -h 127.0.0.1 -p 5434 -U postgres -d postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$APP_USER') THEN
      CREATE ROLE $APP_USER LOGIN PASSWORD '$APP_PASS';
   ELSE
      ALTER ROLE $APP_USER WITH PASSWORD '$APP_PASS';
   END IF;
END
\$\$;
SQL

psql -h 127.0.0.1 -p 5434 -U postgres -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = '$APP_DB'" | grep -q 1 \
  || createdb -h 127.0.0.1 -p 5434 -U postgres -O "$APP_USER" "$APP_DB"

echo "SAVE THIS DATABASE_URL:"
echo "postgresql://${APP_USER}:${APP_PASS}@127.0.0.1:5434/${APP_DB}"
```

Validate:

```bash
psql "postgresql://tracker_app:<generated-password>@127.0.0.1:5434/tracker_test" \
  -c "select current_database(), current_user, now();"
```

Expected result:

```text
current_database | tracker_test
current_user     | tracker_app
```

---

## Backend API Requirements

The VPS backend API should use:

```env
DATABASE_URL=postgresql://tracker_app:<password>@127.0.0.1:5434/tracker_test
PORT=3100
CORS_ORIGIN=https://your-netlify-site.netlify.app
```

The backend should connect to Postgres using the app user, not the admin user.

Example Node packages:

```bash
npm install express cors pg dotenv
```

Minimum backend behavior:

```text
GET /api/health
Returns basic API status.

GET /api/db-health
Runs SELECT current_database(), current_user, now();
Returns result as JSON.
```

---

## Example Backend DB Connection

```js
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
```

Example health route:

```js
app.get("/api/db-health", async (req, res) => {
  try {
    const result = await pool.query(
      "select current_database(), current_user, now();"
    );

    res.json({
      ok: true,
      database: result.rows[0].current_database,
      user: result.rows[0].current_user,
      time: result.rows[0].now,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
```

---

## Netlify Requirements

Netlify should only receive the public API URL.

Example Netlify env:

```env
VITE_API_BASE_URL=https://api.yourdomain.com
```

Do **not** put this in Netlify:

```env
DATABASE_URL=postgresql://...
```

That would expose database access to the wrong layer of the app.

---

## Frontend Usage

Frontend should call the API:

```js
const API_BASE = import.meta.env.VITE_API_BASE_URL;

const res = await fetch(`${API_BASE}/api/db-health`);
const data = await res.json();

console.log(data);
```

The browser never sees the Postgres credentials.

---

## VPS Network Requirement

Confirm Postgres is local only:

```bash
sudo ss -lntp | grep 5434
```

Expected:

```text
127.0.0.1:5434
```

Not:

```text
0.0.0.0:5434
```

If it shows `0.0.0.0`, fix the PGManager/Postgres config so it binds only to localhost.

---

## Deployment Requirement

The backend API should be run as a service, ideally with systemd or PM2.

Example PM2:

```bash
npm install -g pm2
pm2 start server.js --name tracker-api
pm2 save
pm2 startup
```

Then put Nginx, Caddy, Coolify, or another reverse proxy in front of it:

```text
https://api.yourdomain.com → http://127.0.0.1:3100
```

---

## Final Validation Checklist

After setup, confirm:

```bash
psql "postgresql://tracker_app:<password>@127.0.0.1:5434/tracker_test" \
  -c "select current_database(), current_user, now();"
```

Then confirm the backend can reach DB:

```bash
curl http://127.0.0.1:3100/api/db-health
```

Then confirm public API works:

```bash
curl https://api.yourdomain.com/api/db-health
```

Then confirm Netlify frontend has:

```env
VITE_API_BASE_URL=https://api.yourdomain.com
```

---

## Summary

PGManager handles:

```text
Create local Postgres instance
Assign port
Store data directory
Start/stop the instance
Provide admin connection details
```

The integration layer must handle:

```text
Create app database
Create app database user
Generate DATABASE_URL
Store DATABASE_URL in VPS backend .env
Expose only backend API to Netlify
Keep PostgreSQL private on 127.0.0.1
Validate DB through API health endpoint
```

Final working model:

```text
Netlify frontend
    ↓
https://api.yourdomain.com
    ↓
VPS backend API
    ↓
postgresql://tracker_app:<password>@127.0.0.1:5434/tracker_test
```
