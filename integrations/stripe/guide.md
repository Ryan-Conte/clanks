Amounts are whole numbers in the currency's smallest unit: 2500 with `usd` is $25.00.

Lists return up to `limit` items (10 unless you say) under `data`. When `has_more` is true, pass the last item's `id` as `starting_after` for the next page.

In test mode no money moves. To pay a PaymentIntent the way a customer would, confirm it with a test payment method: `payment_method: pm_card_visa` succeeds and `pm_card_chargeDeclined` is declined. When you create one you will confirm yourself, pass `automatic_payment_methods: {"enabled": true, "allow_redirects": "never"}`. A paid intent has `status: succeeded`.

To check a checkout: find the session with `int_stripe_list_checkout_sessions`, read its `payment_status` and `payment_intent`, then look for the matching events with `int_stripe_list_events` and `type: checkout.session.completed`.

Never put a card number in a call. Charges and refunds, and every change to a live account, wait for approval.
