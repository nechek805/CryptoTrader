"""Generate private Compose settings from this owner's existing VPS deployment.
Never prints credentials and never rewrites the database volume or source run.
"""
import os
from pathlib import Path
import pwd
import secrets
import shutil
from urllib.parse import urlsplit, urlunsplit

root = Path('/etc/crypto-trader')
target = root / 'compose'
target.mkdir(mode=0o700, exist_ok=True)
target.chmod(0o700)
source = dict(line.split('=', 1) for line in (root / 'app.env').read_text().splitlines() if '=' in line and not line.startswith('#'))


def write(name, text, mode=0o600):
    path = target / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, 'w') as stream:
        stream.write(text)
    path.chmod(mode)


uri = urlsplit(source['LIVE_PAPER_DATABASE_URL'])
db = urlunsplit((uri.scheme, uri.netloc.rsplit('@', 1)[0]+'@postgres:5432', uri.path, '', ''))
redis_password = secrets.token_urlsafe(48)
rpc = secrets.token_urlsafe(48)
worker = f'LIVE_PAPER_DATABASE_URL={db}\nREDIS_URL=redis://default:{redis_password}@redis:6379/0\nWORKER_RPC_TOKEN={rpc}\n'
write('worker.env', worker)
write('maintenance.env', worker.split('WORKER_RPC_TOKEN=')[0])
api = {key: source[key] for key in ['OPS_MODE', 'OPS_ALLOWED_ORIGINS', 'OPS_READ_TOKEN', 'OPS_ADMIN_TOKEN', 'OPS_PROXY_SECRET']}
api.update({'DATA_MODE':'fixture-only', 'LIVE_PAPER_ENABLED':'1', 'LIVE_PAPER_SCHEDULER':'bullmq', 'OPS_BIND_HOST':'0.0.0.0', 'LIVE_PAPER_DATABASE_URL':db, 'WORKER_RPC_URL':'http://worker:3102', 'WORKER_RPC_TOKEN':rpc})
write('api.env', ''.join(key+'='+value+'\n' for key,value in api.items()))
write('db.env', (root / 'db.env').read_text())
write('redis.env', 'REDISCLI_AUTH='+redis_password+'\n')
write('redis.conf', f'bind 0.0.0.0\nport 6379\nprotected-mode yes\nrequirepass {redis_password}\nappendonly yes\nappendfsync everysec\nmaxmemory 96mb\nmaxmemory-policy noeviction\ndir /data\n', 0o444)
write('gateway.htpasswd', (root / 'nginx.htpasswd').read_text(), 0o444)
write('gateway.conf', '''pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events { worker_connections 512; }
http {
  include /etc/nginx/mime.types;
  access_log /dev/stdout;
  client_body_temp_path /tmp/client_temp;
  proxy_temp_path /tmp/proxy_temp;
  fastcgi_temp_path /tmp/fastcgi_temp;
  uwsgi_temp_path /tmp/uwsgi_temp;
  scgi_temp_path /tmp/scgi_temp;
  server {
    listen 8080;
    server_name crypto-trader.nechek805.org;
    auth_basic "Crypto Trader paper workspace";
    auth_basic_user_file /etc/nginx/crypto.htpasswd;
    client_max_body_size 32k;
    location = /gateway-health { auth_basic off; access_log off; return 200 'ok'; }
    location /api/ {
      proxy_pass http://api:3101/;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Crypto-Proxy-Auth "'''+source['OPS_PROXY_SECRET']+'''";
      proxy_set_header Authorization "";
      proxy_set_header Connection "";
      proxy_read_timeout 180s;
      proxy_buffering off;
      add_header Cache-Control "no-store" always;
    }
    location / {
      proxy_pass http://web:3100;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Crypto-Proxy-Auth "";
      proxy_set_header Connection "";
      proxy_read_timeout 60s;
    }
  }
}
''', 0o444)
account = pwd.getpwnam('crypto-trader')
write('project.env', f'CONFIG_DIRECTORY={target}\nAPP_UID={account.pw_uid}\nAPP_GID={account.pw_gid}\nAPP_IMAGE=crypto-trader:compose-v1\nWORKER_IMAGE=crypto-trader:paper-worker-v1\nPOSTGRES_VOLUME=crypto-trader-pgdata\nREDIS_VOLUME=crypto-trader-queue-data\nDATA_DIRECTORY=/var/lib/crypto-trader/data\nBACKUP_DIRECTORY=/var/backups/crypto-trader/compose\n')
backup = Path('/var/backups/crypto-trader/compose')
backup.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chown(backup, account.pw_uid, account.pw_gid)
backup.chmod(0o700)
print('Private Compose configuration generated; existing login, database and run preserved.')
