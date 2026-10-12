On a team's account, pass the team's id as `teamId` on every call; `int_vercel_list_teams` gives it. Without it you see only the personal account's projects.

A deployment's `readyState` (called `state` in lists) says where it is: `QUEUED`, `BUILDING`, `READY`, `ERROR` or `CANCELED`. Its `target` is `production` or empty for a preview. When one is in `ERROR`, read why with `int_vercel_get_build_logs`: the last lines usually say.

A deployment can be named by its id (`dpl_…`) or by its address without `https://`.

To check a change went out: list the project's deployments, find the one for the branch or commit in its `meta`, and wait for `READY` by asking again, not more than once every half minute.

Promoting a deployment makes it the live site and waits for approval every time. Say which deployment you want promoted and why before you call.
