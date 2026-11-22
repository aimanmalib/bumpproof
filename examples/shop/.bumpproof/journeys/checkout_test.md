---
mode: testing
url: http://127.0.0.1:4173/shop/tea/sencha-50
max_steps: 30
---

# Checkout

## Add a product to the cart
Click "Add to cart". Verify the text "Added to cart" appears and the header link reads "Cart (1)".

## Review the cart
Click the "Cart (1)" link in the header. Verify the cart lists "Sencha, 50 g" and the Total is "$16.50".

## Fill in the checkout form
Click "Go to checkout". Type "Ada Lovelace" into Full name, "ada@example.com" into Email and "1 Tea Street" into Delivery address.

## Place the order
Click "Place order". Verify the heading "Order placed" is shown, "Amount charged" is "$16.50", and an "Arrives by" date is shown.
