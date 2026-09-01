import type { ReminderChannelsRepository, ReminderRoutingRepository } from "../repositories/reminders.repository.js";
import type { TaskUsersRepository } from "../repositories/task-users.repository.js";
import type { ReminderCandidate } from "../reminders/types.js";

export interface ReminderRecipientResolution { userId: number | null; routed: boolean; reason?: "UNASSIGNED" | "USER_INACTIVE" | "CHANNEL_MISSING" | "CHANNEL_AMBIGUOUS" | "ESCALATION_UNROUTED" | "UNSUPPORTED_CHANNEL" }

export class ReminderRoutingService {
  constructor(
    private readonly users: TaskUsersRepository,
    private readonly channels: ReminderChannelsRepository,
    private readonly rules: ReminderRoutingRepository,
  ) {}

  async resolve(candidate: ReminderCandidate): Promise<ReminderRecipientResolution> {
    let userId: number | null = null;
    if (candidate.eventType === "TASK_REMINDER") {
      userId = candidate.task.assigned_to_user_id;
      if (userId === null) return { userId: null, routed: false, reason: "UNASSIGNED" };
    } else {
      const rule = await this.rules.findEscalationRule(candidate.task.owner_division_id, candidate.task.priority);
      if (!rule) return { userId: null, routed: false, reason: "ESCALATION_UNROUTED" };
      if (rule.channel !== "TELEGRAM") return { userId: null, routed: false, reason: "UNSUPPORTED_CHANNEL" };
      userId = rule.recipient_user_id;
    }
    const user = await this.users.findById(userId);
    if (!user?.active || user.divisionId === null || user.roleId === null) return { userId: null, routed: false, reason: "USER_INACTIVE" };
    const channels = await this.channels.findActiveTelegramForUser(userId);
    if (channels.length === 0) return { userId: null, routed: false, reason: "CHANNEL_MISSING" };
    if (channels.length !== 1) return { userId: null, routed: false, reason: "CHANNEL_AMBIGUOUS" };
    return { userId, routed: true };
  }
}
