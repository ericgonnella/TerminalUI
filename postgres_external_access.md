# PostgreSQL External Access Setup (VPS)

## 1. Allow PostgreSQL to Listen Externally
Edit:
sudo nano /etc/postgresql/15/main/postgresql.conf

Change:
listen_addresses = '*'

---

## 2. Allow Client IP (pg_hba.conf)
Edit:
sudo nano /etc/postgresql/15/main/pg_hba.conf

Add:
host    all    all    YOUR_IP/32    md5

---

## 3. Open Firewall Port
sudo ufw allow 5434/tcp

---

## 4. Restart PostgreSQL
sudo systemctl restart postgresql

---

## 5. Connect from Local Machine
psql -h YOUR_VPS_IP -p 5434 -U spooky -d postgres

---

## Optional: SSH Tunnel (Recommended)
ssh -L 5434:127.0.0.1:5434 spooky@YOUR_VPS_IP

Then connect locally:
psql -h 127.0.0.1 -p 5434 -U spooky -d postgres

---

## Notes
- Replace YOUR_IP with your public IP
- Replace YOUR_VPS_IP with your server IP
- Avoid exposing database publicly unless necessary
