---
test: ../checkout_test.md
status: passed
started: 2026-11-22T01:44:00.674Z
duration_s: 166
session_id: 50cdb6bd-537d-4ff8-90cf-99974a44edc5
---

# Checkout — Result

## Add a product to the cart ✓ passed (27s)
md5: 53af0a3e7c73b1d77b42869854e2efd1
Click "Add to cart". Verify the text "Added to cart" appears and the header link reads "Cart (1)".

## Review the cart ✓ passed (33s)
md5: 90499e6cd60361cf048334c9d277eb98
Click the "Cart (1)" link in the header. Verify the cart lists "Sencha, 50 g" and the Total is "$16.50".

## Fill in the checkout form ✓ passed (36.2s)
md5: e5dc2d6dc9e89ec039b975f70e56f1e8
Click "Go to checkout". Type "Ada Lovelace" into Full name, "ada@example.com" into Email and "1 Tea Street" into Delivery address.

## Place the order ✓ passed (36.7s)
md5: afb1cbb28ba5b8495363724516d7e00e
Click "Place order". Verify the heading "Order placed" is shown, "Amount charged" is "$16.50", and an "Arrives by" date is shown.
