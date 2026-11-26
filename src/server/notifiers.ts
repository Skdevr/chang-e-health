import nodemailer from 'nodemailer';
import { redactSecrets } from '../lib/securityAndDocker';
import type { AlertDeliveryStatus } from '../types/health';

export interface NotificationResult {
  deliveryStatus: AlertDeliveryStatus;
  deliveryNote: string;
  latencyMs: number;
}

export function isSmtpConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASS?.trim()
  );
}

export function isTelegramConfigured(): boolean {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  return Boolean(token && chatId);
}

export function getTelegramChatIdFromEnv(): string | null {
  const raw = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!raw) return null;
  // Numeric Telegram chat ID (positive user/bot ID or negative group/supergroup ID)
  if (/^-?\d+$/.test(raw)) {
    return raw;
  }
  return raw;
}

export async function sendEmailAlert(params: {
  recipients: string[];
  subject: string;
  text: string;
}): Promise<NotificationResult> {
  const started = Date.now();
  const recipients = params.recipients.filter(Boolean);

  if (recipients.length === 0) {
    return {
      deliveryStatus: 'failed',
      deliveryNote: 'Nenhum destinatário de e-mail configurado.',
      latencyMs: Date.now() - started,
    };
  }

  if (!isSmtpConfigured()) {
    return {
      deliveryStatus: 'queued_preview',
      deliveryNote:
        'Registrado localmente (aguardando credenciais SMTP nas variáveis de ambiente).',
      latencyMs: Math.max(12, Date.now() - started),
    };
  }

  try {
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      connectionTimeout: 5000,
      greetingTimeout: 5000,
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipients.join(', '),
      subject: params.subject,
      text: redactSecrets(params.text),
    });

    return {
      deliveryStatus: 'sent_live',
      deliveryNote: `Entregue via SMTP para ${recipients.length} destinatário(s).`,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : 'Erro desconhecido SMTP';
    return {
      deliveryStatus: 'failed',
      deliveryNote: `Falha na entrega SMTP: ${redactSecrets(rawMsg)}`,
      latencyMs: Date.now() - started,
    };
  }
}

export async function sendTelegramAlert(params: {
  message: string;
}): Promise<NotificationResult> {
  const started = Date.now();

  if (!isTelegramConfigured()) {
    return {
      deliveryStatus: 'queued_preview',
      deliveryNote:
        'Registrado localmente (aguardando credenciais do Bot Telegram nas variáveis de ambiente).',
      latencyMs: Math.max(14, Date.now() - started),
    };
  }

  const token = process.env.TELEGRAM_BOT_TOKEN!.trim();
  const chatId = getTelegramChatIdFromEnv()!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: redactSecrets(params.message),
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      return {
        deliveryStatus: 'failed',
        deliveryNote: `Telegram API retornou HTTP ${response.status}. Verifique as credenciais no servidor.`,
        latencyMs: Date.now() - started,
      };
    }

    return {
      deliveryStatus: 'sent_live',
      deliveryNote: 'Mensagem entregue com sucesso via Telegram Bot API.',
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : 'Timeout ao contatar Telegram API';
    return {
      deliveryStatus: 'failed',
      deliveryNote: `Falha ao enviar para Telegram: ${redactSecrets(rawMsg)}`,
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
