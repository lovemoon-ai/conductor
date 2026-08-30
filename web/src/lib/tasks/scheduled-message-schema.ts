import { z } from "zod";

const positiveInteger = z.number().int().positive();

/**
 * Shared request shape for the schedule plan, used by both the create (POST)
 * and edit (PATCH) scheduled-message routes so the two never drift.
 */
export const scheduleSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("delay"),
    amount: positiveInteger,
    unit: z.enum(["minute", "hour"]),
  }),
  z.object({
    mode: z.literal("at"),
    sendAt: z.string().min(1),
    timezone: z.string().trim().min(1).optional().nullable(),
  }),
  z.object({
    mode: z.literal("interval"),
    every: positiveInteger,
    unit: z.enum(["minute", "hour"]),
    condition: z.enum(["none", "ai_idle"]).optional(),
    stop: z.object({
      maxRuns: positiveInteger.optional().nullable(),
      maxSkips: positiveInteger.optional().nullable(),
      stopAt: z.string().min(1).optional().nullable(),
      stopWhenTaskNotRunning: z.boolean().optional().nullable(),
    }).optional().nullable(),
  }),
]);

/**
 * Every lifecycle status a scheduled message row can hold. `sent` is the
 * terminal state for one-off sends and `completed` the one for intervals --
 * see `finishSuccessfulScheduledMessage` -- so both must stay selectable.
 */
export const SCHEDULED_MESSAGE_STATUSES = [
  "active",
  "sending",
  "sent",
  "completed",
  "canceled",
  "failed",
] as const;

/** Accepted values of the list endpoint's `status` filter. */
export const SCHEDULED_MESSAGE_STATUS_FILTERS = [
  "all",
  ...SCHEDULED_MESSAGE_STATUSES,
] as const;

export type ScheduledMessageStatusFilter =
  (typeof SCHEDULED_MESSAGE_STATUS_FILTERS)[number];

export const scheduledMessageStatusFilterSchema = z.enum(
  SCHEDULED_MESSAGE_STATUS_FILTERS,
);
