import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Pi's real process runtime cannot be started in a unit test (it spawns the
// pinned CLI), so this file spies on its module boundary instead. The driver
// itself is the real one; only `runPiInvocation` is replaced.
const { runPiInvocation } = vi.hoisted(() => ({ runPiInvocation: vi.fn() }));
vi.mock("@/server/pi/runtime", () => ({ runPiInvocation }));

import { getPiDoctor } from "@/server/pi/config";
import type { PiInvocationInput } from "@/server/pi/types";
import type { StreamEvent } from "@/shared/types";
import { piHarnessDriver } from "./pi-driver";

afterEach(() => {
  runPiInvocation.mockReset();
  delete process.env.AGENTMELD_PI_CLI_PATH;
});

describe("the Pi harness driver", () => {
  it("declares the adapter name old Agent rows already store", () => {
    expect(piHarnessDriver.id).toBe("pi");
  });

  it("passes the invocation and signal through untouched and yields the same events", async () => {
    const event: StreamEvent = {
      type: "part.end",
      conversationId: "conv_passthrough",
      timestamp: 1,
      messageId: "",
      partIndex: 0,
    };
    async function* fixtureRun() {
      yield event;
    }
    runPiInvocation.mockImplementation(fixtureRun);

    // Deliberately a bare object: the driver must not read, clone or rewrite it.
    const input = { runId: "run_passthrough", conversationId: "conv_passthrough" } as PiInvocationInput;
    const signal = new AbortController().signal;

    const received: StreamEvent[] = [];
    for await (const item of piHarnessDriver.run(input, signal)) received.push(item);

    expect(received).toEqual([event]);
    expect(runPiInvocation).toHaveBeenCalledTimes(1);
    const [calledInput, calledSignal] = runPiInvocation.mock.calls[0] as [PiInvocationInput, AbortSignal];
    expect(calledInput).toBe(input);
    expect(calledSignal).toBe(signal);
  });

  it("returns Pi's generator directly, so errors and cancellation are not re-shaped", () => {
    const generator = (async function* () { /* drained elsewhere */ })();
    runPiInvocation.mockReturnValue(generator);
    const input = { runId: "run_identity" } as PiInvocationInput;
    const signal = new AbortController().signal;

    expect(piHarnessDriver.run(input, signal)).toBe(generator);
  });

  it("delegates doctor() to the Pi installation check", () => {
    const report = getPiDoctor();
    const doctor = piHarnessDriver.doctor();

    expect(doctor.available).toBe(report.available);
    expect(doctor.version).toBe(report.installedVersion ?? undefined);
    // Mirrors the Pi check rather than inventing a second notion of "healthy".
    if (report.available) expect(doctor.detail).toContain(report.expectedVersion);
    else expect(doctor.detail).toBe(report.error);
  });

  it("reports an unusable installation instead of throwing", () => {
    process.env.AGENTMELD_PI_CLI_PATH = path.join(os.tmpdir(), "agentmeld-missing-pi", "cli.js");

    const doctor = piHarnessDriver.doctor();

    expect(doctor.available).toBe(false);
    expect(doctor.version).toBeUndefined();
    expect(doctor.detail).toBe(getPiDoctor().error);
  });

  it("advertises only what Pi actually does", () => {
    expect(piHarnessDriver.capabilities()).toEqual({
      tools: "native+business",
      cancellation: true,
      cancellationMode: "signal",
      followUp: true,
      streaming: true,
    });
  });

  it("does not pretend to abort by run id, because Pi exposes no such entry point", () => {
    // The only cancellation channel is the AbortSignal handed to run().
    expect(piHarnessDriver.capabilities().cancellationMode).toBe("signal");
    expect(piHarnessDriver.abort("run_pi_driver")).toBe(false);
  });
});
