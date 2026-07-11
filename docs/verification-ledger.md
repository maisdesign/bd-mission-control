# Verification Ledger

`bd-mission-control` distinguishes workflow completion from independent verification.

The practical convention is a comment containing a pass marker such as:

```text
VERIFIED bead=bmc-9 result=pass gate='node --test && node build.mjs' exit=0
```

Why this matters:

- `closed` means the work item was finished from the worker's perspective
- `VERIFIED result=pass` means someone or something else re-checked it
- a closed bead without that second signal is treated as drift risk, not as equivalent proof

This keeps the HUD useful in multi-agent and reviewer-led workflows without coupling the repo to one machine or one launcher.
