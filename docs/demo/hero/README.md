# Hero demo

A 60-second video of an agent writing a Listen-Fire automation over MCP, the
checker refusing a stage Attio doesn't have, a one-token fix, and the saved
automation then running on a real email. The run includes one small
extraction call. Everything the video shows is captured from a real run on
the agent dev loop, with the repository's fakes standing in for Gmail, Attio
and Slack. The page renders from `data.js` alone, and `data.js` is built
only from the captured responses.

## Make it

Needs `ANTHROPIC_API_KEY` in the environment (the run's extraction is a real
model call).

```bash
cd docs/demo/hero
./scripts/boot.sh                       # dev loop up, team seeded, Gmail + Slack provisioned
./scripts/capture.sh                    # the agent's loop over MCP, then the email and its run
node scripts/build_data.cjs             # .work/capture → data.js (refuses a failed run)
./scripts/fetch_fonts.sh                # Inter + JetBrains Mono, local
node scripts/render.cjs --stills 24 34 46 53   # check frames in stills/
node scripts/render.cjs                 # listen-fire-hero.mp4, 1080p30, about 8 minutes
```

`boot.sh` is for a fresh Linux cloud container. It pulls the Postgres and
Redis images through `mirror.gcr.io` (Docker Hub rate-limits these hosts),
shims `script` for `dev/loop.sh`, generates the Prisma client, and starts the
stack with `ANTHROPIC_BASE_URL=https://api.anthropic.com`, because a cloud
session points that variable at its own proxy. On a developer machine with
the stack already up it only seeds.

## What is in it

- `programs/draft.mvt`: the agent's first draft. It uses the user's word
  "Sourcing", which isn't one of Attio's stages, so `saveAutomation` refuses
  it with `MOV_ENUM_UNKNOWN_VALUE`.
- `programs/fixed.mvt`: the one-token fix ("Sourced"), which saves and goes live.
- `programs/founder_email.txt`: the founder's email body.
- `demo.html` and `timeline.js`: the video. Every element is a pure function
  of `t`, so frames capture deterministically.
- `scripts/`: boot, capture (`mcp.sh` calls one connector tool the way an
  agent does), data build, fonts, render.

Generated files (`.work/` with the captures and the minted API key, `data.js`,
`fonts/`, `stills/`, `*.mp4`) are gitignored.
