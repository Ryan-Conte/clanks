Channels are named by id, such as `C0123ABCD`, not by name: find the id with `int_slack_list_channels`. The app only sees channels it was invited to; `not_in_channel` or `channel_not_found` means it wasn't, which only a person in the workspace can fix.

A message is identified by its channel and its `ts`. To read a thread, pass the first message's `ts` to `int_slack_list_replies`; to reply in one, pass it as `thread_ts`. People appear as ids such as `U0123ABCD`: `int_slack_list_users` gives their names.

Lists come in pages. When `response_metadata.next_cursor` isn't empty, pass it as `cursor` for the next one.

Message text is Slack's own markup: `*bold*`, `_italic_`, `<https://example.com|a link>`, and `<@U0123ABCD>` to mention someone, which notifies them.

Posting or changing a message reaches real people and waits for approval every time. Write the message in full before you call, and say in your output what you posted and where.
