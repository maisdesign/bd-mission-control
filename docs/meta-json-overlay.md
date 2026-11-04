# Meta JSON Overlay

`orchestration.meta.json` is optional metadata for human curation on top of the raw Beads export.

Typical uses:

- rename a wave title or subtitle
- override a bead label or phase
- add a note banner
- raise a review/decision flag

Minimal example:

```json
{
  "waves": {
    "2": {
      "title": "Wave 2",
      "subtitle": "Observatory preparation"
    }
  },
  "beads": {
    "demo-4": {
      "label": "Star map controls",
      "phase": "runtime",
      "track": "UI"
    },
    "demo-10": {
      "flag": true,
      "note": "Opening night pending telescope checks"
    }
  }
}
```

Use it to enrich the story, not to make the panel usable. The raw tracker remains the source of truth.
