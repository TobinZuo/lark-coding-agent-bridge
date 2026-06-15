import { describe, expect, it } from 'vitest';
import { normalizedMessageFromEventConsumerPayload } from '../../../src/bot/event-consumer';

describe('lark event consumer payload normalization', () => {
  it('normalizes flat lark-cli im.message.receive_v1 card events', () => {
    const msg = normalizedMessageFromEventConsumerPayload({
      message_id: 'om_alarm',
      chat_id: 'oc_alarm',
      chat_type: 'group',
      sender_id: 'ou_alert_bot',
      sender_type: 'app',
      message_type: 'interactive',
      create_time: '1700000000000',
      content: JSON.stringify({
        data: { template_id: 'tpl_alarm' },
        body: { elements: [{ tag: 'markdown', content: '服务报警: 5xx spike' }] },
      }),
    });

    expect(msg).toMatchObject({
      messageId: 'om_alarm',
      chatId: 'oc_alarm',
      chatType: 'group',
      senderId: 'ou_alert_bot',
      rawContentType: 'interactive',
      content: expect.stringContaining('5xx spike'),
    });
  });

  it('normalizes flat text events without requiring JSON content', () => {
    const msg = normalizedMessageFromEventConsumerPayload({
      message_id: 'om_text',
      chat_id: 'oc_chat',
      chat_type: 'group',
      sender_id: 'ou_user',
      message_type: 'text',
      content: 'hello bridge',
    });

    expect(msg).toMatchObject({
      messageId: 'om_text',
      content: 'hello bridge',
      rawContentType: 'text',
    });
  });

  it('ignores the bot itself', () => {
    const msg = normalizedMessageFromEventConsumerPayload({
      message_id: 'om_self',
      chat_id: 'oc_chat',
      sender_id: 'ou_bot',
      message_type: 'text',
      content: 'self message',
    }, 'ou_bot');

    expect(msg).toBeUndefined();
  });
});
