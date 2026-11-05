
import { useState } from "react";
import {
  Bot,
  Copy,
  Send,
  ShieldCheck,
  MessageSquare,
  PackageSearch,
  AlertTriangle,
  CheckCircle2,
  Loader2,
} from "lucide-react";

type Result = {
  intent: string;
  urgency: "Low" | "Medium" | "High";
  humanReviewRequired: boolean;
  confidence: number;
  orderNumber: string | null;
  orderFound: boolean | null;
  response: string;
  reason: string;
  order: null | Record<string, string | null>;
  conversationId: string;
  ticketId: string;
  status: string;
};

type ApiResponse = Result & {
  error?: string;
};

const newId = () => crypto.randomUUID();

export default function App() {
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [conversationId, setConversationId] = useState(newId());

  async function analyze() {
    if (!message.trim() || busy) return;

    setBusy(true);
    setError("");
    setResult(null);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, conversationId }),
      });

      const data = (await res.json()) as ApiResponse;

      if (!res.ok) {
        throw new Error(
          data.error || "Unable to analyze the message right now."
        );
      }

      setResult(data);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Unable to analyze the message right now."
      );
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!result) return;

    await navigator.clipboard.writeText(result.response);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function clearConversation() {
    if (busy) return;

    setMessage("");
    setResult(null);
    setError("");
    setCopied(false);
    setConversationId(newId());
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">
            <Bot size={22} />
          </div>
          <div>
            <strong>SupportAI</strong>
            <span>AI Customer Support Assistant</span>
          </div>
        </div>
        <div className="live">
          <i /> System ready
        </div>
      </header>

      <section className="intro">
        <div>
          <div className="eyebrow">SUPPORT WORKSPACE</div>
          <h1>
            Customer support, <em>made clearer.</em>
          </h1>
          <p>
            Analyze customer messages, verify sample orders and prepare a
            response for agent review.
          </p>
        </div>
        <div className="intro-mark">
          <MessageSquare size={30} />
        </div>
      </section>

      <section className="workspace">
        <div className="panel input-panel">
          <div className="panel-title">
            <div className="section-icon">
              <MessageSquare size={18} />
            </div>
            <div>
              <h2>Customer message</h2>
              <p>Paste the customer's inquiry below.</p>
            </div>
          </div>

          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Example: Where is my order ORD-1001?"
            rows={6}
          />

          <div className="input-actions">
            <span>{message.length}/5000 characters</span>

            <div style={{ display: "flex", gap: "10px" }}>
              <button
                className="secondary"
                onClick={clearConversation}
                disabled={busy || (!message && !result && !error)}
                type="button"
              >
                Clear
              </button>

              <button
                className="primary"
                onClick={analyze}
                disabled={!message.trim() || busy}
                type="button"
              >
                {busy ? (
                  <>
                    <Loader2 className="spin" size={16} />
                    Analyzing…
                  </>
                ) : (
                  <>
                    Analyze message <Send size={15} />
                  </>
                )}
              </button>
            </div>
          </div>

          {error && (
            <div className="error">
              <AlertTriangle size={16} />
              {error}
            </div>
          )}
        </div>

        {result && (
          <>
            <div className="section-heading">
              <div>
                <div className="eyebrow">ANALYSIS RESULT</div>
                <h2>Support review</h2>
              </div>
              <span
                className={`status ${
                  result.humanReviewRequired ? "warn" : "ok"
                }`}
              >
                {result.status}
              </span>
            </div>

            <div className="cards">
              <article className="metric">
                <span>Intent</span>
                <strong>{result.intent}</strong>
                <MessageSquare size={18} />
              </article>

              <article className="metric">
                <span>Urgency</span>
                <strong>{result.urgency}</strong>
                <AlertTriangle size={18} />
              </article>

              <article className="metric">
                <span>Human review</span>
                <strong>
                  {result.humanReviewRequired ? "Required" : "Not required"}
                </strong>
                <ShieldCheck size={18} />
              </article>
            </div>

            <div className="details-grid">
              <article className="panel">
                <div className="panel-title">
                  <div className="section-icon">
                    <PackageSearch size={18} />
                  </div>
                  <div>
                    <h2>Order lookup</h2>
                    <p>Exact match from the SupportAI sample dataset.</p>
                  </div>
                </div>

                {!result.orderNumber ? (
                  <div className="empty">No order number provided.</div>
                ) : !result.orderFound ? (
                  <div className="empty">
                    Order <b>{result.orderNumber}</b> was not found in the
                    sample records.
                  </div>
                ) : (
                  <dl className="order-data">
                    <dt>Order number</dt>
                    <dd>{result.order?.order_number}</dd>

                    <dt>Product</dt>
                    <dd>{result.order?.product}</dd>

                    <dt>Order status</dt>
                    <dd>{result.order?.order_status}</dd>

                    <dt>Payment</dt>
                    <dd>{result.order?.payment_status}</dd>

                    <dt>Refund</dt>
                    <dd>{result.order?.refund_status || "Not recorded"}</dd>

                    <dt>Tracking</dt>
                    <dd>
                      {result.order?.tracking_number || "Not available"}
                    </dd>

                    <dt>Expected delivery</dt>
                    <dd>
                      {result.order?.expected_delivery || "Not provided"}
                    </dd>
                  </dl>
                )}
              </article>

              <article className="panel response-panel">
                <div className="panel-title">
                  <div className="section-icon green">
                    <Bot size={18} />
                  </div>
                  <div>
                    <h2>AI drafted response</h2>
                    <p>Review before sending to the customer.</p>
                  </div>
                </div>

                <div className="chat-preview">
                  <div className="chat-label">
                    WHATSAPP PREVIEW <span>Just now</span>
                  </div>
                  <div className="bubble">{result.response}</div>
                </div>

                <div className="response-actions">
                  <button className="secondary" onClick={copy} type="button">
                    <Copy size={15} />
                    {copied ? "Copied!" : "Copy response"}
                  </button>
                  <span>
                    <ShieldCheck size={14} /> Not sent to WhatsApp
                  </span>
                </div>
              </article>
            </div>

            <div className="notice">
              <AlertTriangle size={17} />
              <div>
                <b>
                  {result.humanReviewRequired
                    ? "Human review required"
                    : "Agent review recommended"}
                </b>
                <p>
                  {result.reason} This prototype drafts responses only; it
                  does not send messages or contact an agent.
                </p>
              </div>
            </div>

            <div className="bottom-actions">
              <button
                className="text-button"
                onClick={clearConversation}
                type="button"
              >
                Start new conversation
              </button>
              <span>Ticket ID: {result.ticketId.slice(0, 8)}</span>
            </div>
          </>
        )}

        {!result && !busy && (
          <div className="empty-state">
            <div>
              <CheckCircle2 size={22} />
            </div>
            <b>Ready for your first message</b>
            <span>
              Enter a customer inquiry to begin the support workflow.
            </span>
          </div>
        )}
      </section>

      <footer>
        SupportAI prototype · Sample order records · Human approval required
        for sensitive cases
      </footer>
    </main>
  );
}
