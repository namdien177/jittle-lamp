# Admin logout returns a clean login form
Key: TC-0001
Tags: feature:login, module:admin

[Open] /login
[Login: ADMIN] sign in as the fixture admin
[Assert] the dashboard shows the welcome heading
[Act] open the account menu and choose "Sign out"

## Checkpoint: Logout returns to the login page
[Assert] the sign in form with Email and Password fields is visible
[Screenshot] login form after logout
