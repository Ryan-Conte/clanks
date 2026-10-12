You only see pages and databases that were shared with the integration. If something isn't found, it probably wasn't shared, which only a person can fix.

Ids are the 32 hex characters at the end of a page's address. A page's own fields are its `properties`; its text is in blocks, which you read with `int_notion_get_blocks` using the page's id as `block_id`.

A new page needs a `parent` and its title. Under a page: `{"parent": {"page_id": "…"}, "properties": {"title": {"title": [{"text": {"content": "Launch notes"}}]}}}`. In a database, use `{"database_id": "…"}` and the database's own property names, which `int_notion_get_database` lists.

Text is written as blocks: `{"type": "paragraph", "paragraph": {"rich_text": [{"text": {"content": "Hello"}}]}}`. Headings are `heading_2`, list items `bulleted_list_item`, tasks `to_do`.

Lists come in pages: when `has_more` is true, pass `next_cursor` as `start_cursor`.
