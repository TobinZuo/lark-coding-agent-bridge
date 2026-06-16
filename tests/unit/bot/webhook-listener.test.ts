import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { processWebhookPayload } from '../../../src/bot/webhook-listener';
import type { LarkBotListenerConfig } from '../../../src/config/schema';

const listener: LarkBotListenerConfig = {
  enabled: true,
  webhookPath: '/lark/events',
};

describe('lark webhook payload processing', () => {
  it('answers URL verification challenges', () => {
    const body = JSON.stringify({
      challenge: 'challenge-ok',
      token: 'verify-token',
      type: 'url_verification',
    });

    const result = processWebhookPayload({
      body,
      listener,
      verificationToken: 'verify-token',
      encryptKey: 'encrypt-secret',
      botOpenId: 'ou_bot',
    });

    expect(result).toEqual({
      status: 200,
      response: { challenge: 'challenge-ok' },
    });
  });

  it('normalizes signed message receive events', () => {
    const body = JSON.stringify(messagePayload());
    const result = processWebhookPayload({
      body,
      headers: signedHeaders(body),
      listener,
      verificationToken: 'verify-token',
      encryptKey: 'encrypt-secret',
      botOpenId: 'ou_bot',
    });

    expect(result.status).toBe(200);
    expect(result.response).toEqual({ ok: true });
    expect(result.message).toMatchObject({
      messageId: 'om_alarm',
      chatId: 'oc_alarm',
      rawContentType: 'interactive',
      content: expect.stringContaining('5xx spike'),
    });
  });

  it('rejects invalid signatures', () => {
    const result = processWebhookPayload({
      body: JSON.stringify(messagePayload()),
      headers: {
        'x-lark-request-timestamp': '1700000000',
        'x-lark-request-nonce': 'nonce',
        'x-lark-signature': '00',
      },
      listener,
      verificationToken: 'verify-token',
      encryptKey: 'encrypt-secret',
      botOpenId: 'ou_bot',
    });

    expect(result).toEqual({
      status: 401,
      response: { ok: false, error: 'invalid_signature' },
    });
  });
});

function messagePayload(): unknown {
  return {
    schema: '2.0',
    header: {
      event_type: 'im.message.receive_v1',
      token: 'verify-token',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou_alert_bot' },
        sender_type: 'app',
      },
      message: {
        message_id: 'om_alarm',
        chat_id: 'oc_alarm',
        chat_type: 'group',
        message_type: 'interactive',
        content: JSON.stringify({
          header: { title: { content: 'P0 alarm' } },
          body: { elements: [{ tag: 'markdown', content: '5xx spike' }] },
        }),
      },
    },
  };
}

function signedHeaders(body: string): Record<string, string> {
  return {
    'x-lark-request-timestamp': '1700000000',
    'x-lark-request-nonce': 'nonce',
    'x-lark-signature': createHash('sha256')
      .update('1700000000')
      .update('nonce')
      .update('encrypt-secret')
      .update(body)
      .digest('hex'),
  };
}
