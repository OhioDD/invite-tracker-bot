import 'dotenv/config';

const schema = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    reason: { type: 'string' },
    legitimate_dm_count: { type: 'integer' }
  },
  required: ['approved', 'reason', 'legitimate_dm_count']
};

const r = await fetch('https://ollama.com/api/chat', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: process.env.OLLAMA_CLOUD_MODEL || 'gemma3:12b-cloud',
    messages: [
      {
        role: 'user',
        content:
          'You must respond with ONLY valid JSON, no markdown. {"approved":false,"reason":"test","legitimate_dm_count":0}'
      }
    ],
    stream: false,
    format: schema
  })
});

const d = await r.json();
console.log('status', r.status);
console.log('error', d.error);
console.log('content type:', typeof d.message?.content);
console.log('content:', d.message?.content?.slice?.(0, 500));
