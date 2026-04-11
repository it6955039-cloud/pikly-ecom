import { Injectable, Logger } from '@nestjs/common'
import * as nodemailer from 'nodemailer'

// MailService handles all transactional emails via Nodemailer + Gmail SMTP.
//
// Setup required (one-time):
//   1. Enable 2-Step Verification on your Gmail account.
//   2. Go to Google Account → Security → App Passwords → generate one.
//   3. Set MAIL_USER=youraddress@gmail.com and MAIL_PASS=<app-password> in .env.
//
// The transporter is created lazily (on first use) rather than at module init
// so that a missing MAIL_USER/MAIL_PASS does not crash the entire app on startup
// — the error only surfaces when an email is actually attempted.
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name)
  private transporter: nodemailer.Transporter | null = null

  private getTransporter(): nodemailer.Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.MAIL_USER,
          pass: process.env.MAIL_PASS,
        },
      })
    }
    return this.transporter
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
      // In development without email configured, log instead of crashing.
      this.logger.warn(
        `[DEV] Email not sent (MAIL_USER/MAIL_PASS not set). Subject: "${subject}" → ${to}`,
      )
      return
    }
    try {
      await this.getTransporter().sendMail({
        from: `"Pikly Store" <${process.env.MAIL_USER}>`,
        to,
        subject,
        html,
      })
      this.logger.log(`Email sent: "${subject}" → ${to}`)
    } catch (err: any) {
      // Log but do not throw — email failure should never break a user-facing
      // request. The calling code should handle degraded behaviour gracefully.
      this.logger.error(`Failed to send email to ${to}: ${err.message}`)
    }
  }

  // ── Email verification (SEC-02) ──────────────────────────────────────────

  async sendVerificationEmail(to: string, firstName: string, token: string): Promise<void> {
    const url = `${process.env.APP_URL ?? 'http://localhost:3000'}/api/v1/auth/verify-email?token=${token}`
    await this.send(
      to,
      'Verify your Pikly Store account',
      `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#2563eb">Welcome to Pikly Store, ${firstName}!</h2>
        <p>Please verify your email address to activate your account.</p>
        <a href="${url}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0">
          Verify Email
        </a>
        <p style="color:#6b7280;font-size:14px">This link expires in 24 hours. If you did not create an account, ignore this email.</p>
        <p style="color:#9ca3af;font-size:12px">Or copy this URL: ${url}</p>
      </div>
    `,
    )
  }

  // ── Password reset (SEC-03) ──────────────────────────────────────────────

  async sendPasswordResetEmail(to: string, firstName: string, token: string): Promise<void> {
    const url = `${process.env.APP_URL ?? 'http://localhost:3000'}/api/v1/auth/reset-password?token=${token}`
    await this.send(
      to,
      'Reset your Pikly Store password',
      `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#2563eb">Password Reset Request</h2>
        <p>Hi ${firstName}, we received a request to reset your password.</p>
        <a href="${url}" style="display:inline-block;padding:12px 24px;background:#dc2626;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0">
          Reset Password
        </a>
        <p style="color:#6b7280;font-size:14px">This link expires in 15 minutes. If you did not request a reset, ignore this email — your account is safe.</p>
        <p style="color:#9ca3af;font-size:12px">Or copy this URL: ${url}</p>
      </div>
    `,
    )
  }

  // ── Order confirmation (FEAT-06) ─────────────────────────────────────────

  async sendOrderConfirmation(to: string, firstName: string, order: any): Promise<void> {
    const itemRows = (order.items ?? [])
      .map(
        (item: any) =>
          `<tr>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb">${item.title}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:center">${item.quantity}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right">$${item.subtotal?.toFixed(2)}</td>
      </tr>`,
      )
      .join('')

    await this.send(
      to,
      `Order Confirmed — ${order.orderId}`,
      `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#2563eb">Order Confirmed!</h2>
        <p>Hi ${firstName}, thank you for your order.</p>
        <p><strong>Order ID:</strong> ${order.orderId}</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <thead>
            <tr style="background:#f3f4f6">
              <th style="padding:8px;text-align:left">Product</th>
              <th style="padding:8px;text-align:center">Qty</th>
              <th style="padding:8px;text-align:right">Subtotal</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
        </table>
        <p><strong>Total:</strong> $${order.pricing?.total?.toFixed(2)}</p>
        <p><strong>Payment:</strong> ${order.paymentMethod?.toUpperCase()}</p>
        <p style="color:#6b7280;font-size:14px">Estimated delivery: ${order.estimatedDelivery ? new Date(order.estimatedDelivery).toDateString() : 'TBD'}</p>
      </div>
    `,
    )
  }

  // ── Order shipped (FEAT-06) ──────────────────────────────────────────────

  async sendShippingNotification(to: string, firstName: string, order: any): Promise<void> {
    await this.send(
      to,
      `Your order ${order.orderId} has shipped!`,
      `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#059669">Your Order Has Shipped!</h2>
        <p>Hi ${firstName}, great news — your order is on its way.</p>
        <p><strong>Order ID:</strong> ${order.orderId}</p>
        <p><strong>Tracking Number:</strong> ${order.trackingNumber ?? 'Not available yet'}</p>
        <p><strong>Estimated Delivery:</strong> ${order.estimatedDelivery ? new Date(order.estimatedDelivery).toDateString() : 'TBD'}</p>
      </div>
    `,
    )
  }
}
