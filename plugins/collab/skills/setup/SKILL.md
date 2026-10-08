---
description: Save your collab token so this machine can talk to the collab relay
argument-hint: <token> [relay-url]
disable-model-invocation: true
allowed-tools: Bash(collab setup *)
---

Run `collab setup $ARGUMENTS` and report the result in one line.

The listener starts with each new session, so tell the user to restart Claude Code once for this machine to come online.
