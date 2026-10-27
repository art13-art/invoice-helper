#!/bin/sh
# LINE 小幫手測試：假的 D1（node:sqlite）＋假的 LINE／Claude／OpenAI／Apps Script，不會連到正式環境。
# 用法：sh tests/line/run.sh   （需要 Node 22 以上）
cd "$(dirname "$0")/../.." || exit 1
fail=0
for f in tests/line/test_*.mjs; do
  out=$(node "$f" 2>&1 | grep -E "FAIL|passed|Error" | grep -v ExperimentalWarning)
  echo "$(basename "$f"): $(echo "$out" | tail -1)"
  echo "$out" | grep -q "FAIL\|Error" && { echo "$out" | grep "FAIL\|Error"; fail=1; }
done
exit $fail
