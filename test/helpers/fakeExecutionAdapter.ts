import type { AgentExecutionAdapter, ExecutionOutcomeKind, ExecutionResult, ExecutionRunOptions } from "../../src/execution/types.js";
import type { SessionProvider } from "../../src/sessions/types.js";

export function fakeOutcome(kind: ExecutionOutcomeKind, detail: string | null = null, cooldownResetsAt: number | null = null) {
  return { kind, detail, cooldownResetsAt };
}

export function fakeResult(provider: SessionProvider, overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    provider,
    sessionId: null,
    exitCode: 0,
    signal: null,
    events: [],
    outcome: fakeOutcome("completed"),
    timedOut: false,
    outputTruncated: false,
    ...overrides,
  };
}

/** Never spawns a real process — a scripted stand-in for a provider's execution adapter, for tests only, per the task's own instruction not to run live coding-agent turns without separate authorization. */
export class FakeExecutionAdapter implements AgentExecutionAdapter {
  public readonly calls: ExecutionRunOptions[] = [];

  constructor(
    public readonly provider: SessionProvider,
    private readonly script: (options: ExecutionRunOptions, callIndex: number) => ExecutionResult | Promise<ExecutionResult>,
  ) {}

  async run(options: ExecutionRunOptions): Promise<ExecutionResult> {
    this.calls.push(options);
    return this.script(options, this.calls.length - 1);
  }
}
