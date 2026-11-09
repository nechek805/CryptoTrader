"""Provision only notification state and a read-only paper-ledger role. Never create backups."""
from pathlib import Path
from urllib.parse import urlsplit, quote
import os
import re
import secrets
import subprocess

root = Path('/etc/crypto-trader/compose')
private = root / 'telegram' / '.env'


def read_env(path):
    return dict(line.split('=', 1) for line in path.read_text().splitlines()
                if '=' in line and not line.startswith('#'))


def write_env(path, values):
    path.write_text(''.join(k + '=' + str(v) + '\n' for k, v in values.items()))
    path.chmod(0o600)


def sql(query, database='postgres'):
    result = subprocess.run([
        'docker', 'exec', '-i', '--env', 'TELEGRAM_TARGET_DATABASE=' + database,
        'crypto-trader-postgres', 'sh', '-c',
        'exec psql -U "$POSTGRES_USER" -d "$TELEGRAM_TARGET_DATABASE" -v ON_ERROR_STOP=1 -At',
    ], input=query, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('Private Telegram database provisioning failed')
    return result.stdout.strip()


settings = read_env(private)
if not settings.get('TELEGRAM_BOT_TOKEN') or not settings.get('TELEGRAM_USER_ID', '').isdigit():
    raise RuntimeError('Configure private Telegram .env first')
worker = read_env(root / 'worker.env')
paper = urlsplit(worker['LIVE_PAPER_DATABASE_URL'])
database = paper.path.lstrip('/')
if not re.fullmatch(r'[a-zA-Z0-9_]+', database):
    raise RuntimeError('Unexpected paper database name')
role = 'crypto_telegram_app'
password = urlsplit(settings['TELEGRAM_DATABASE_URL']).password if settings.get('TELEGRAM_DATABASE_URL') else secrets.token_urlsafe(40)
if not re.fullmatch(r'[a-zA-Z0-9_-]+', password):
    raise RuntimeError('Unexpected notifier credential encoding')
action = 'ALTER' if sql("SELECT 1 FROM pg_roles WHERE rolname='crypto_telegram_app';") else 'CREATE'
sql(action + " ROLE crypto_telegram_app LOGIN PASSWORD '" + password + "' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;")
sql('GRANT CONNECT ON DATABASE "' + database + '" TO crypto_telegram_app;')
sql('''CREATE SCHEMA IF NOT EXISTS crypto_telegram_v1 AUTHORIZATION crypto_telegram_app;
REVOKE ALL ON SCHEMA crypto_telegram_v1 FROM PUBLIC;
GRANT USAGE ON SCHEMA crypto_live_paper_v1 TO crypto_telegram_app;
GRANT SELECT ON crypto_live_paper_v1.runs, crypto_live_paper_v1.positions, crypto_live_paper_v1.events TO crypto_telegram_app;''', database)
settings.update({
    'TELEGRAM_ENABLED': '1',
    'TELEGRAM_DATABASE_URL': 'postgresql://' + role + ':' + quote(password, safe='') + '@' + paper.hostname + ':' + str(paper.port or 5432) + '/' + database,
    'REDIS_URL': worker['REDIS_URL'],
    'TELEGRAM_DASHBOARD_URL': 'https://crypto-trader.nechek805.org/live-paper',
})
write_env(private, settings)
project = read_env(root / 'project.env')
project['TELEGRAM_IMAGE'] = 'crypto-trader:telegram-v1'
write_env(root / 'project.env', project)
assert project.get('BACKUPS_ENABLED') == '0'
print('Telegram private .env and isolated notification schema prepared; paper-ledger grants are SELECT only. Backups remain disabled.')
