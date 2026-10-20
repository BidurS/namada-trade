#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/out/sql" && pwd)"

echo "=== Uploading Namada Holders & Labels (namada_0000.sql) ==="
npx wrangler d1 execute namada-trade-db --remote --file="$DIR/namada_0000.sql" --yes

echo "=== Uploading Osmosis Past Flows (osmosis_0001.sql) ==="
npx wrangler d1 execute namada-trade-db --remote --file="$DIR/osmosis_0001.sql" --yes

echo "=== Uploading Osmosis Past Flows (osmosis_0002.sql) ==="
npx wrangler d1 execute namada-trade-db --remote --file="$DIR/osmosis_0002.sql" --yes

if [ -f "$DIR/osmosis_0003.sql" ]; then
  echo "=== Uploading Osmosis Past Flows (osmosis_0003.sql) ==="
  npx wrangler d1 execute namada-trade-db --remote --file="$DIR/osmosis_0003.sql" --yes
fi

echo "=== Upload Complete ==="
