// Email Service - Postmark HTTP API
const config = require('../config');

// HTML escape to prevent XSS in email templates
const escapeHtml = (str) => {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
};

// Check if email is enabled
let emailEnabled = false;
if (config.POSTMARK_API_KEY) {
  emailEnabled = true;
  console.log('✅ Email configured (Postmark HTTP API)');
} else {
  console.warn('⚠️ POSTMARK_API_KEY not set - emails will be disabled');
}

// Email template base styles
const styles = {
  wrapper: 'background-color: #0a0a15; padding: 40px 20px;',
  container: 'max-width: 420px; margin: 0 auto; background: linear-gradient(180deg, rgba(139,92,246,0.08) 0%, rgba(10,10,21,1) 100%); border: 1px solid rgba(139,92,246,0.2); border-radius: 20px; overflow: hidden;',
  header: 'background: linear-gradient(135deg, #8b5cf6, #7c3aed); padding: 28px 24px; text-align: center;',
  logo: 'width: 56px; height: 56px; border-radius: 14px; margin-bottom: 12px;',
  brand: 'font-size: 18px; font-weight: 700; color: #fff; margin: 0; letter-spacing: 0.5px;',
  body: 'padding: 28px 24px;',
  title: 'font-size: 22px; font-weight: 700; color: #fff; margin: 0 0 16px 0; text-align: center;',
  text: 'font-size: 15px; color: rgba(255,255,255,0.7); line-height: 1.6; margin: 0 0 16px 0; text-align: center;',
  button: 'display: block; width: 100%; padding: 16px 24px; background: linear-gradient(135deg, #8b5cf6, #a78bfa); color: #fff; text-decoration: none; text-align: center; border-radius: 12px; font-weight: 600; font-size: 15px; box-sizing: border-box;',
  buttonContainer: 'margin: 24px 0;',
  card: 'background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 16px; margin: 16px 0;',
  cardSuccess: 'background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.2); border-radius: 12px; padding: 16px; margin: 16px 0;',
  cardWarning: 'background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.2); border-radius: 12px; padding: 16px; margin: 16px 0;',
  cardInfo: 'background: rgba(139,92,246,0.1); border: 1px solid rgba(139,92,246,0.2); border-radius: 12px; padding: 16px; margin: 16px 0;',
  footer: 'text-align: center; padding: 20px 24px; background: rgba(0,0,0,0.3); border-top: 1px solid rgba(255,255,255,0.05);',
  footerText: 'font-size: 12px; color: rgba(255,255,255,0.4); margin: 0;',
  footerLink: 'color: #a78bfa; text-decoration: none;',
  highlight: 'color: #a78bfa; font-weight: 600;',
  emoji: 'font-size: 48px; text-align: center; margin-bottom: 16px;'
};

// Email template generator
const generateEmailHTML = (content) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <title>Flatwater by Lunar</title>
  <!--[if mso]>
  <style type="text/css">
    body, table, td { font-family: Arial, sans-serif !important; }
  </style>
  <![endif]-->
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased; ${styles.wrapper}">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #0a0a15;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="${styles.container}">
          <tr>
            <td style="${styles.header}">
              <img src="${config.APP_URL}/img/lunar-logo.png" alt="Lunar" width="56" height="56" style="${styles.logo}" />
              <p style="${styles.brand}">FLATWATER by LUNAR</p>
            </td>
          </tr>
          <tr>
            <td style="${styles.body}">
              ${content}
            </td>
          </tr>
          <tr>
            <td style="${styles.footer}">
              <p style="${styles.footerText}">© ${new Date().getFullYear()} Flatwater by Lunar. All rights reserved.</p>
              <p style="${styles.footerText}"><a href="${config.APP_URL}" style="${styles.footerLink}">flatwater.space</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

