"""Root-only, additive provisioning for the explicitly requested Ubuntu VPS.

Does not alter existing sites, containers, Node installations or PostgreSQL databases.
Secrets are generated on the server, never embedded in source or command arguments.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time

DOMAIN = "crypto-trader.nechek805.org"
CONFIG = Path("/etc/crypto-trader")
ROOT = Path("/opt/crypto-trader")


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def secret_file(path, text, mode=0o600):
    if path.exists():
        raise RuntimeError(f"Refusing to overwrite secret file {path}")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "w") as stream:
        stream.write(text)


def main():
    if os.geteuid() != 0:
        raise RuntimeError("Provisioning needs root")
    CONFIG.mkdir(mode=0o750, exist_ok=True)
    state_file = CONFIG / "deployment.json"
    if state_file.exists():
        raise RuntimeError("Existing Crypto Trader deployment: use the documented update process")
    db_password = secrets.token_urlsafe(36)
    db_admin_password = secrets.token_urlsafe(36)
    reader = secrets.token_urlsafe(48)
    admin = secrets.token_urlsafe(48)
    proxy = secrets.token_urlsafe(48)
    website_password = secrets.token_urlsafe(24)
    secret_file(CONFIG / "db.env", f"POSTGRES_DB=cryptotrader\nPOSTGRES_USER=crypto_admin\nPOSTGRES_PASSWORD={db_admin_password}\n")
    secret_file(CONFIG / "app.env", "\n".join([
        "DATA_MODE=fixture-only", "OPS_MODE=hosted-paper", "LIVE_PAPER_ENABLED=1",
        "LIVE_PAPER_AUTO_DB=0", f"OPS_ALLOWED_ORIGINS=https://{DOMAIN}",
        f"OPS_READ_TOKEN={reader}", f"OPS_ADMIN_TOKEN={admin}", f"OPS_PROXY_SECRET={proxy}",
        f"LIVE_PAPER_DATABASE_URL=postgresql://cryptotrader:{db_password}@127.0.0.1:55439/cryptotrader", "",
    ]))
    hashed = subprocess.check_output(["openssl", "passwd", "-apr1", "-stdin"], input=website_password+"\n", text=True).strip()
    secret_file(CONFIG / "nginx.htpasswd", "operator:"+hashed+"\n", 0o640)
    run(["chown", "root:www-data", str(CONFIG / "nginx.htpasswd")])
    # Deliver this root-readable file privately to the owner; never print it to logs.
    secret_file(CONFIG / "website-access.txt", f"Website: https://{DOMAIN}/live-paper\nUsername: operator\nPassword: {website_password}\n\nKeep this file private. This is a website login, not the SSH root password.\n")
    run(["docker", "network", "create", "crypto-trader"])
    run(["docker", "volume", "create", "crypto-trader-pgdata"])
    run(["docker", "run", "-d", "--name", "crypto-trader-postgres", "--restart", "unless-stopped", "--network", "crypto-trader",
         "--env-file", str(CONFIG / "db.env"), "-p", "127.0.0.1:55439:5432", "-v", "crypto-trader-pgdata:/var/lib/postgresql/data",
         "--memory", "192m", "--memory-swap", "384m", "--health-cmd", "pg_isready -U cryptotrader -d cryptotrader", "--health-interval", "10s", "--health-timeout", "3s", "--health-retries", "10",
         "postgres:17-alpine", "postgres", "-c", "shared_buffers=32MB", "-c", "max_connections=20", "-c", "work_mem=2MB", "-c", "timezone=UTC"])
    for _ in range(30):
        ready = subprocess.run(["docker", "exec", "crypto-trader-postgres", "pg_isready", "-h", "127.0.0.1", "-U", "crypto_admin", "-d", "cryptotrader"], capture_output=True)
        if ready.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError("Dedicated PostgreSQL did not become ready")
    # App owns its database/schema, but cannot administer the cluster or create roles.
    run(["docker", "exec", "-i", "crypto-trader-postgres", "psql", "-U", "crypto_admin", "-d", "cryptotrader", "-v", "ON_ERROR_STOP=1"],
        input=f"CREATE ROLE cryptotrader LOGIN PASSWORD '{db_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;\nALTER DATABASE cryptotrader OWNER TO cryptotrader;\n", text=True)
    webroot = Path("/var/www/crypto-trader-acme")
    (webroot / ".well-known/acme-challenge").mkdir(parents=True, exist_ok=True)
    vhost = Path("/etc/nginx/sites-available") / DOMAIN
    if vhost.exists():
        raise RuntimeError("Requested nginx hostname already has a configuration")
    http = f"""# Crypto Trader managed vhost; unrelated sites are unchanged.
server {{
    listen 80;
    server_name {DOMAIN};
    location ^~ /.well-known/acme-challenge/ {{ root {webroot}; }}
    location / {{ return 301 https://$host$request_uri; }}
}}
"""
    secret_file(vhost, http)
    (Path("/etc/nginx/sites-enabled") / DOMAIN).symlink_to(vhost)
    run(["nginx", "-t"])
    run(["systemctl", "reload", "nginx"])
    run(["certbot", "certonly", "--webroot", "-w", str(webroot), "-d", DOMAIN, "--cert-name", DOMAIN, "--non-interactive", "--agree-tos"])
    tls = f"""
server {{
    listen 443 ssl;
    server_name {DOMAIN};
    ssl_certificate /etc/letsencrypt/live/{DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    auth_basic "Crypto Trader paper workspace";
    auth_basic_user_file /etc/crypto-trader/nginx.htpasswd;
    client_max_body_size 32k;
    add_header Strict-Transport-Security "max-age=31536000" always;
    access_log /var/log/nginx/crypto-trader-access.log;
    error_log /var/log/nginx/crypto-trader-error.log;
    location /api/ {{
        proxy_pass http://127.0.0.1:3101/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Crypto-Proxy-Auth "{proxy}";
        proxy_set_header Authorization "";
        proxy_set_header Connection "";
        proxy_read_timeout 180s;
        proxy_buffering off;
        add_header Cache-Control "no-store" always;
    }}
    location / {{
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Crypto-Proxy-Auth "";
        proxy_set_header Connection "";
        proxy_read_timeout 60s;
    }}
}}
"""
    vhost.write_text(http+tls)
    vhost.chmod(0o600)
    run(["nginx", "-t"])
    run(["systemctl", "reload", "nginx"])
    hook = Path("/etc/letsencrypt/renewal-hooks/deploy/crypto-trader-nginx.sh")
    secret_file(hook, '#!/bin/sh\ncase " $RENEWED_DOMAINS " in *" '+DOMAIN+' "*) /usr/sbin/nginx -t && /bin/systemctl reload nginx ;; esac\n', 0o755)
    state_file.write_text(json.dumps({"domain":DOMAIN,"application":str(ROOT / "current"),"database":"crypto-trader-postgres","user":"crypto-trader","createdBy":"authorized-vps-deployment"}, indent=2)+"\n")
    state_file.chmod(0o600)
    print("Private database, nginx vhost and HTTPS certificate configured. Credentials saved privately.")


if __name__ == "__main__":
    main()
