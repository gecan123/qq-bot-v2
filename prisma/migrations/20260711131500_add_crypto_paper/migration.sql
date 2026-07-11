CREATE TABLE "crypto_paper_accounts" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "currency" VARCHAR(16) NOT NULL DEFAULT 'USD',
    "initial_cash" DECIMAL(36,12) NOT NULL,
    "cash" DECIMAL(36,12) NOT NULL,
    "realized_pnl" DECIMAL(36,12) NOT NULL DEFAULT 0,
    "fee_rate_bps" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "crypto_paper_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crypto_paper_positions" (
    "id" BIGSERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "quantity" DECIMAL(36,18) NOT NULL,
    "average_cost" DECIMAL(36,18) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "crypto_paper_positions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crypto_paper_orders" (
    "id" BIGSERIAL NOT NULL,
    "client_order_id" VARCHAR(64) NOT NULL,
    "account_id" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "side" VARCHAR(8) NOT NULL,
    "quantity" DECIMAL(36,18) NOT NULL,
    "price" DECIMAL(36,18) NOT NULL,
    "notional" DECIMAL(36,12) NOT NULL,
    "fee" DECIMAL(36,12) NOT NULL,
    "realized_pnl" DECIMAL(36,12) NOT NULL,
    "cash_after" DECIMAL(36,12) NOT NULL,
    "position_quantity_after" DECIMAL(36,18) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'FILLED',
    "quote_time" TIMESTAMPTZ(3),
    "note" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crypto_paper_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crypto_paper_positions_account_id_symbol_key" ON "crypto_paper_positions"("account_id", "symbol");
CREATE UNIQUE INDEX "crypto_paper_orders_client_order_id_key" ON "crypto_paper_orders"("client_order_id");
CREATE INDEX "crypto_paper_orders_account_id_generation_created_at_idx" ON "crypto_paper_orders"("account_id", "generation", "created_at" DESC);
CREATE INDEX "crypto_paper_orders_symbol_created_at_idx" ON "crypto_paper_orders"("symbol", "created_at" DESC);

ALTER TABLE "crypto_paper_positions" ADD CONSTRAINT "crypto_paper_positions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "crypto_paper_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crypto_paper_orders" ADD CONSTRAINT "crypto_paper_orders_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "crypto_paper_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
