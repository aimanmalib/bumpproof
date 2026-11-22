---
mode: testing
url: http://127.0.0.1:{port}{path}
max_steps: 25
---

# The reading page without its backend

The app's Spring backend is not part of the sandbox, so this journey checks the page shell and its error state only.

## The page loads
Verify the heading "TepMan's Tarot App" is visible with an intro paragraph in German below it.

## The spread list shows its error state
Wait until the text "Lade Legemuster..." is gone. Verify a message starting with "Fehler beim Laden" and a button "Erneut versuchen" are shown.

## Retry keeps the page working
Click "Erneut versuchen". Verify the page still shows the heading "TepMan's Tarot App" and a footer that starts with "Version".
