"""Provision independent news paper state, read-only source access and private .env files.
No backups, financial-engine changes, source edits or research-report writes.
"""
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, quote
import secrets
import subprocess
import json

root=Path('/etc/crypto-trader/compose')
def env(p):
 return dict(l.split('=',1) for l in p.read_text().splitlines() if '=' in l and not l.startswith('#'))
def write(p,values):
 p.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
 p.write_text(''.join(k+'='+str(v)+'\n' for k,v in values.items()))
 p.chmod(0o600)
def sql(query,database='postgres'):
 r=subprocess.run(['docker','exec','-i','--env','FORWARD_TARGET_DB='+database,'crypto-trader-postgres','sh','-c','exec psql -U "$POSTGRES_USER" -d "$FORWARD_TARGET_DB" -v ON_ERROR_STOP=1 -At'],input=query,text=True,capture_output=True)
 if r.returncode:raise RuntimeError('News forward private database provisioning failed')
 return r.stdout.strip()
project=env(root/'project.env')
assert project.get('BACKUPS_ENABLED')=='0','Backups must stay disabled'
news=env(root/'news-api.env')
u=urlsplit(news['NEWS_DATABASE_URL']);database=u.path.lstrip('/')
if database!='crypto_news':raise RuntimeError('Unexpected news database')
private=root/'news-forward'/'.env'
existing=env(private) if private.exists() else {}
password=urlsplit(existing['NEWS_FORWARD_DATABASE_URL']).password if existing.get('NEWS_FORWARD_DATABASE_URL') else secrets.token_urlsafe(40)
if not all(c.isalnum() or c in '_-' for c in password):raise RuntimeError('Unexpected password encoding')
action='ALTER' if sql("SELECT 1 FROM pg_roles WHERE rolname='crypto_news_forward_app'") else 'CREATE'
sql(action+" ROLE crypto_news_forward_app LOGIN PASSWORD '"+password+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;")
sql('GRANT CONNECT ON DATABASE crypto_news TO crypto_news_forward_app,crypto_telegram_app;')
sql('''CREATE SCHEMA IF NOT EXISTS crypto_news_forward_v1 AUTHORIZATION crypto_news_forward_app;
REVOKE ALL ON SCHEMA crypto_news_forward_v1 FROM PUBLIC;
GRANT USAGE ON SCHEMA crypto_news_live_v1 TO crypto_news_forward_app;
GRANT SELECT ON crypto_news_live_v1.sources,crypto_news_live_v1.article_versions,crypto_news_live_v1.research_v6_reports TO crypto_news_forward_app;
CREATE SCHEMA IF NOT EXISTS crypto_telegram_v1 AUTHORIZATION crypto_telegram_app;
REVOKE ALL ON SCHEMA crypto_telegram_v1 FROM PUBLIC;
GRANT USAGE ON SCHEMA crypto_news_forward_v1 TO crypto_telegram_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crypto_news_forward_app IN SCHEMA crypto_news_forward_v1 GRANT SELECT ON TABLES TO crypto_telegram_app;''',database)
frozen=json.loads(sql("SELECT json_build_object('id',run_id,'hash',hash)::text FROM crypto_news_live_v1.research_v6_reports ORDER BY run_id LIMIT 1",database))
url='postgresql://crypto_news_forward_app:'+quote(password,safe='')+'@'+u.hostname+':'+str(u.port or 5432)+'/'+database
write(private,{'NEWS_FORWARD_ENABLED':'1','NEWS_FORWARD_DATABASE_URL':url,'NEWS_FORWARD_REPORT_ID':frozen['id'],'NEWS_FORWARD_REPORT_HASH':frozen['hash'],'REDIS_URL':news['REDIS_URL'],**{k:news[k] for k in ['OPS_PROXY_SECRET','OPS_READ_TOKEN','OPS_ADMIN_TOKEN','OPS_ALLOWED_ORIGINS']}})
telegram=env(root/'telegram'/'.env');tu=urlsplit(telegram['TELEGRAM_DATABASE_URL'])
telegram['TELEGRAM_DATABASE_URL']=urlunsplit((tu.scheme,tu.netloc,'/'+database,tu.query,tu.fragment))
telegram['TELEGRAM_DASHBOARD_URL']='https://crypto-trader.nechek805.org/news-paper'
write(root/'news-forward-alerts'/'.env',telegram)
project['NEWS_FORWARD_IMAGE']='crypto-trader:news-forward-v1';write(root/'project.env',project)
print('News forward private .env, frozen report reference and isolated role/schema prepared. Backups remain disabled.')
