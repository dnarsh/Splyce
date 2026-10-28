# Expo demo script prompts (V1)

Pre-written presenter prompts for each runbook step. Copy-paste into the composer; do not improvise on stage.

## Step 4 — First chat turn
"Say hello in one sentence."

## Step 5 — fs.read inside workspace
"Read README.txt and tell me what it says."

## Step 6 — fs.write + fs.edit approvals
"Create notes.txt containing hello."  (run twice: deny first, then allow)
"Replace 'hello' with 'hi' in notes.txt."  (fs.edit; missing match reads "The text to replace was not found.")

## Step 7 — shell.run
"Run echo hi in the workspace."
"Run a command that sleeps longer than the timeout."

## Step 8 — Path escape
"read ../secret.txt"

## Step 9 — Secret hygiene
"remember this: <test-key>"  (then end session; search persisted JSONL + logs)

## Step 11 — memory_search + code_search
"Search memory for demo"
"Find where hello appears in the project"

## Step 4 retry (after restart)
"Say hello in one sentence."  (verify stream resyncs from durable cursor)
