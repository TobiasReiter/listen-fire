# Attio sync with `lf`

One movement: when a company is created or changed in Attio, it is found
again by its name and given a description. Its own update comes back from
Attio as `record.updated`. With the loop guard in `lf.yaml` (`core: { loopGuard:
"@lf/fingerprint-guard" }`, off by default) lf knows that for the movement's own
write (the record is just as it left it) and runs nothing, so it never loops,
while a change by someone else runs it again. Without the guard the echo runs
the movement again. `lf serve` registers Attio's webhook itself, so
a company created in Attio runs the movement.

The files here are what the walkthrough below ends with (no secrets: those are
in `.lf/secrets.yaml`, written by `lf connect` and `lf credential add`).

## Against real Attio

You need an OAuth app in Attio (Workspace settings, Developers): its client id
and secret, with `http://127.0.0.1:8976/callback` registered as a redirect
URI, and the scopes for records and webhooks (read-write).

```
lf init attio-sync && cd attio-sync
lf connect @lf/attio          # client id, client secret, 8976 (Attio issues the webhook secret itself)
lf credential add --module @lf/attio henry_attio     # enter, enter; signs you in in the browser
cp <this folder>/movements/sync.mvt movements/
lf check
lf run --event <this folder>/events/created.json --dry-run   # set record_id to a company's id first
```

Attio must reach `lf serve`: run a tunnel to its port (any will do) and put
its address in `lf.yaml`:

```
publicUrl: https://<your tunnel>
```

```
lf serve --port 4400   # prints: attio: registered webhook <id> for record.created,record.updated at <publicUrl>/api/public/webhook-sync/attio/henry_attio
lf runs                # after you create a company in Attio
```

Stopping and starting `lf serve` again keeps the same webhook. Remove the
listen and start it again, and the webhook is removed.

## Against the fake Attio (no account, no tunnel)

The repo's fake third-party server (`apps/fake-channels`) has an Attio API, an
OAuth provider, and a control door that delivers Attio's signed webhooks.

```
cd apps/fake-channels && FAKE_CHANNELS_PORT=5556 pnpm start     # in its own terminal
F=http://127.0.0.1:5556
```

```
lf init attio-sync && cd attio-sync
lf connect @lf/attio --base-url $F/attio --oauth-authorize-url $F/oauth/authorize --oauth-token-url $F/oauth/token
#   any client id, any client secret, 8976
lf credential add --module @lf/attio henry_attio --headless
#   enter, enter; open the printed URL (curl -si '<url>' shows the Location), paste the Location back
cp <this folder>/movements/sync.mvt movements/ && mkdir -p events && cp <this folder>/events/created.json events/
curl -s -XPOST $F/attio/v2/objects/companies/records -H 'content-type: application/json' \
  -d '{"data":{"values":{"name":"Vireo Robotics"}}}'      # note its record_id; put it in events/created.json
lf check
lf run --event events/created.json --dry-run
echo 'publicUrl: http://127.0.0.1:4400' >> lf.yaml
lf serve --port 4400                                       # in its own terminal
curl -s $F/admin/attio/webhook/state                       # the webhook lf serve registered
curl -s -XPOST $F/attio/control/deliver -H 'content-type: application/json' \
  -d '{"events":[{"event_type":"record.created","id":{"object_id":"companies","record_id":"<id>"}}]}'
curl -s $F/admin/attio/record:companies/state              # the company now has its description
lf runs
```

Delivering the same event again runs nothing: a record is created once, so its
`record.created` is run once.

Add the guard to `lf.yaml` (`core:` / `  loopGuard: "@lf/fingerprint-guard"`; this folder's
`lf.yaml` has it), restart `lf serve`, and the movement's own update echoes back as
`record.updated` and runs nothing ([the slot](../../docs/contracts/loop-guard-slot.md)):

```
curl -s -XPOST $F/attio/control/deliver -H 'content-type: application/json' \
  -d '{"events":[{"event_type":"record.updated","id":{"object_id":"companies","record_id":"<id>"}}]}'
#   lf serve prints: sync:stamp wrote the record <id> and it is unchanged since: this event is that write's echo and runs nothing
```

Change the description as someone else would (`PATCH $F/attio/v2/objects/companies/records/<id>`
with `{"data":{"values":{"description":"Edited by Bob"}}}`) and deliver the same event: the
movement runs and writes its description back.
