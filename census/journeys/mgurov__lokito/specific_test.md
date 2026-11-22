---
mode: testing
url: http://127.0.0.1:{port}{path}
max_steps: 25
---

# Move between the start panel, sources and filters

The app's log server is not part of the sandbox, so this journey stays on pages that load without it.

## The start panel loads
Verify the top bar has the buttons "Sources" and "Filters" and the page shows start buttons including "last 5 min" and "last 1 hour".

## Open the sources page
Click "Sources" in the top bar. Verify the address ends with "/sources" and the page shows no error screen.

## Open the filters page
Click "Filters" in the top bar. Verify the address ends with "/filters" and the page shows no error screen.
