import type { CriticalAlertPolicy } from "../alerts/policy.js";

export interface RuntimeSettingsSnapshot {
  businessTimeZone: string;
  reminderSchedulerIntervalSeconds: number;
  criticalAlertPolicy: CriticalAlertPolicy;
}

export interface RuntimeSettingsReader {
  current(): RuntimeSettingsSnapshot;
}

function copy(snapshot: RuntimeSettingsSnapshot): RuntimeSettingsSnapshot {
  return {
    businessTimeZone: snapshot.businessTimeZone,
    reminderSchedulerIntervalSeconds: snapshot.reminderSchedulerIntervalSeconds,
    criticalAlertPolicy: {
      overdue: { ...snapshot.criticalAlertPolicy.overdue },
      blocked: { ...snapshot.criticalAlertPolicy.blocked },
      scheduler: { ...snapshot.criticalAlertPolicy.scheduler },
    },
  };
}

export class RuntimeSettingsProvider implements RuntimeSettingsReader {
  private snapshot: RuntimeSettingsSnapshot;
  constructor(baseline: RuntimeSettingsSnapshot) { this.snapshot = copy(baseline); }
  current(): RuntimeSettingsSnapshot { return copy(this.snapshot); }
  apply(snapshot: RuntimeSettingsSnapshot): void { this.snapshot = copy(snapshot); }
}
