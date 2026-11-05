import type { Env, Order, Analysis } from "./types";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function extractOrderNumber(message: string, previous?: string | null): string | null {
  const match = message.toUpperCase().match(/\bORD-\d{3,}\b/);
  return match?.[0] ?? previous ?? null;
}
function detectIntent(message: string): string {
  const m = message.toLowerCase();
  if (/charged twice|duplicate charge|double charge|charged two times/.test(m)) return "Payment Issue";
  if (/refund|money back/.test(m)) return "Refund";
  if (/return|replacement|wrong product|wrong item/.test(m)) return "Return/Replacement";
  if (/where is my order|track|tracking|order status|delivery/.test(m)) return "Order Tracking";
  if (/human|agent|representative/.test(m)) return "Human Support";
  if (/price|feature|product information/.test(m)) return "Product Information";
  return "General FAQ";
}
function urgencyFor(message: string, intent: string): "Low" | "Medium" | "High" {
  if (intent === "Payment Issue" || intent === "Human Support" || /dispute|very late|two weeks|not arrived/.test(message.toLowerCase())) return "High";
  if (intent === "Refund" || intent === "Return/Replacement") return "Medium";
  return "Low";
}
async function getOrder(db: D1Database, orderNumber: string | null): Promise<Order | null> {
  if (!orderNumber) return null;
  return await db.prepare("SELECT * FROM orders WHERE order_number = ?").bind(orderNumber).first<Order>();
}
async function groqDraft(env: Env, input: {
  message: string; intent: string; urgency: string; orderNumber: string | null;
  order: Order | null; orderFound: boolean | null; history: Array<{role:string;content:string}>
}): Promise<string> {
  if (!env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured.");
  const system = `You are SupportAI, a concise and natural e-commerce WhatsApp support agent.
Use only facts in the supplied order record. Never invent order, payment, refund, delivery, tracking, customer or action details.
If orderFound is false, say the order number could not be found and ask the customer to check it.
If orderFound is null and an order lookup is needed, ask only for the order number.
If orderFound is true, answer directly using the supplied order facts. Do not ask for information already supplied.
For duplicate charges or disputed payments, mark the case for human review in the analysis, but do not claim a person was contacted, a refund was processed, or an investigation started.
Never claim to have performed an action unless this system actually did it.
Do not use email greetings, sign-offs, or long corporate paragraphs. Keep the reply to 1-4 short sentences.`;
  const payload = {
    model: "llama-3.3-70b-versatile",
    temperature: 0.2,
    max_tokens: 250,
    messages: [
      { role: "system", content: system },
      ...input.history.slice(-6),
      { role: "user", content: JSON.stringify({
        currentCustomerMessage: input.message, intent: input.intent, urgency: input.urgency,
        orderNumber: input.orderNumber, orderFound: input.orderFound, verifiedOrderRecord: input.order
      }) }
    ]
  };
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { "authorization": `Bearer ${env.GROQ_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Groq request failed (${response.status}).`);
  const data = await response.json() as any;
  const result = data.choices?.[0]?.message?.content;
  if (typeof result !== "string" || !result.trim()) throw new Error("Groq returned an empty response.");
  return result.trim();
}
async function handleAnalyze(request: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON request." }, 400); }
  const message = String(body.message ?? "").trim();
  if (!message) return json({ error: "Enter a customer message." }, 400);
  if (message.length > 5000) return json({ error: "Message is too long (maximum 5,000 characters)." }, 400);

  const conversationId = String(body.conversationId ?? crypto.randomUUID());
  const customerKey = String(body.customerKey ?? conversationId);
  const existing = await env.DB.prepare("SELECT messages_json, last_order_number FROM conversations WHERE id = ?").bind(conversationId).first<{messages_json:string;last_order_number:string|null}>();
  const history = existing?.messages_json ? JSON.parse(existing.messages_json) : [];
  const orderNumber = extractOrderNumber(message, existing?.last_order_number);
  const intent = detectIntent(message);
  const urgency = urgencyFor(message, intent);
  const humanReviewRequired = ["Payment Issue", "Human Support"].includes(intent) || (intent === "Refund" && /not arrived|overdue|late|two weeks|dispute/i.test(message));
  const orderRequired = ["Order Tracking", "Payment Issue", "Refund", "Return/Replacement"].includes(intent);
  const order = await getOrder(env.DB, orderNumber);
  const orderFound = orderNumber ? Boolean(order) : (orderRequired ? null : null);
  const responseText = await groqDraft(env, { message, intent, urgency, orderNumber, order, orderFound, history });
  const updatedHistory = [...history, { role: "user", content: message }, { role: "assistant", content: responseText }].slice(-12);
  await env.DB.prepare(`INSERT INTO conversations (id, customer_key, messages_json, last_order_number, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET messages_json=excluded.messages_json, last_order_number=excluded.last_order_number, updated_at=CURRENT_TIMESTAMP`)
    .bind(conversationId, customerKey, JSON.stringify(updatedHistory), orderNumber).run();

  const ticketId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO tickets (id, customer_message, intent, urgency, human_review_required, order_number, order_found, response, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(ticketId, message, intent, urgency, humanReviewRequired ? 1 : 0, orderNumber,
      orderNumber ? (order ? 1 : 0) : null, responseText, humanReviewRequired ? "Review Pending" : "AI Handled").run();

  const result: Analysis = { intent, urgency, humanReviewRequired, confidence: 0.9, orderNumber, orderFound, response: responseText, reason: humanReviewRequired ? "This request requires human review." : "Response drafted using the available support context.", order };
  return json({ ...result, conversationId, ticketId, status: humanReviewRequired ? "Review Pending" : "AI Handled" });
}
async function handleHistory(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("conversationId");
  if (!id) return json({ error: "conversationId is required." }, 400);
  const row = await env.DB.prepare("SELECT messages_json FROM conversations WHERE id = ?").bind(id).first<{messages_json:string}>();
  return json({ messages: row ? JSON.parse(row.messages_json) : [] });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: {
      "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type"
    }});
    if (url.pathname === "/api/health") return json({ ok: true, service: "SupportAI" });
    if (url.pathname === "/api/analyze" && request.method === "POST") {
      try { return await handleAnalyze(request, env); }
      catch (error) { return json({ error: error instanceof Error ? error.message : "Unable to analyze the message right now." }, 500); }
    }
    if (url.pathname === "/api/history" && request.method === "GET") return handleHistory(request, env);
    return env.ASSETS.fetch(request);
  }
};