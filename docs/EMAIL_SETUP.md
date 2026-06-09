# Email setup (Resend)

All outgoing email goes through [Resend](https://resend.com) via the shared
helper in `utils/sendEmail.js`. Two flows use it:

- **Contact / mockup form** → `controllers/email.js` (admin notification + customer auto-reply)
- **Approval links & admin notifications** → `controllers/approval.js`

## One-time setup

1. **Verify the domain** in Resend (Domains → Add domain → `jointprinting.com`).
   Using Cloudflare auto-configure adds the DKIM/SPF/return-path DNS records for
   you. Wait until the domain status shows **Verified**.

2. **Create an API key**: Resend → API Keys → Create. It starts with `re_`.

3. **Set environment variables** (Render/host dashboard, and local `.env`):

   | Variable          | Required | Example                                            |
   |-------------------|----------|----------------------------------------------------|
   | `RESEND_API_KEY`  | ✅       | `re_xxxxxxxxxxxxxxxxxxxx`                           |
   | `EMAIL_FROM`      | ✅       | `Joint Printing <noreply@jointprinting.com>`       |
   | `EMAIL_TO`        | ✅       | `nate@jointprinting.com` (where contact forms go)  |
   | `APPROVAL_NOTIFY_EMAIL` | ⬜ | defaults to `EMAIL_FROM` then `nate@jointprinting.com` |

   > The address in `EMAIL_FROM` **must be on the verified domain**
   > (`@jointprinting.com`). Resend rejects sends from unverified domains.

## Notes

- The legacy `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` variables are
  no longer used and can be removed from the environment.
- Sent emails (and any failures/bounces) are visible in the Resend dashboard
  under **Emails**.
