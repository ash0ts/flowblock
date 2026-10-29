import "./env";
const response = await fetch(
  "https://api.inference.wandb.ai/v1/chat/completions",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WANDB_API_KEY}`,
      "OpenAI-Project": `${process.env.WANDB_ENTITY}/${process.env.WANDB_PROJECT}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: 'Return exactly {"ok":true}' }],
      max_tokens: 500,
      temperature: 0.1,
      reasoning_effort: "low",
    }),
    signal: AbortSignal.timeout(30000),
  },
);
const body = await response.json();
console.log(
  JSON.stringify({
    status: response.status,
    error: body.error,
    content: body.choices?.[0]?.message?.content,
    usage: body.usage,
  }),
);
