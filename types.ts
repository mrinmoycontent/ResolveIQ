export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GROQ_API_KEY: string;
  APP_ENV?: string;
}
export interface Order {
  order_number: string; customer_name: string; product: string; order_status: string;
  payment_status: string; refund_status: string | null; tracking_number: string | null;
  expected_delivery: string | null;
}
export interface Analysis {
  intent: string; urgency: "Low" | "Medium" | "High"; humanReviewRequired: boolean;
  confidence: number; orderNumber: string | null; orderFound: boolean | null;
  response: string; reason: string; order: Order | null;
}
