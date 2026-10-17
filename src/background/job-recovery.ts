import { ALARM_TICK, TIMING } from "../shared/constants";

// Keeps a periodic alarm so the orchestrator can recover after the MV3
// service worker is suspended. Timers inside the worker do not survive
// suspension; alarms do.
export async function ensureTickAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(ALARM_TICK);
  if (!existing) await chrome.alarms.create(ALARM_TICK, { periodInMinutes: TIMING.alarmPeriodMin });
}
