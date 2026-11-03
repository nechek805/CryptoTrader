CREATE FUNCTION {{schema}}.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'research records are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TABLE {{schema}}.raw_events (
  id text PRIMARY KEY,
  sequence bigserial UNIQUE NOT NULL,
  provider text NOT NULL,
  raw_hash text NOT NULL,
  signature text NOT NULL,
  content_hash text NOT NULL,
  stored_at text NOT NULL,
  stored_at_ns numeric(30,0) NOT NULL,
  envelope jsonb NOT NULL CHECK (envelope->>'schemaVersion' = 'event-envelope.v1'),
  UNIQUE (provider, raw_hash)
);
CREATE TABLE {{schema}}.raw_delivery_keys (
  provider text NOT NULL,
  raw_id text NOT NULL,
  raw_event_id text NOT NULL REFERENCES {{schema}}.raw_events(id),
  PRIMARY KEY (provider, raw_id)
);
CREATE TABLE {{schema}}.derived_records (
  id text PRIMARY KEY,
  sequence bigserial UNIQUE NOT NULL,
  kind text NOT NULL CHECK (kind IN ('MARKET_BAR', 'NEWS_DOCUMENT')),
  entity_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  previous_id text REFERENCES {{schema}}.derived_records(id),
  content_hash text NOT NULL,
  stored_at text NOT NULL,
  stored_at_ns numeric(30,0) NOT NULL,
  available_at_ns numeric(30,0),
  known_at text NOT NULL,
  known_at_ns numeric(30,0) NOT NULL,
  research_use text NOT NULL CHECK (research_use IN ('ELIGIBLE', 'DESCRIPTIVE_ONLY')),
  source_key text NOT NULL,
  instrument_id text,
  open_at_ns numeric(30,0),
  payload jsonb NOT NULL CHECK (
    (kind = 'MARKET_BAR' AND payload->>'schemaVersion' = 'market-bar.v1') OR
    (kind = 'NEWS_DOCUMENT' AND payload->>'schemaVersion' = 'news-document.v1')
  ),
  CHECK (payload->>'id' = entity_id),
  CHECK ((revision = 1 AND previous_id IS NULL) OR (revision > 1 AND previous_id IS NOT NULL)),
  UNIQUE (kind, entity_id, revision),
  UNIQUE (kind, entity_id, content_hash)
);
CREATE INDEX derived_point_in_time ON {{schema}}.derived_records(kind, entity_id, revision DESC)
  WHERE research_use = 'ELIGIBLE';
CREATE INDEX market_instrument_time ON {{schema}}.derived_records(instrument_id, open_at_ns)
  WHERE kind = 'MARKET_BAR';
CREATE TABLE {{schema}}.derived_sources (
  derived_id text NOT NULL REFERENCES {{schema}}.derived_records(id),
  raw_event_id text NOT NULL REFERENCES {{schema}}.raw_events(id),
  PRIMARY KEY (derived_id, raw_event_id)
);
CREATE TABLE {{schema}}.research_records (
  id text PRIMARY KEY,
  sequence bigserial UNIQUE NOT NULL,
  kind text NOT NULL CHECK (kind IN ('RUN', 'EXPERIMENT')),
  content_hash text NOT NULL,
  stored_at text NOT NULL,
  payload jsonb NOT NULL CHECK (
    (kind = 'RUN' AND payload->>'schemaVersion' = 'research-run.v1') OR
    (kind = 'EXPERIMENT' AND payload->>'schemaVersion' = 'experiment-manifest.v1')
  ),
  CHECK (payload->>'id' = id),
  experiment_id text REFERENCES {{schema}}.research_records(id)
);
CREATE TABLE {{schema}}.research_inputs (
  record_id text NOT NULL REFERENCES {{schema}}.research_records(id),
  input_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('RAW_EVENT', 'MARKET_BAR', 'NEWS_DOCUMENT')),
  content_hash text NOT NULL,
  raw_id text REFERENCES {{schema}}.raw_events(id),
  derived_id text REFERENCES {{schema}}.derived_records(id),
  CHECK ((raw_id IS NOT NULL AND raw_id = input_id AND derived_id IS NULL AND kind = 'RAW_EVENT') OR
         (derived_id IS NOT NULL AND derived_id = input_id AND raw_id IS NULL AND kind <> 'RAW_EVENT')),
  PRIMARY KEY (record_id, kind, input_id)
);
CREATE TABLE {{schema}}.retention_marks (
  kind text NOT NULL CHECK (kind IN ('RAW_EVENT', 'MARKET_BAR', 'NEWS_DOCUMENT')),
  entity_id text NOT NULL,
  archived_at text NOT NULL,
  PRIMARY KEY (kind, entity_id)
);
CREATE TABLE {{schema}}.audit_entries (
  id text PRIMARY KEY,
  sequence bigserial UNIQUE NOT NULL,
  action text NOT NULL CHECK (action IN ('RAW_INGESTED', 'RAW_ALIAS_LINKED', 'REVISION_APPENDED',
    'RUN_RECORDED', 'EXPERIMENT_RECORDED', 'RETENTION_ARCHIVED')),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  occurred_at text NOT NULL,
  content_hash text NOT NULL,
  previous_hash text,
  entry_hash text UNIQUE NOT NULL
);

CREATE VIEW {{schema}}.market_bar_versions AS
  SELECT * FROM {{schema}}.derived_records WHERE kind = 'MARKET_BAR';
CREATE VIEW {{schema}}.news_document_versions AS
  SELECT * FROM {{schema}}.derived_records WHERE kind = 'NEWS_DOCUMENT';

CREATE TRIGGER immutable_raw BEFORE UPDATE OR DELETE OR TRUNCATE ON {{schema}}.raw_events
  FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.reject_mutation();
CREATE TRIGGER immutable_deliveries BEFORE UPDATE OR DELETE OR TRUNCATE ON {{schema}}.raw_delivery_keys
  FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.reject_mutation();
CREATE TRIGGER immutable_derived BEFORE UPDATE OR DELETE OR TRUNCATE ON {{schema}}.derived_records
  FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.reject_mutation();
CREATE TRIGGER immutable_sources BEFORE UPDATE OR DELETE OR TRUNCATE ON {{schema}}.derived_sources
  FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.reject_mutation();
CREATE TRIGGER immutable_research BEFORE UPDATE OR DELETE OR TRUNCATE ON {{schema}}.research_records
  FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.reject_mutation();
CREATE TRIGGER immutable_inputs BEFORE UPDATE OR DELETE OR TRUNCATE ON {{schema}}.research_inputs
  FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.reject_mutation();
CREATE TRIGGER immutable_retention BEFORE UPDATE OR DELETE OR TRUNCATE ON {{schema}}.retention_marks
  FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.reject_mutation();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE OR TRUNCATE ON {{schema}}.audit_entries
  FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.reject_mutation();
