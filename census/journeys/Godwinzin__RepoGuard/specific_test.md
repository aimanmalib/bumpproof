---
mode: testing
url: http://127.0.0.1:{port}{path}
max_steps: 25
---

# Follow the public links from the login page

The app's API server is not part of the sandbox, so this journey stays on the public pages.

## The login page loads
Verify the heading "Welcome to RepoGuard" is visible with links "Docs", "Privacy" and "Terms" below it.

## Open the docs
Click the "Docs" link. Verify the address ends with "/docs" and the heading "Documentation" is shown.

## Open the privacy policy
Go back to the login page and click the "Privacy" link. Verify the address ends with "/privacy" and the title "Privacy Policy" is shown.
