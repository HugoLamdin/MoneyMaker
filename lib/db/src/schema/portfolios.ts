import { doublePrecision, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const portfoliosTable = pgTable("quant_portfolios", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").notNull().references(() => usersTable.id).unique(),
  cash: doublePrecision("cash").notNull().default(10000),
  mode: text("mode").notNull().default("PAPER"),
  maxPositionPercent: doublePrecision("max_position_percent").notNull().default(25),
  stopLossPercent: doublePrecision("stop_loss_percent").notNull().default(8),
  cashReservePercent: doublePrecision("cash_reserve_percent").notNull().default(20),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Portfolio = typeof portfoliosTable.$inferSelect;