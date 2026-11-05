PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS orders (
  order_number TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  product TEXT NOT NULL,
  order_status TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  refund_status TEXT,
  tracking_number TEXT,
  expected_delivery TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  customer_key TEXT NOT NULL,
  messages_json TEXT NOT NULL DEFAULT '[]',
  last_order_number TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  customer_message TEXT NOT NULL,
  intent TEXT NOT NULL,
  urgency TEXT NOT NULL,
  human_review_required INTEGER NOT NULL,
  order_number TEXT,
  order_found INTEGER,
  response TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Review Pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR REPLACE INTO orders VALUES
('ORD-1001','Rahul','Kitchen Organizer','Shipped','Paid','Not Applicable','TRK1001','2026-10-08'),
('ORD-1002','Priya','Garlic Press','Delivered','Paid','Not Applicable','TRK1002',NULL),
('ORD-1003','Amit','Sink Splash Guard','Return Requested','Paid','Refund Pending','TRK1003',NULL),
('ORD-1004','Neha','Storage Box','Delivered','Duplicate Charge','Refund Under Review','TRK1004',NULL),
('ORD-1005','Arjun','Kitchen Organizer','Processing','Paid','Not Applicable',NULL,NULL);
