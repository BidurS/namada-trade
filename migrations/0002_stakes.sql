-- Bonded stake per Namada address. `bonded_num` is read from the chain (ABCI /vp/pos/delegations_at +
-- self-bond); `estimated_num` is Σbond − Σunbond from the flows history and only a hint until verified.
CREATE TABLE IF NOT EXISTS stakes (
  address        TEXT PRIMARY KEY,
  bonded_num     REAL,                       -- NAM, chain-verified; NULL until first verification
  delegations    TEXT,                       -- JSON [{validator, amountNam}]
  estimated_num  REAL,                       -- NAM, from bond/unbond history
  verified_at    INTEGER,                    -- unix ms of the ABCI read
  verified_epoch INTEGER,
  verified_src   TEXT,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS stakes_rank ON stakes (bonded_num DESC);
