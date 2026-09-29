CREATE TABLE products (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  base_unit text NOT NULL
);

CREATE TABLE locations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE
);

CREATE TABLE inventory_balances (
  product_id bigint NOT NULL REFERENCES products(id),
  location_id bigint NOT NULL REFERENCES locations(id),
  qty bigint NOT NULL DEFAULT 0 CHECK (qty >= 0),
  PRIMARY KEY (product_id, location_id)
);

CREATE TABLE inventory_operations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('receipt','issue','transfer','adjustment')),
  request jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_movements (
  operation_id bigint NOT NULL REFERENCES inventory_operations(id),
  line_no smallint NOT NULL,
  product_id bigint NOT NULL,
  location_id bigint NOT NULL,
  delta bigint NOT NULL CHECK (delta <> 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, line_no),
  FOREIGN KEY (product_id, location_id)
    REFERENCES inventory_balances(product_id, location_id)
);

CREATE INDEX movements_history_idx
  ON inventory_movements(product_id, location_id, created_at DESC);