// Email templates
const templates = {
  registrationPending: (username) => ({
    subject: '⏳ Welcome to Flatwater! Account Pending',
    html: generateEmailHTML(`
      <div style="${styles.emoji}">⏳</div>
      <h2 style="${styles.title}">Welcome, ${escapeHtml(username)}!</h2>
      <p style="${styles.text}">
        Thank you for registering at <span style="${styles.highlight}">Flatwater by Lunar</span>!
      </p>
      <p style="${styles.text}">
        Your account is now <span style="${styles.highlight}">pending approval</span>. 
        You'll receive another email once it's activated.
      </p>
      <div style="${styles.cardInfo}">
        <p style="${styles.text}; margin: 0; font-size: 14px;">
          ⏱️ Approval usually takes less than 24 hours
        </p>
      </div>
      <p style="${styles.text}; margin-top: 24px;">
        See you on the water soon! 🌊
      </p>
    `)
  }),

  accountApproved: (username) => ({
    subject: '🎉 Your Flatwater Account is Approved!',
    html: generateEmailHTML(`
      <div style="${styles.emoji}">🎉</div>
      <h2 style="${styles.title}">You're In, ${escapeHtml(username)}!</h2>
      <p style="${styles.text}">
        Great news! Your account has been approved. You can now log in and start tracking your wakeboarding progression!
      </p>
      <div style="${styles.buttonContainer}">
        <a href="${config.APP_URL}" style="${styles.button}">Let's Ride! 🏄</a>
      </div>
      <div style="${styles.cardSuccess}">
        <p style="${styles.text}; margin: 0; font-size: 14px; text-align: left;">
          🏋️ Track your tricks in <strong>Train</strong><br>
          📚 Learn from articles in <strong>Learn</strong><br>
          📅 Join sessions in <strong>Calendar</strong><br>
          👥 Connect with the <strong>Crew</strong>
        </p>
      </div>
    `)
  }),

  passwordReset: (username, resetToken) => ({
    subject: '🔐 Reset Your Password',
    html: generateEmailHTML(`
      <div style="${styles.emoji}">🔐</div>
      <h2 style="${styles.title}">Password Reset</h2>
      <p style="${styles.text}">
        Hi ${escapeHtml(username)}, we received a request to reset your password.
      </p>
      <p style="${styles.text}">
        Click the button below to create a new password:
      </p>
      <div style="${styles.buttonContainer}">
        <a href="${config.APP_URL}?reset=${resetToken}" style="${styles.button}; background: linear-gradient(135deg, #ef4444, #f87171);">Reset Password</a>
      </div>
      <div style="${styles.cardWarning}">
        <p style="${styles.text}; margin: 0; font-size: 13px;">
          ⚠️ This link expires in <strong style="color: #ef4444;">1 hour</strong>.<br><br>
          If you didn't request this, you can safely ignore this email.
        </p>
      </div>
    `)
  }),

  passwordChanged: (username) => ({
    subject: '🔒 Password Changed Successfully',
    html: generateEmailHTML(`
      <div style="${styles.emoji}">🔒</div>
      <h2 style="${styles.title}">Password Updated</h2>
      <p style="${styles.text}">
        Hi ${escapeHtml(username)}, your password has been successfully changed.
      </p>
      <div style="${styles.cardSuccess}">
        <p style="${styles.text}; margin: 0; font-size: 14px;">
          ✅ Your account is now secured with your new password.
        </p>
      </div>
      <div style="${styles.buttonContainer}">
        <a href="${config.APP_URL}" style="${styles.button}">Log In Now</a>
      </div>
      <p style="${styles.text}; font-size: 13px; color: rgba(255,255,255,0.5);">
        If you didn't make this change, please contact us immediately.
      </p>
    `)
  }),

  purchaseConfirmation: (username, product, price, orderId) => ({
    subject: '🛒 Order Confirmed: ' + escapeHtml(product),
    html: generateEmailHTML(`
      <div style="${styles.emoji}">🛒</div>
      <h2 style="${styles.title}">Thanks for your order!</h2>
      <p style="${styles.text}">
        Hi ${escapeHtml(username)}, your purchase has been confirmed.
      </p>
      <div style="${styles.card}">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding: 8px 0; font-size: 14px; color: rgba(255,255,255,0.5);">Order ID</td>
            <td style="padding: 8px 0; font-size: 14px; color: #fff; text-align: right; font-family: monospace;">${escapeHtml(orderId)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-size: 14px; color: rgba(255,255,255,0.5);">Product</td>
            <td style="padding: 8px 0; font-size: 14px; color: #fff; text-align: right;">${escapeHtml(product)}</td>
          </tr>
          <tr>
            <td style="padding: 12px 0 0; font-size: 16px; font-weight: 600; color: rgba(255,255,255,0.7); border-top: 1px solid rgba(255,255,255,0.1);">Total</td>
            <td style="padding: 12px 0 0; font-size: 20px; font-weight: 700; color: #22c55e; text-align: right; border-top: 1px solid rgba(255,255,255,0.1);">${escapeHtml(String(price))} €</td>
          </tr>
        </table>
      </div>
      <p style="${styles.text}; font-size: 13px; color: rgba(255,255,255,0.5);">
        Thank you for your purchase! If you have any questions, please contact us.
      </p>
    `)
  }),

  newNews: (username, title, message, emoji = '📢') => ({
    subject: emoji + ' ' + escapeHtml(title),
    html: generateEmailHTML(`
      <div style="${styles.emoji}">${escapeHtml(emoji)}</div>
      <h2 style="${styles.title}">Hey ${escapeHtml(username)}!</h2>
      <p style="${styles.text}">We have news for you:</p>
      <div style="background: rgba(59,130,246,0.1); border: 1px solid rgba(59,130,246,0.2); border-radius: 12px; padding: 20px; margin: 16px 0;">
        <h3 style="color: #fff; font-size: 18px; margin: 0 0 8px 0; text-align: center;">${escapeHtml(title)}</h3>
        <p style="${styles.text}; margin: 0; text-align: left;">${escapeHtml(message)}</p>
      </div>
      <div style="${styles.buttonContainer}">
        <a href="${config.APP_URL}" style="${styles.button}; background: linear-gradient(135deg, #3b82f6, #60a5fa);">Read More</a>
      </div>
    `)
  }),

  achievementUnlocked: (username, achievementName, achievementIcon, tier) => ({
    subject: '🏆 Achievement Unlocked: ' + escapeHtml(achievementName) + '!',
    html: generateEmailHTML(`
      <div style="${styles.emoji}">${escapeHtml(achievementIcon)}</div>
      <h2 style="${styles.title}">Achievement Unlocked!</h2>
      <p style="${styles.text}">
        Congratulations ${escapeHtml(username)}! You've earned a new achievement:
      </p>
      <div style="background: rgba(234,179,8,0.1); border: 1px solid rgba(234,179,8,0.2); border-radius: 16px; padding: 24px; margin: 16px 0; text-align: center;">
        <div style="font-size: 48px; margin-bottom: 8px;">${escapeHtml(achievementIcon)}</div>
        <h3 style="color: #fff; font-size: 20px; margin: 0 0 8px 0;">${escapeHtml(achievementName)}</h3>
        <span style="display: inline-block; padding: 6px 16px; background: rgba(234,179,8,0.2); border-radius: 20px; font-size: 12px; font-weight: 700; color: #eab308; text-transform: uppercase;">${escapeHtml(tier)} Tier</span>
      </div>
      <div style="${styles.buttonContainer}">
        <a href="${config.APP_URL}" style="${styles.button}; background: linear-gradient(135deg, #eab308, #fbbf24);">View All Achievements</a>
      </div>
      <p style="${styles.text}">Keep up the great work! 💪</p>
    `)
  })
};

// Send email using Postmark HTTP API
const sendEmail = async (to, template) => {
  if (!emailEnabled || !config.POSTMARK_API_KEY) {
    console.warn('Email not sent - Postmark not configured');
    return { success: false, error: 'Email not configured' };
  }
  
  try {
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': config.POSTMARK_API_KEY
      },
      body: JSON.stringify({
        From: config.EMAIL_FROM,
        To: to,
        Subject: template.subject,
        HtmlBody: template.html
      })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      console.log(`✉️ Email sent to ${to}: ${template.subject}`);
      return { success: true, messageId: data.MessageID };
    } else {
      console.error(`❌ Email failed to ${to}:`, data.Message || data.ErrorCode);
      return { success: false, error: data.Message || data.ErrorCode };
    }
  } catch (error) {
    console.error(`❌ Email failed to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
};

module.exports = {
  sendEmail,
  templates,
  escapeHtml,
  isEnabled: () => emailEnabled
};
