import { doublePrecision, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const positionsTable = pgTable(
  "quant_positions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: integer("user_id").notNull().references(() => usersTable.id),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    quantity: doublePrecision("quantity").notNull(),
    averagePrice: doublePrecision("average_price").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userSymbolUnique: uniqueIndex("quant_positions_user_symbol_idx").on(table.userId, table.symbol),
  }),
);

export type Position = typeof positionsTable.$inferSelect;