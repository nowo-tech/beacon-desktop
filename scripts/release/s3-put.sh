#!/usr/bin/env bash
# Uploads one file with a single s3:PutObject (the CI key has no other permission).
# Usage: scripts/release/s3-put.sh <local-file> <object-key> [content-type]
# Env: S3_CLIENTS_PREFIX (optional: time-track-clients | beacon-clients),
#      TIME_TRACK_S3_ENDPOINT, TIME_TRACK_S3_BUCKET, TIME_TRACK_S3_ACCESS_KEY_ID, TIME_TRACK_S3_SECRET_ACCESS_KEY,
#      TIME_TRACK_S3_REGION (optional, default us-east-1).
set -euo pipefail
file="$1"; key="$2"; type="${3:-application/octet-stream}"
PREFIX="${S3_CLIENTS_PREFIX:-time-track-clients}"
case "$PREFIX" in time-track-clients|beacon-clients) ;; *) echo "invalid S3_CLIENTS_PREFIX" >&2; exit 1 ;; esac
case "$key" in */../*|../*|*/..|/*) echo "::error::refusing unsafe key: $key"; exit 1 ;; esac
case "$key" in "$PREFIX"/*) ;; *) echo "::error::refusing key outside $PREFIX/: $key"; exit 1 ;; esac
AWS_ACCESS_KEY_ID="$TIME_TRACK_S3_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$TIME_TRACK_S3_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION="${TIME_TRACK_S3_REGION:-us-east-1}" \
  aws s3api put-object --endpoint-url "$TIME_TRACK_S3_ENDPOINT" --bucket "$TIME_TRACK_S3_BUCKET" \
    --key "$key" --body "$file" --content-type "$type" >/dev/null
echo "uploaded s3://$TIME_TRACK_S3_BUCKET/$key"
