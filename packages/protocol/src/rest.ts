import { z } from "zod";

export const handleSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "lowercase letters, digits, . _ - only");

export const registerBody = z.object({
  handle: handleSchema,
  displayName: z.string().min(1).max(80),
  password: z.string().min(8).max(256),
  inviteCode: z.string().optional(),
});

export const loginBody = z.object({
  handle: handleSchema,
  password: z.string().min(1).max(256),
});

export const updateMeBody = z.object({
  displayName: z.string().min(1).max(80).optional(),
  statusText: z.string().max(120).optional(),
  statusEmoji: z.string().max(32).optional(),
  /** Snooze notifications until this epoch ms; null clears it. */
  dndUntil: z.number().int().nullable().optional(),
});

export const channelPrefsBody = z.object({
  notifyLevel: z.enum(["all", "mentions", "nothing"]).optional(),
  muted: z.boolean().optional(),
});

export const createChannelBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("public"),
    name: z.string().min(1).max(80),
    topic: z.string().max(250).optional(),
    description: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal("private"),
    name: z.string().min(1).max(80),
    topic: z.string().max(250).optional(),
    description: z.string().max(500).optional(),
    memberIds: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("dm"),
    memberIds: z.array(z.string()).length(1),
  }),
  z.object({
    type: z.literal("group_dm"),
    memberIds: z.array(z.string()).min(2).max(8),
  }),
]);

export const updateChannelBody = z.object({
  name: z.string().min(1).max(80).optional(),
  topic: z.string().max(250).optional(),
  description: z.string().max(500).optional(),
  archived: z.boolean().optional(),
});

export const sendMessageBody = z
  .object({
    text: z.string().max(12000),
    threadRootId: z.string().optional(),
    nonce: z.string().max(64).optional(),
    /** Ids from POST /api/channels/:id/files, attached to this message. */
    fileIds: z.array(z.string()).max(10).optional(),
  })
  // A message needs words, attachments, or both.
  .refine((b) => b.text.trim().length > 0 || (b.fileIds?.length ?? 0) > 0, {
    message: "message must have text or files",
  });

export const scheduleMessageBody = z.object({
  text: z.string().max(12000),
  /** Epoch ms; must be in the future. */
  sendAt: z.number().int().positive(),
  threadRootId: z.string().optional(),
  fileIds: z.array(z.string()).max(10).optional(),
}).refine((b) => b.text.trim().length > 0 || (b.fileIds?.length ?? 0) > 0, {
  message: "message must have text or files",
});

export const createAppBody = z.object({
  name: z.string().min(1).max(60),
});

export const createWebhookBody = z.object({
  channelId: z.string(),
});

/**
 * An address the server itself will call. Only http(s), and never with inline
 * credentials — those would be handed to whatever the host resolves to.
 */
export const integrationUrl = z
  .string()
  .url()
  .max(500)
  .refine((u) => {
    try {
      const parsed = new URL(u);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        !parsed.username &&
        !parsed.password
      );
    } catch {
      return false;
    }
  }, "must be an http(s) URL without embedded credentials");

export const createCommandBody = z.object({
  /** With or without the leading slash; the server stores it without. */
  command: z
    .string()
    .min(1)
    .max(32)
    .transform((c) => c.replace(/^\//, "").toLowerCase())
    .refine((c) => /^[a-z0-9][a-z0-9_-]*$/.test(c), "letters, digits, _ and - only"),
  url: integrationUrl,
  description: z.string().max(160).optional(),
  usageHint: z.string().max(80).optional(),
});

export const createSubscriptionBody = z.object({
  url: integrationUrl,
  /** Native event type names; omit or leave empty for everything. */
  eventTypes: z.array(z.string().max(40)).max(20).optional(),
});

/** Empty clears it, which leaves the app's buttons inert. */
export const interactivityBody = z.object({
  url: z.union([integrationUrl, z.literal("")]),
});

/** Which button on a message was pressed. */
export const messageActionBody = z.object({
  actionId: z.string().min(1).max(255),
});

export const runCommandBody = z.object({
  /** The whole line the user typed, leading slash included. */
  text: z.string().min(1).max(4000),
  threadRootId: z.string().optional(),
});

export const editMessageBody = z.object({
  text: z.string().min(1).max(12000),
});

export const markReadBody = z.object({
  seq: z.number().int().nonnegative(),
});

export const createInviteBody = z.object({
  expiresInHours: z.number().int().positive().max(24 * 365).optional(),
  maxUses: z.number().int().positive().max(1000).optional(),
});

export const messageHistoryQuery = z.object({
  /** Return messages with id < before (exclusive), newest first. */
  before: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  threadRootId: z.string().optional(),
});

export const searchQuery = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().positive().max(100).default(30),
});

export type RegisterBody = z.infer<typeof registerBody>;
export type LoginBody = z.infer<typeof loginBody>;
export type UpdateMeBody = z.infer<typeof updateMeBody>;
export type CreateChannelBody = z.infer<typeof createChannelBody>;
export type UpdateChannelBody = z.infer<typeof updateChannelBody>;
export type SendMessageBody = z.infer<typeof sendMessageBody>;
export type EditMessageBody = z.infer<typeof editMessageBody>;
export type MarkReadBody = z.infer<typeof markReadBody>;
export type CreateInviteBody = z.infer<typeof createInviteBody>;
export type ChannelPrefsBody = z.infer<typeof channelPrefsBody>;
export type ScheduleMessageBody = z.infer<typeof scheduleMessageBody>;
export type CreateAppBody = z.infer<typeof createAppBody>;
export type CreateWebhookBody = z.infer<typeof createWebhookBody>;
export type CreateCommandBody = z.infer<typeof createCommandBody>;
export type CreateSubscriptionBody = z.infer<typeof createSubscriptionBody>;
export type InteractivityBody = z.infer<typeof interactivityBody>;
export type MessageActionBody = z.infer<typeof messageActionBody>;
export type RunCommandBody = z.infer<typeof runCommandBody>;
