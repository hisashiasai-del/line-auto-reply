const axios = require('axios');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = 'あなたはLIS Sales Japanの営業・採用担当者の代理として、LINE公式アカウントに届いたお客様・候補者からのメッセージに返信する役割を担います。これまでのやり取りの文脈を踏まえ、丁寧で簡潔な日本語のビジネス文体で返信してください。日程確定や条件確約など、断定的な約束はせず、必要に応じて担当者より追ってご連絡いたしますという形にしてください。返信本文のみを出力してください。';

async function generateReply(history) {
  const conversationText = history
    .map((m) => (m.sender === 'user' ? 'お客様' : 'スタッフ') + ': ' + m.text)
    .join('\n');

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: 'これまでのやり取り:\n' + conversationText + '\n\n上記を踏まえて、お客様への返信文を作成してください。',
        },
      ],
    },
    {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    }
  );

  const textBlock = res.data.content.find((c) => c.type === 'text');
  return textBlock ? textBlock.text.trim() : null;
}

module.exports = { generateReply };
