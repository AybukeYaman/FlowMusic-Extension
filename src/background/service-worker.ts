import { ALARM_TICK } from "../shared/constants";
import { isPageEvent, type Command } from "../shared/messages";
import { Repository } from "../storage/repository";
import { chromeStore } from "../storage/schema";
import { ensureTickAlarm } from "./job-recovery";
import { Orchestrator } from "./orchestrator";

// MV3 entry point. All listeners are registered synchronously at top level so
// Chrome can wake the worker for them. State lives in chrome.storage.

const orchestrator = new Orchestrator(new Repository(chromeStore));

chrome.runtime.onInstalled.addListener(() => void ensureTickAlarm());
chrome.runtime.onStartup.addListener(() => void ensureTickAlarm());

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (isPageEvent(msg)) {
    void orchestrator.onPageEvent(msg, sender.tab?.id);
    return false;
  }
  // Commands come only from extension pages (the popup), never from tabs.
  if (sender.tab) return false;
  orchestrator.handleCommand(msg as Command).then(sendResponse);
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_TICK) void orchestrator.onTick();
});

chrome.tabs.onRemoved.addListener((tabId) => void orchestrator.onTabRemoved(tabId));
chrome.downloads.onCreated.addListener((item) => void orchestrator.onDownloadCreated(item));
chrome.downloads.onChanged.addListener((delta) => void orchestrator.onDownloadChanged(delta));

void ensureTickAlarm();
