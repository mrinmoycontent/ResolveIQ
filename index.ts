import type { Env, Order, Analysis } from "./types";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

function extractOrderNumber(
  message: string,
  previous?: string | null
): string | null {
  const match = message.toUpperCase().match(/\bORD-\d{3,}\b/);
  return match?.[0] ?? previous ?? null;
}

function detectIntent(message: string): string {
  const m = message.toLowerCase();

  if (/charged twice|duplicate charge|double charge|charged two times/.test(m))
    return "Payment Issue";

  if (/return|replacement|wrong product|wrong item/.test(m))
    return "Return/Replacement";

  if (/refund|money back/.test(m))
    return "Refund";

  if (/where is my order|track|tracking|order status|delivery/.test(m))
    return "Order Tracking";

  if (/human|agent|representative|real person/.test(m))
    return "Human Support";

  if (/price|feature|product information/.test(m))
    return "Product Information";

  return "General FAQ";
}

function urgencyFor(
  message: string,
  intent: string
): "Low" | "Medium" | "High" {
  const m = message.toLowerCase();

  if (
    intent === "Payment Issue" ||
    intent === "Human Support" ||
    /dispute|very late|two weeks|not arrived/.test(m)
  ) {
    return "High";
  }

  if (intent === "Refund" || intent === "Return/Replacement")
    return "Medium";

  return "Low";
}

function isPastDate(dateValue: string | null | undefined): boolean {
  if (!dateValue || !/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    return false;
  }

  const today = new Date().toISOString().slice(0, 10);
  return dateValue < today;
}

async function getOrder(
  db: D1Database,
  orderNumber: string | null
): Promise<Order | null> {
  if (!orderNumber) return null;

  return db
    .prepare("SELECT * FROM orders WHERE order_number = ?")
    .bind(orderNumber)
    .first<Order>();
}

