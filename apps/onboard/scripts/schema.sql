-- Tables the QuickNode Stream webhook (api/stream.ts) fills. api/_kitty-db.ts creates them on
-- first delivery; this file is the same schema for reference or a manual setup.
create table if not exists kitty_logs (
  tx_hash text not null, log_index integer not null, block bigint not null, ts bigint not null,
  topics jsonb not null, data text not null, primary key (tx_hash, log_index));
create table if not exists kitty_transfers (
  tx_hash text not null, log_index integer not null, block bigint not null, ts bigint not null,
  from_addr text not null, to_addr text not null, value numeric not null, primary key (tx_hash, log_index));
create index if not exists kitty_transfers_from on kitty_transfers (from_addr);
create index if not exists kitty_transfers_to on kitty_transfers (to_addr);
