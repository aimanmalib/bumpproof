---
mode: testing
url: http://127.0.0.1:{port}/trips
max_steps: 25
---

# Trips, summary and settings

## The empty trips page
Verify the text "Tap the plus button to get started!" is shown and the bottom navigation shows "Trips", "Summary", "History" and "Settings".

## Open the summary
Click "Summary" in the bottom navigation. Verify the tabs "Last 7 Days", "Last 30 Days" and "This Year" and the card "Total Miles" are shown.

## Switch to this year
Click the "This Year" tab. Verify the card "Total Net" is still shown.

## Open the settings
Click "Settings" in the bottom navigation. Verify a "Name" field and a "Vehicles" section are shown.
