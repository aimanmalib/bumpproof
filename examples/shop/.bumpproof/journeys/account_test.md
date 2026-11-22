---
mode: testing
url: http://127.0.0.1:4173/account
max_steps: 30
---

# Account orders

## Open the orders tab
Verify the heading "Your account" is shown. Click the "Orders" tab. Verify the heading "Past orders" lists order "#1042" and order "#1057".

## Open an order
Click order "#1042". Verify the heading "Order 1042" is shown with "Sencha, 50 g × 2" and the total "$42.00".

## Go back to the account
Click "Back to account". Verify the text "Signed in as a demo customer." is shown and the URL path is "/account".

## Use the tabs again
Click the "Orders" tab, then click the "Overview" tab. Verify the text "Signed in as a demo customer." is shown.
