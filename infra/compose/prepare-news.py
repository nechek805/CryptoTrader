"""Owner VPS: isolated news database/role and private per-service environments.
No credentials are printed or passed in process arguments. Existing paper data stays intact.
"""
from pathlib import Path
import os
import secrets
import subprocess

root=Path('/etc/crypto-trader/compose')
def env(path):
 return dict(line.split('=',1) for line in path.read_text().splitlines() if '=' in line and not line.startswith('#'))
def write(name,text,mode=0o600):
 p=root/name
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,mode)
 with os.fdopen(fd,'w') as f:f.write(text)
 p.chmod(mode)
def settings(name,values):write(name,''.join(k+'='+str(v)+'\n' for k,v in values.items()))
def sql(query,database='postgres'):
 result=subprocess.run(['docker','exec','-i','crypto-trader-postgres','psql','-v','ON_ERROR_STOP=1','-U','cryptotrader','-d',database,'-At'],input=query,text=True,capture_output=True)
 if result.returncode:raise RuntimeError('Private news database provisioning failed')
 return result.stdout.strip()

if not root.is_dir():raise RuntimeError('Configure the existing Compose deployment first')
secret_file=root/'news-ai-secret.env'
secret_file.chmod(0o600)
ai=env(secret_file)
if len(ai.get('NEWS_AI_API_KEY',''))<10:raise RuntimeError('Private AI key is required')
db_file=root/'news-db.env'
if db_file.exists():
 password=env(db_file)['NEWS_DB_PASSWORD']
else:
 password=secrets.token_urlsafe(40);settings('news-db.env',{'NEWS_DB_PASSWORD':password})
if not sql("SELECT 1 FROM pg_roles WHERE rolname='crypto_news_app';"):
 sql("CREATE ROLE crypto_news_app LOGIN PASSWORD '"+password+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;")
if not sql("SELECT 1 FROM pg_database WHERE datname='crypto_news';"):
 sql('CREATE DATABASE crypto_news OWNER crypto_news_app;')
sql('REVOKE CONNECT ON DATABASE crypto_news FROM PUBLIC; GRANT CONNECT ON DATABASE crypto_news TO crypto_news_app;')
worker=env(root/'worker.env');api=env(root/'api.env')
news_url='postgresql://crypto_news_app:'+password+'@postgres:5432/crypto_news'
common={'NEWS_DATABASE_URL':news_url,'REDIS_URL':worker['REDIS_URL']}
settings('news-collector.env',{**common,'NEWS_WORKER_ROLE':'collector'})
settings('news-analyzer.env',{**common,'NEWS_WORKER_ROLE':'analyzer',**ai,'NEWS_AI_ENABLED':'1'})
settings('news-api.env',{**common,**{k:api[k] for k in ['OPS_PROXY_SECRET','OPS_READ_TOKEN','OPS_ADMIN_TOKEN','OPS_ALLOWED_ORIGINS']}})
maintenance=env(root/'maintenance.env');maintenance['NEWS_DATABASE_URL']=news_url;settings('maintenance.env',maintenance)
project=env(root/'project.env');project.update({'NEWS_IMAGE':'crypto-trader:news-v1','WEB_IMAGE':'crypto-trader:news-v1','MAINTENANCE_IMAGE':'crypto-trader:news-v1'});settings('project.env',project)
gateway=(root/'gateway.conf').read_text()
if 'location ^~ /api/news/' not in gateway:
 location='''    location ^~ /api/news/ {
      proxy_pass http://news-api:3103/news/;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Crypto-Proxy-Auth "'''+api['OPS_PROXY_SECRET']+'''";
      proxy_set_header Authorization "";
      proxy_set_header Connection "";
      proxy_read_timeout 60s;
      proxy_buffering off;
      add_header Cache-Control "no-store" always;
    }
'''
 if '    location /api/ {' not in gateway:raise RuntimeError('Existing gateway template differs')
 gateway=gateway.replace('    location /api/ {',location+'    location /api/ {')
write('gateway-news.conf',gateway,0o444)
print('Isolated news database and private service settings prepared. Existing paper services unchanged.')
