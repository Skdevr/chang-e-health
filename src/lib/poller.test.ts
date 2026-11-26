import test from 'node:test';
import assert from 'node:assert/strict';
import { POLL_INTERVAL_MS, PollScheduler } from './poller';

test('POLL_INTERVAL_MS is 30 seconds by default', () => {
  assert.equal(POLL_INTERVAL_MS, 30_000);
});

test('PollScheduler prevents overlapping requests when previous fetch is still in flight', async () => {
  let activeCalls = 0;
  let maxConcurrent = 0;
  let totalCalls = 0;
  const resolvers: Array<() => void> = [];

  const scheduler = new PollScheduler({
    intervalMs: 25,
    isDocumentHidden: () => false,
    onTick: async () => {
      totalCalls += 1;
      activeCalls += 1;
      maxConcurrent = Math.max(maxConcurrent, activeCalls);
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      activeCalls -= 1;
    },
  });

  scheduler.start();
  const p1 = scheduler.triggerNow();
  assert.equal(totalCalls, 1);
  assert.equal(scheduler.isInFlight(), true);

  // Overlapping triggers while call #1 is in flight must return false and be ignored
  const ran2 = await scheduler.triggerNow();
  const ran3 = await scheduler.triggerNow();
  assert.equal(ran2, false);
  assert.equal(ran3, false);
  assert.equal(totalCalls, 1, 'Overlapping ticks must be ignored while in flight');
  assert.equal(maxConcurrent, 1);

  // Wait longer than intervalMs while still in flight
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(totalCalls, 1, 'Interval ticks must also be ignored while in flight');

  // Resolve call #1; next trigger should execute cleanly
  resolvers.shift()?.();
  await p1;
  assert.equal(scheduler.isInFlight(), false);

  const p4 = scheduler.triggerNow();
  assert.equal(totalCalls, 2);
  resolvers.shift()?.();
  assert.equal(await p4, true);

  scheduler.stop();
});

test('PollScheduler pauses when tab is hidden and refreshes immediately when visible again', async () => {
  let hidden = true;
  let calls = 0;

  const scheduler = new PollScheduler({
    intervalMs: 30,
    isDocumentHidden: () => hidden,
    onTick: async () => {
      calls += 1;
    },
  });

  // Hidden on start -> interval does not fire
  scheduler.start();
  await new Promise((r) => setTimeout(r, 75));
  assert.equal(calls, 0, 'No polls should run while document is hidden');

  // Tab becomes visible -> immediate refresh triggered
  hidden = false;
  scheduler.handleVisibilityChange();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1, 'Becoming visible should trigger an immediate refresh');

  // Hide again -> interval paused
  hidden = true;
  scheduler.handleVisibilityChange();
  const countBeforeHideWait = calls;
  await new Promise((r) => setTimeout(r, 75));
  assert.equal(calls, countBeforeHideWait, 'Polling must remain paused while hidden');

  scheduler.stop();
});

test('PollScheduler cancels in-flight request with AbortController on stop() and resets timer', async () => {
  let aborted = false;
  let calls = 0;

  const scheduler = new PollScheduler({
    intervalMs: 50,
    isDocumentHidden: () => false,
    onTick: async (signal: AbortSignal) => {
      calls += 1;
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
      });
    },
  });

  scheduler.start();
  const p1 = scheduler.triggerNow();
  assert.equal(calls, 1);
  scheduler.resetTimer();
  scheduler.stop();
  await p1;

  assert.equal(aborted, true, 'stop() must abort active AbortController signal');

  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls, 1, 'No further ticks after stop()');
});
