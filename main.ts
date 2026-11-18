// Entry point: the forge server's life inside a trial.
// The environment hands this process its origin in MAKEFUN_ENV_URL. The process
// builds the forge, binds any free port, hands that port to the environment,
// and then stays alive polling until the environment reports the trial done.
// It owns no other job: the forge itself lives in app.ts.

import { createApp } from './app.ts';

// The environment's origin, without a trailing slash. Empty means there is no
// environment to talk to, and the process cannot do anything useful.
const ENV = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV.length === 0) {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is missing, nothing to register with\n');
  process.exit(1);
}

// One call may take this long before it is treated as failed and retried.
const CALL_BUDGET_MS = 30_000;
// Retries wait this long first, then double each time up to the ceiling.
const WAIT_FIRST_MS = 250;
const WAIT_LIMIT_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

// How long to wait before the next attempt after `failures` failed calls.
function waitAfter(failures: number): number {
  let wait = WAIT_FIRST_MS;
  const doublings = Math.min(failures, 8);
  for (let i = 0; i < doublings; i += 1) wait *= 2;
  return wait > WAIT_LIMIT_MS ? WAIT_LIMIT_MS : wait;
}

// Tell the environment which port the forge bound. A 200 means it took the
// port; a 409 means another entry registered first, so this one just waits
// out the trial like the rest. A 400 or 405 means the request itself is
// wrong and the process should stop; anything else (a dropped connection, a
// 500, the env still starting) is worth retrying.
async function announce(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let answer: Response;
    try {
      answer = await fetch(`${ENV}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_BUDGET_MS),
      });
    } catch {
      await pause(waitAfter(failures));
      failures += 1;
      continue;
    }
    if (answer.status === 200 || answer.status === 409) return;
    if (answer.status === 400 || answer.status === 405) {
      const detail = await answer.text();
      throw new Error(`register refused (HTTP ${answer.status}): ${detail}`);
    }
    await pause(waitAfter(failures));
    failures += 1;
  }
}

// Ask the environment whether the trial is over, forever until it says yes.
// A slow or failed ask is not an answer, so it just waits and asks again.
async function awaitDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const answer = await fetch(`${ENV}/done`, { signal: AbortSignal.timeout(CALL_BUDGET_MS) });
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // No answer yet: fall through to the wait below and ask again.
    }
    await pause(waitAfter(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const forge = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, () => {
      const bound = forge.address();
      if (bound !== null && typeof bound !== 'string') resolve(bound.port);
      else reject(new Error('the forge did not bind a TCP port'));
    });
  });
  process.stdout.write(`[entry] forge bound to port ${port}\n`);

  await announce(port);
  process.stdout.write('[entry] registered with the environment, waiting for done\n');

  await awaitDone();
  forge.close();
  process.stdout.write('[entry] trial done, shutting down\n');
}

run().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
