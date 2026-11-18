---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.2"
---

# ACP console session survives cookie deletion or a browser close, or the login page shows the previous account

## Issue

The platform web console keeps, loses, or reuses a login in a way the user does not expect. One of these is seen:

- After logging in and deleting the site's cookies, a page refresh keeps the account logged in; the user is not logged out. This is often found during a security assessment.
- With "end the session when all product tabs are closed" enabled, closing the browser and opening the platform again goes straight in without a login.
- Users can log in only after clearing the browser cache and restarting the browser.
- The login page says the license code has expired, although the license is still valid.
- After a direct local Dex login URL is opened, the form accepts account B but the session shown is still account A.
- The Service Mesh page says that no authorization token was provided, while the console login itself works.

Related articles: "Forgotten local admin password on ACP: reset the password hash, set a chosen password, and password policy limits" covers local passwords. "kubectl returns the server has asked for the client to provide credentials after ac login, or ac login fails, on ACP" covers the CLI.

## Root Cause

### Cause 1: login session data is also kept in the browser's local storage

The console stores data in the browser's Local Storage (keys such as `meepo-project` and `theme-mode`) as well as in cookies, and part of the login state is kept in Local Storage. Deleting only the cookies leaves that state, and the next page load restores the login. Clearing both cookies and Local Storage for the platform site logs the user out.

### Cause 2: the session ends about 30 seconds after the last product tab closes

On 4.2, Access Control offers "end the session when all product tabs are closed". The browser does not clear the session at the instant it closes; the front end calls the logout API through its multi-tab mechanism, and that call is delayed. The session therefore stays valid for about 30 seconds after the last product tab closes. Reopening within that window does not ask for a login; after it, a login is required. This is the designed behavior.

### Cause 3: the login page sat idle until its session cookie expired

The login page was left open with no activity until its session cookie expired, so submitting the stale form fails. Reopening the platform access URL, or clearing the cache, loads a fresh form. This is expected.

### Cause 4: the license-expired message is stale page cache

A license-expired message that does not appear in an incognito window comes from cached page content, not from the license. Retyping the platform address does not clear it.

### Cause 5: a direct Dex login URL reuses the previous account's cached token

On 4.2, account A logs in and the browser is closed without logging out. A direct local Dex URL (path `/console-dex/login/local` with `client_id=alauda-auth` and `redirect_uri` pointing at `/console-portal`) is then opened and account B is entered. The browser still holds A's token, and that URL uses the cached token instead of B's credentials, so the session is A's. Whether it reproduces depends on the browser.

### Cause 6: the token held by a long-open page has expired

On 3.18 the Service Mesh page reports that no authorization token was provided after the browser session has been open long enough for its token to expire. The page has nothing valid to send. A fresh login gets a new token.

## Resolution

### Cause 1: login session data is also kept in the browser's local storage

1. Open the browser developer tools (F12) on the platform page, go to **Application**, and check both **Cookies** and **Local Storage** for the platform address.
2. Clear both for the platform site, or use **Clear site data**, then refresh. The user is logged out.
3. For a normal logout, use the console's logout action, which ends the session on the server instead of only removing browser data.

### Cause 2: the session ends about 30 seconds after the last product tab closes

No change is needed. Wait more than about 30 seconds after the last product tab closes before expecting a new login. This is not an idle-timeout setting.

### Cause 3: the login page sat idle until its session cookie expired

Open the platform access URL again, or clear the site cache, and log in. Do not treat this as a wrong password or a Dex fault when a fresh page accepts the same user.

### Cause 4: the license-expired message is stale page cache

Check the license validity date in the platform first. If it is still valid, open an incognito window, or clear the site cache, and log in. If a wrong-password error follows, it is a password problem, not the license.

### Cause 5: a direct Dex login URL reuses the previous account's cached token

Log out, or clear the site's cookies and Local Storage, before using `/console-dex/login/local` to switch accounts. No platform object needs to change.

### Cause 6: the token held by a long-open page has expired

Log out and log in again, or open the platform in an incognito window. The page then loads. No mesh configuration change is needed.

## Diagnostic Steps

1. On the platform page, open the developer tools (F12):
   - **Application** > **Cookies** and **Local Storage**: note which entries remain for the platform address.
   - **Network**: refresh, select a platform API request, and check whether it still carries `Cookie` or `Authorization`.
2. Open the same address in an incognito window and compare the behavior.

| What you see | Cause |
| --- | --- |
| Cookies deleted, refresh keeps the login, Local Storage still has entries; clearing it logs out | 1 |
| Session survives a browser close for less than about 30 seconds with tab-close logout enabled | 2 |
| Login works only after a cache clear, the form was left idle | 3 |
| License-expired text, license still valid, incognito window is clean | 4 |
| Direct Dex URL logs in as the previous user | 5 |
| Service Mesh page says no authorization token, a fresh login fixes it | 6 |
