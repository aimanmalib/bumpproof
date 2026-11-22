---
test: ../account_test.md
status: passed
started: 2026-11-22T01:47:22.557Z
duration_s: 182
session_id: 5fcc9a22-f662-422d-8ecf-4dde564a49e0
---

# Account orders — Result

## Open the orders tab ✓ passed (45.2s)
md5: fc4f93b114a85cd025f2e8aeb8f66406
Verify the heading "Your account" is shown. Click the "Orders" tab. Verify the heading "Past orders" lists order "#1042" and order "#1057".

## Open an order ✓ passed (40.8s)
md5: 3839f490172f71a869930776072e9323
Click order "#1042". Verify the heading "Order 1042" is shown with "Sencha, 50 g × 2" and the total "$42.00".

## Go back to the account ✓ passed (29.9s)
md5: d16c4dba80085123552a6ca5cb0e74ec
Click "Back to account". Verify the text "Signed in as a demo customer." is shown and the URL path is "/account".

## Use the tabs again ✓ passed (34.3s)
md5: 9144c4f5c39e8a72d4ef92080e5d3731
Click the "Orders" tab, then click the "Overview" tab. Verify the text "Signed in as a demo customer." is shown.
