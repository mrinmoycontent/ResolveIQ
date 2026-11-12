
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

  // Return intent takes priority over refund intent.
  // Customers commonly mention getting money back when requesting a return.
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

// Compares YYYY-MM-DD dates without timezone conversion.
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
