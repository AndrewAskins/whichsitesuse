# Transactional emails (Loops)

The app sends five emails, each a Loops transactional email. Create each one in Loops
(Transactional → New), paste the copy below, and insert every `{variable}` as a **data
variable** with exactly that name (Loops won't send if a data variable the template uses is
missing). Then copy its transactional ID into the env var named in its heading, on the API
service. The plain-text fallbacks the app logs live next to each send in the code; this file is
the copy for Loops.

Sender for all five: **WhichSitesUse <hello@whichsitesuse.com>** (the domain must be verified in
Loops first). Keep them plain: no images, one link or button each, so they land in the inbox
and the link is obvious.

## 1. Confirm your email: `LOOPS_TEMPLATE_VERIFY`

Data variables: `link`

- **Subject:** Confirm your email for WhichSitesUse
- **Preview text:** One click and your free credits are on their way.
- **Body:**

  Hi,

  Thanks for signing up. Confirm your email to finish creating your account (work emails get
  250 free credits once you do):

  **[Confirm my email]({link})**

  The link works once and lasts 24 hours. If you didn't sign up for WhichSitesUse, you can
  ignore this email and nothing will happen.

## 2. Sign-in link: `LOOPS_TEMPLATE_LOGIN`

Data variables: `link`

- **Subject:** Your WhichSitesUse sign-in link
- **Preview text:** It works once and lasts 30 minutes.
- **Body:**

  Hi,

  Here's your link to sign in to WhichSitesUse:

  **[Sign in]({link})**

  It works once and lasts 30 minutes. If you didn't ask for it, ignore this email; your account
  stays as it was.

## 3. Free credits approved: `LOOPS_TEMPLATE_CREDITS_APPROVED`

Data variables: `credits`, `accountUrl`

- **Subject:** Your free WhichSitesUse credits are in
- **Preview text:** {credits} credits are ready to use.
- **Body:**

  Hi,

  Thanks for the details. We've added {credits} free credits to your account, so you can start
  pulling site lists and lookups right away:

  **[Go to your account]({accountUrl})**

  Create an API key there, or connect WhichSitesUse in Claude or ChatGPT and sign in.

## 4. Free credits not approved: `LOOPS_TEMPLATE_CREDITS_DENIED`

Data variables: `accountUrl`

- **Subject:** About your WhichSitesUse free credit request
- **Preview text:** You can still buy credits any time.
- **Body:**

  Hi,

  Thanks for asking. We couldn't add free credits to this account, since they go to one person
  per company email. You can still buy credits whenever you need them, from a small top-up
  to a monthly plan:

  **[Go to your account]({accountUrl})**

  If you think we got this wrong, just reply to this email.

## 5. Abuse alert (to the admin): `LOOPS_TEMPLATE_ADMIN_ALERT`

Data variables: `subject`, `text`

Sent to `ADMIN_ALERT_EMAIL` when free grants in a day pass `ALERT_GRANTS_PER_DAY`, or one
network gets more than two grants in a week.

- **Subject:** [WhichSitesUse] {subject}
- **Preview text:** {subject}
- **Body:**

  {text}

  Review it in the admin view: https://api.whichsitesuse.com/admin