async function groqDraft(
  env: Env,
  input: {
    message: string;
    intent: string;
    urgency: string;
    orderNumber: string | null;
    order: Order | null;
    orderFound: boolean | null;
    deliveryOverdue: boolean;
    history: ChatMessage[];
  }
): Promise<string> {
  // Deterministic response for a verified pending return/refund.
  // Groq cannot override this response or promise refund processing.
  if (
    input.intent === "Return/Replacement" &&
    input.order &&
    String(input.order.order_status).toLowerCase() === "return requested" &&
    String(input.order.refund_status).toLowerCase() === "refund pending"
  ) {
    return `Your return request for order ${input.orderNumber ?? "your order"} has been recorded, and the current refund status is Pending. The return procedure has not been verified in the available order record, so please confirm the instructions with support before sending the item back.`;
  }

  if (!env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not configured.");
  }

  const system = `
You are ResolveIQ, an AI-powered e-commerce customer support assistant.

Your job is to draft concise, helpful and natural customer support responses.

STRICT INFORMATION RULES:

1. Use only verified information supplied in the order record.
2. Never invent order numbers, payment details, refund status, tracking numbers, delivery dates or customer details.
3. If orderFound is false, explain that the order could not be found and ask the customer to verify the order number.
4. If an order number is required but missing, ask the customer to provide it.
5. If orderFound is true, use the verified order information to answer the customer.
6. Never claim that a refund has been processed unless the supplied record confirms it.
7. Never claim that an agent has been contacted or an investigation has started.
8. Payment disputes and duplicate charges require human review.
9. Do not claim to have sent a WhatsApp message.
10. Do not invent company policies, delivery guarantees or refund timelines.
11. Keep responses natural, polite and concise.
12. Use 1-4 short sentences.
13. Do not use email greetings or sign-offs.
14. If the customer asks for a human agent, acknowledge the request without claiming an actual transfer.

RETURN AND REFUND SAFEGUARDS:

15. Never interpret an ordinary order shipment tracking number as a return shipping label or return tracking number.
16. Never instruct a customer to use an existing tracking number to return an item unless the order record explicitly identifies it as a return label or return-shipment tracking number.
17. Never invent return procedures, pickup arrangements, return addresses, return eligibility, refund conditions or processing timelines.
18. If return instructions are not explicitly verified in the order record, explain that the return request is recorded and provide only the verified return/refund status.
19. Never promise that a refund will automatically be processed after receiving a returned item unless the supplied record explicitly confirms that policy.
20. Never promise that return instructions or a shipping label will be sent later unless the supplied order record explicitly confirms this.
21. If return instructions are unavailable, explain that the customer needs confirmation from support before sending the item back.
22. Do not tell customers to wait for a shipping label or promise that one will be issued unless this is verified in the order record.
23. Never promise that a refund will be processed, approved or completed.
24. Never promise a future update or provide an unverified refund timeline.
25. When refund_status is pending, state only that the refund is pending and requires support review.

OVERDUE DELIVERY RULES:

26. The deliveryOverdue value is calculated by the application using the current date and verified order record.
27. If deliveryOverdue is true, the recorded expected delivery date has already passed and the order has not been marked Delivered.
28. Clearly explain that the recorded delivery date has passed.
29. Do not present the old delivery date as a future delivery date.
30. Do not invent a replacement delivery date or promise when the order will arrive.
31. Acknowledge the delay and explain that the case requires support review.
32. Never claim that a support investigation has already started.

The response is a draft for a support agent to review.

Current verified context:
- Customer message: ${input.message}
- Detected intent: ${input.intent}
- Urgency: ${input.urgency}
- Order number: ${input.orderNumber ?? "Not provided"}
- Order found: ${input.orderFound === null ? "Not applicable" : input.orderFound}
- Delivery overdue: ${input.deliveryOverdue}
- Verified order record: ${JSON.stringify(input.order)}
`;

  const payload = {
    model: "openai/gpt-oss-120b",
    temperature: 0.2,
    max_tokens: 250,
    messages: [
      {
        role: "system" as const,
        content: system,
      },
      ...input.history.slice(-6),
      {
        role: "user" as const,
        content: JSON.stringify({
          customerMessage: input.message,
          detectedIntent: input.intent,
          urgency: input.urgency,
          orderNumber: input.orderNumber,
          orderFound: input.orderFound,
          deliveryOverdue: input.deliveryOverdue,
          verifiedOrderRecord: input.order,
        }),
      },
    ],
  };

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GROQ_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    const errorDetails = await response.text();

    console.error("Groq API error:", response.status, errorDetails);

    throw new Error(
      `Groq request failed (${response.status}): ${errorDetails}`
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };

  const result = data.choices?.[0]?.message?.content;

  if (typeof result !== "string" || !result.trim()) {
    throw new Error("Groq returned an empty response.");
  }

  const draft = result.trim();

  const incompleteEnding =
    /\b(and|or|but|as|with|to|for|of|the|a|an|we|our|have|has|will|when|once)\s*[,;:]?\s*$/i.test(
      draft
    );

  const unsupportedPromise =
    /\b(we(?:'ll| will) update you|we will keep you updated|as soon as we have|refund will be issued|will have our team review|our team will investigate|investigation has started|process the refund as soon as possible)\b/i.test(
      draft
    );

  if (!incompleteEnding && !unsupportedPromise) return draft;

  const order = input.order;
  const orderLabel = input.orderNumber ?? "your order";

  if (input.deliveryOverdue && order) {
    return `Your order ${orderLabel} was shipped, but its expected delivery date of ${order.expected_delivery} has passed. We understand your concern. This shipment requires support review so its current status can be verified.`;
  }

  if (
    input.intent === "Return/Replacement" &&
    order &&
    String(order.order_status).toLowerCase() === "return requested" &&
    String(order.refund_status).toLowerCase() === "refund pending"
  ) {
    return `Your return request for order ${orderLabel} has been recorded, and the current refund status is Pending. The return procedure has not been verified in the available order record, so please confirm the instructions with support before sending the item back.`;
  }

  if (input.intent === "Payment Issue" && order) {
    const refund =
      order.refund_status && order.refund_status !== "Not Applicable"
        ? ` The recorded refund status is ${order.refund_status}.`
        : "";

    return `Your order ${orderLabel} has been flagged for review because you reported a duplicate charge.${refund} The available order record does not confirm that an investigation has started, so a support review is required.`;
  }

  return order
    ? `I found order ${orderLabel}. Its recorded status is ${order.order_status}. The available order record does not provide enough verified information to confirm the next step, so this request needs support review.`
    : `I can help with this request, but I do not have enough verified information to confirm the next step. Please check the details with support.`;
}

async function handleAnalyze(
  request: Request,
  env: Env
): Promise<Response> {
  let body: {
    message?: string;
    conversationId?: string;
    customerKey?: string;
  };

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON request." }, 400);
  }

  const message = String(body.message ?? "").trim();

  if (!message) {
    return json({ error: "Enter a customer message." }, 400);
  }

  if (message.length > 5000) {
    return json(
      { error: "Message is too long. Maximum 5,000 characters." },
      400
    );
  }

  const conversationId =
    String(body.conversationId ?? "").trim() || crypto.randomUUID();

  const customerKey =
    String(body.customerKey ?? conversationId).trim() || conversationId;

  const existing = await env.DB.prepare(
    `SELECT messages_json, last_order_number
     FROM conversations
     WHERE id = ?`
  )
    .bind(conversationId)
    .first<{
      messages_json: string;
      last_order_number: string | null;
    }>();

  let history: ChatMessage[] = [];

  try {
    history = existing?.messages_json
      ? (JSON.parse(existing.messages_json) as ChatMessage[])
      : [];
  } catch {
    history = [];
  }

  const orderNumber = extractOrderNumber(
    message,
    existing?.last_order_number
  );

  const intent = detectIntent(message);

  const orderRequired = [
    "Order Tracking",
    "Payment Issue",
    "Refund",
    "Return/Replacement",
  ].includes(intent);

  const order = orderRequired
    ? await getOrder(env.DB, orderNumber)
    : null;

  const orderFound =
    !orderRequired
      ? null
      : orderNumber
        ? Boolean(order)
        : null;

  const orderStatus = String(order?.order_status ?? "").toLowerCase();

  const deliveryOverdue = Boolean(
    order &&
      orderStatus !== "delivered" &&
      orderStatus !== "cancelled" &&
      isPastDate(order.expected_delivery)
  );

  const baseUrgency = urgencyFor(message, intent);

  const urgency: "Low" | "Medium" | "High" = deliveryOverdue
    ? "High"
    : baseUrgency;

  const refundStatus = String(order?.refund_status ?? "").toLowerCase();
  const currentOrderStatus = String(order?.order_status ?? "").toLowerCase();

  const pendingReturnNeedsReview =
    intent === "Return/Replacement" &&
    currentOrderStatus === "return requested" &&
    refundStatus === "refund pending";

  const humanReviewRequired =
    ["Payment Issue", "Human Support"].includes(intent) ||
    deliveryOverdue ||
    pendingReturnNeedsReview ||
    (intent === "Refund" &&
      /not arrived|overdue|late|two weeks|dispute/i.test(message));

  const responseText = await groqDraft(env, {
    message,
    intent,
    urgency,
    orderNumber: orderRequired ? orderNumber : null,
    order,
    orderFound,
    deliveryOverdue,
    history,
  });

  const updatedHistory: ChatMessage[] = [
    ...history,
    { role: "user" as const, content: message },
    { role: "assistant" as const, content: responseText },
  ].slice(-12);

  await env.DB.prepare(
    `INSERT INTO conversations
      (id, customer_key, messages_json, last_order_number, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       messages_json = excluded.messages_json,
       last_order_number = excluded.last_order_number,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(
      conversationId,
      customerKey,
      JSON.stringify(updatedHistory),
      orderRequired ? orderNumber : existing?.last_order_number ?? null
    )
    .run();

  const ticketId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO tickets
      (
        id,
        customer_message,
        intent,
        urgency,
        human_review_required,
        order_number,
        order_found,
        response,
        status
      )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      ticketId,
      message,
      intent,
      urgency,
      humanReviewRequired ? 1 : 0,
      orderRequired ? orderNumber : null,
      orderRequired && orderNumber ? (order ? 1 : 0) : null,
      responseText,
      humanReviewRequired ? "Review Pending" : "AI Handled"
    )
    .run();

  const result: Analysis = {
    intent,
    urgency,
    humanReviewRequired,
    confidence: 0.9,
    orderNumber: orderRequired ? orderNumber : null,
    orderFound,
    response: responseText,
    reason: deliveryOverdue
      ? "The recorded delivery date has passed. This order requires human review."
      : pendingReturnNeedsReview
        ? "The return is requested and the refund is pending. Human review is required."
        : humanReviewRequired
          ? "This request requires human review."
          : "Response drafted using the available support context.",
    order,
  };

  return json({
    ...result,
    deliveryOverdue,
    conversationId,
    ticketId,
    status: humanReviewRequired ? "Review Pending" : "AI Handled",
  });
}

async function handleHistory(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId");

  if (!conversationId) {
    return json(
      { error: "conversationId is required." },
      400
    );
  }

  const row = await env.DB.prepare(
    `SELECT messages_json
     FROM conversations
     WHERE id = ?`
  )
    .bind(conversationId)
    .first<{ messages_json: string }>();

  let messages: ChatMessage[] = [];

  try {
    messages = row?.messages_json
      ? (JSON.parse(row.messages_json) as ChatMessage[])
      : [];
  } catch {
    messages = [];
  }

  return json({ messages });
}

async function handleHealth(): Promise<Response> {
  return json({
    ok: true,
    service: "ResolveIQ",
    version: "1.0.0",
    status: "running",
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return handleHealth();
    }

    if (url.pathname === "/api/analyze" && request.method === "POST") {
      try {
        return await handleAnalyze(request, env);
      } catch (error) {
        console.error("ResolveIQ analysis error:", error);

        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Unable to analyze the message right now.",
          },
          500
        );
      }
    }

    if (url.pathname === "/api/history" && request.method === "GET") {
      try {
        return await handleHistory(request, env);
      } catch (error) {
        console.error("ResolveIQ history error:", error);

        return json(
          { error: "Unable to retrieve conversation history." },
          500
        );
      }
    }

    return env.ASSETS.fetch(request);
  },
};
