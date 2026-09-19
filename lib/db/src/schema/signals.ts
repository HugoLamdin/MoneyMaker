import { boolean, doublePrecision, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const signalsTable = pgTable("quant_signals", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  action: text("action").notNull(),
  price: doublePrecision("price").notNull(),
  sma50: doublePrecision("sma50").notNull(),
  reason: text("reason").notNull(),
  origin: text("origin").notNull().default("TREND_MODEL"),
  autoInvested: boolean("auto_invested").notNull().default(false),
  executeAfter: timestamp("execute_after", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Signal = typeof signalsTable.$inferSelect;