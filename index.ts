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

  // Do not show a cut-off response or an unverified operational promise.
  const incompleteEnding = /\b(and|or|but|as|with|to|for|of|the|a|an|we|our|have|has|will|when|once)\s*[,;:]?\s*$/i.test(draft);
  const unsupportedPromise = /\b(we(?:'ll| will) update you|we will keep you updated|as soon as we have|refund will be issued|will have our team review|our team will investigate|investigation has started)\b/i.test(draft);

  if (!incompleteEnding && !unsupportedPromise) return draft;

  const order = input.order;
  const orderLabel = input.orderNumber ?? "your order";

  if (input.deliveryOverdue && order) {
    return `Your order ${orderLabel} for the ${order.product_name} was shipped, but its expected delivery date of ${order.expected_delivery} has passed. We understand your concern. This shipment requires support review so its current status can be verified.`;
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
    const refund = order.refund_status && order.refund_status !== "Not Applicable"
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

  // Only undelivered orders with an expired expected delivery date
  // are considered overdue.
  const orderStatus = String(order?.order_status ?? "").toLowerCase();

  const deliveryOverdue = Boolean(
    order &&
      orderStatus !== "delivered" &&
      orderStatus !== "cancelled" &&
      isPastDate(order.expected_delivery)
