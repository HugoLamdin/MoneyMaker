import { doublePrecision, integer, pgTable, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const brokerCostAssumptionsTable = pgTable("quant_broker_cost_assumptions", {
  userId: integer("user_id").primaryKey().references(() => usersTable.id),
  commissionPerOrder: doublePrecision("commission_per_order").notNull(),
  spreadBpsPerSide: doublePrecision("spread_bps_per_side").notNull(),
  slippageBpsPerSide: doublePrecision("slippage_bps_per_side").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BrokerCostAssumptions = typeof brokerCostAssumptionsTable.$inferSelect;