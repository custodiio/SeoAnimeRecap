const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
async function run() {
  try {
    const res = await openai.chat.completions.create({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'Escreva 1 frase e no final o JSON { ok: true }.' }],
      max_tokens: 100,
      extra_body: { thinking: { type: "disabled" } }
    });
    console.log("CONTENT:", res.choices[0].message.content);
    console.log("REASONING:", res.choices[0].message.reasoning_content);
  } catch (e) {
    console.error('Error:', e.message);
  }
}
run();
