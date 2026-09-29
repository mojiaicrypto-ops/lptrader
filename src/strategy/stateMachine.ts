/**
 * §44 states, §88 transition graph, §43/§58 extensions, §88 write gates — and the persistence that
 * lets the bot come back up in the state it went down in (§74).
 *
 * DESIGN RULES
 *
 * 1. **The frozen graph is the only authority.** `BOT_STATE_TRANSITIONS` (`src/types/state.ts`) is
 *    the whitelist of edges; this module never adds a state or an edge of its own. An event only
 *    *proposes* a target, and the proposal is rejected unless the graph allows it. Anything not
 *    listed throws (`IllegalTransitionError`) — §96 `fail closed`, never "guess and jump".
 * 2. **Events are named by what was OBSERVED, not by what we want.** `POSITION_OPENED` is a
 *    statement about the world; the target state falls out of the graph. Where the same
 *    observation can legitimately lead to two states (an operator resuming with or without an open
 *    position) the caller passes `target`, which is still validated against the graph.
 * 3. **Write gates are separate from transitions.** `NO_NEW_CAPITAL_STATES` and
 *    `READ_ONLY_STATES` (§66/§58) are checked per *action* via `assertWriteAllowed`, so a caller
 *    cannot dodge them by staying in a state the graph happens to allow.
 *
 * KNOWN SPEC TENSION (resolved in favour of `fail closed`, see the report / docs/known-issues.md):
 * §67 lists "Remove Active Liquidity" + "Collect Fees" as GLOBAL_RISK_OFF actions, while the frozen
 * `READ_ONLY_STATES` forbids *any* transaction in `GLOBAL_RISK_OFF`. The frozen contract wins:
 * nothing is sent while in that state, and the §67 steps run after the explicit
 * `GLOBAL_RISK_OFF → RISK_REVIEW` transition (an edge the §88 graph provides), where removes and
 * collects are permitted (`RISK_REVIEW` is only capital-blocked, not read-only).
 */
import { BOT_STATE_TRANSITIONS, BOT_STATES, NO_NEW_CAPITAL_STATES, READ_ONLY_STATES, type BotState } from '../types/state.ts';
import type { IsoTimestamp } from '../types/primitives.ts';
import type { Database } from '../store/db.ts';
import { RuntimeStateStore, StoreError } from '../store/stateStore.ts';

/** §96 failure for an edge the graph does not allow. */
export class IllegalTransitionError extends Error {
  readonly code: 'illegal_transition' | 'already_in_state' | 'unknown_event';
  readonly from: BotState | null;
  readonly to: BotState | null;
  constructor(code: IllegalTransitionError['code'], message: string, from: BotState | null, to: BotState | null) {
    super(message);
    this.name = 'IllegalTransitionError';
    this.code = code;
    this.from = from;
    this.to = to;
  }
}

/** A write attempted from a state that forbids it (§58/§60/§66/§96). */
export class StateWriteBlockedError extends StoreError {
  readonly state: BotState;
  readonly action: string;
  readonly gate: 'READ_ONLY_STATES' | 'NO_NEW_CAPITAL_STATES';
  constructor(state: BotState, action: string, gate: StateWriteBlockedError['gate'], message: string) {
    super(message);
    this.name = 'StateWriteBlockedError';
    this.state = state;
    this.action = action;
    this.gate = gate;
  }
}

/**
 * Observation vocabulary. Each entry names what was seen; the target state is the graph's answer.
 *
 * `MULTI_TARGET` marks events whose target is context-dependent — for those, callers must pass an
 * explicit `target` or accept the documented default.
 */
export const STATE_EVENTS = {
  /** §45: the main loop starts and there is no active position. */
  NO_ACTIVE_POSITION: 'NO_ACTIVE_POSITION',
  /** §45: there is an open position, so go straight to monitoring. */
  ACTIVE_POSITION_PRESENT: 'ACTIVE_POSITION_PRESENT',
  /** §16/§21: a candidate survived the hard filters and ranking. */
  CANDIDATE_POOL_FOUND: 'CANDIDATE_POOL_FOUND',
  /** §16/§21: no candidate survives (or all data is stale). */
  NO_CANDIDATE_POOL: 'NO_CANDIDATE_POOL',
  /** §36-§38: plan computed (range, ticks, optimal ratio, swap amount). */
  POSITION_PLAN_READY: 'POSITION_PLAN_READY',
  /** §39/§42: the swap leg is confirmed on chain. */
  SWAP_CONFIRMED: 'SWAP_CONFIRMED',
  /** §42: the atomic swap+addLiquidity path returned a confirmed mint. */
  ATOMIC_BUILD_CONFIRMED: 'ATOMIC_BUILD_CONFIRMED',
  /** §43: swap ok but add-liquidity (or exit) failed — partial state, manual review only. */
  PARTIAL_EXECUTION: 'PARTIAL_EXECUTION',
  /** §49/§50/§51: price left the range. */
  PRICE_OUT_OF_RANGE: 'PRICE_OUT_OF_RANGE',
  /** §47: price is back inside the range. */
  PRICE_IN_RANGE: 'PRICE_IN_RANGE',
  /** §28/§69: Net APR below the warning line for the configured duration. */
  YIELD_UNDERPERFORMING: 'YIELD_UNDERPERFORMING',
  /** §28: Net APR recovered above the target. */
  YIELD_RECOVERED: 'YIELD_RECOVERED',
  /** §69: replacement search requested. */
  REPLACEMENT_SEARCH_REQUESTED: 'REPLACEMENT_SEARCH_REQUESTED',
  /** §70/§71: a better pool exists, and the §72 gates passed. */
  BETTER_POOL_FOUND: 'BETTER_POOL_FOUND',
  /** §70/§72: no better pool, or the switch is not worth its cost. */
  NO_BETTER_POOL: 'NO_BETTER_POOL',
  /** §71: switch finished. */
  SWITCH_COMPLETED: 'SWITCH_COMPLETED',
  /** §50/§52/§71: exit the position. */
  EXIT_TRIGGERED: 'EXIT_TRIGGERED',
  /** §71: the exit completed and the position is flat. */
  EXIT_COMPLETED: 'EXIT_COMPLETED',
  /** §54-§59: something needs review before acting. */
  RISK_REVIEW_REQUESTED: 'RISK_REVIEW_REQUESTED',
  /** §52/§53: review concluded that holding is correct. */
  RISK_REVIEW_NORMAL: 'RISK_REVIEW_NORMAL',
  /** §55/§58: review concluded that a critical condition exists. */
  RISK_REVIEW_CRITICAL: 'RISK_REVIEW_CRITICAL',
  /** §58: an emergency condition is live; nothing may be sent. */
  EMERGENCY_DETECTED: 'EMERGENCY_DETECTED',
  /** §58: the operator confirmed the emergency is over. */
  EMERGENCY_CLEARED: 'EMERGENCY_CLEARED',
  /** §66: `TotalNAV <= InitialNAV * (1 - maxDrawdown)`. */
  GLOBAL_RISK_OFF_TRIGGERED: 'GLOBAL_RISK_OFF_TRIGGERED',
  /** §67: the operator wants to work the risk-off asset list under review. */
  RISK_OFF_WORKLIST: 'RISK_OFF_WORKLIST',
  /** §67: risk-off processing is done; stay halted until an operator resumes. */
  RISK_OFF_WORKLIST_DONE: 'RISK_OFF_WORKLIST_DONE',
  /** §43/§58: a human reviewed a partial/emergency state. */
  OPERATOR_REVIEW_COMPLETE: 'OPERATOR_REVIEW_COMPLETE',
  /** Operator stop. */
  OPERATOR_PAUSE: 'OPERATOR_PAUSE',
  /** Operator resume. Multi-target: `IDLE` with no position, `MONITOR` with one. */
  OPERATOR_RESUME: 'OPERATOR_RESUME',
  /** §96: an unrecoverable condition; the bot stops until a human looks. */
  UNRECOVERABLE_FAILURE: 'UNRECOVERABLE_FAILURE',
  /** Operator reset from `ERROR`. Multi-target: `IDLE` (default) or `PAUSED`. */
  OPERATOR_RESET: 'OPERATOR_RESET',
} as const;
export type StateEventType = (typeof STATE_EVENTS)[keyof typeof STATE_EVENTS];

export interface StateEvent {
  readonly type: StateEventType;
  /** Human-readable justification; persisted with the state so a restart keeps the "why". */
  readonly reason?: string;
  /**
   * Explicit destination, required for the multi-target events and validated against the graph for
   * all of them. Passing an illegal target throws — this is a proposal, not an override.
   */
  readonly target?: BotState;
}

/** Default target per event. Multi-target events document both legal destinations in `alternatives`. */
export const EVENT_TARGETS: Readonly<Record<StateEventType, { readonly target: BotState; readonly alternatives?: readonly BotState[] }>> = {
  NO_ACTIVE_POSITION: { target: BOT_STATES.SELECT_POOL },
  ACTIVE_POSITION_PRESENT: { target: BOT_STATES.MONITOR },
  CANDIDATE_POOL_FOUND: { target: BOT_STATES.PREPARE_POSITION },
  NO_CANDIDATE_POOL: { target: BOT_STATES.IDLE },
  POSITION_PLAN_READY: { target: BOT_STATES.SWAP, alternatives: [BOT_STATES.ADD_LIQUIDITY] },
  SWAP_CONFIRMED: { target: BOT_STATES.ADD_LIQUIDITY },
  ATOMIC_BUILD_CONFIRMED: { target: BOT_STATES.MONITOR },
  PARTIAL_EXECUTION: { target: BOT_STATES.PARTIAL_POSITION },
  PRICE_OUT_OF_RANGE: { target: BOT_STATES.OUT_OF_RANGE },
  PRICE_IN_RANGE: { target: BOT_STATES.MONITOR },
  YIELD_UNDERPERFORMING: { target: BOT_STATES.UNDERPERFORMING },
  YIELD_RECOVERED: { target: BOT_STATES.MONITOR },
  REPLACEMENT_SEARCH_REQUESTED: { target: BOT_STATES.SEARCH_REPLACEMENT },
  BETTER_POOL_FOUND: { target: BOT_STATES.SWITCH_POOL },
  NO_BETTER_POOL: { target: BOT_STATES.MONITOR },
  SWITCH_COMPLETED: { target: BOT_STATES.MONITOR },
  EXIT_TRIGGERED: { target: BOT_STATES.EXIT_POSITION },
  EXIT_COMPLETED: { target: BOT_STATES.PAUSED },
  RISK_REVIEW_REQUESTED: { target: BOT_STATES.RISK_REVIEW },
  RISK_REVIEW_NORMAL: { target: BOT_STATES.MONITOR },
  RISK_REVIEW_CRITICAL: { target: BOT_STATES.EXIT_POSITION },
  EMERGENCY_DETECTED: { target: BOT_STATES.EMERGENCY },
  EMERGENCY_CLEARED: { target: BOT_STATES.PAUSED },
  GLOBAL_RISK_OFF_TRIGGERED: { target: BOT_STATES.GLOBAL_RISK_OFF },
  RISK_OFF_WORKLIST: { target: BOT_STATES.RISK_REVIEW },
  RISK_OFF_WORKLIST_DONE: { target: BOT_STATES.PAUSED },
  OPERATOR_REVIEW_COMPLETE: { target: BOT_STATES.RISK_REVIEW, alternatives: [BOT_STATES.PAUSED, BOT_STATES.ERROR] },
  OPERATOR_PAUSE: { target: BOT_STATES.PAUSED },
  OPERATOR_RESUME: { target: BOT_STATES.IDLE, alternatives: [BOT_STATES.MONITOR, BOT_STATES.GLOBAL_RISK_OFF, BOT_STATES.ERROR] },
  UNRECOVERABLE_FAILURE: { target: BOT_STATES.ERROR },
  OPERATOR_RESET: { target: BOT_STATES.IDLE, alternatives: [BOT_STATES.PAUSED] },
};

/** True when the frozen graph allows `from -> to`. Self-edges are not in the graph. */
export function isTransitionAllowed(from: BotState, to: BotState): boolean {
  return Object.prototype.hasOwnProperty.call(BOT_STATE_TRANSITIONS, to)
    ? BOT_STATE_TRANSITIONS[from].includes(to)
    : false;
}

/**
 * Resolve the destination of an event. Pure: reads only the event and the frozen graph.
 * Throws `unknown_event` for a type that is not in `STATE_EVENTS`.
 */
export function resolveEventTarget(event: StateEvent): BotState {
  const entry = EVENT_TARGETS[event.type as StateEventType];
  if (entry === undefined) {
    throw new IllegalTransitionError('unknown_event', `unknown state event ${JSON.stringify(event.type)}`, null, null);
  }
  return event.target ?? entry.target;
}

/** The destinations an event may legally reach, in preference order. */
export function eventAlternatives(event: StateEventType): readonly BotState[] {
  const entry = EVENT_TARGETS[event];
  if (entry === undefined) {
    throw new IllegalTransitionError('unknown_event', `unknown state event ${JSON.stringify(event)}`, null, null);
  }
  return entry.alternatives === undefined ? [entry.target] : [entry.target, ...entry.alternatives];
}

export interface TransitionResult {
  readonly from: BotState;
  readonly to: BotState;
  readonly event: StateEventType;
  readonly reason: string;
  readonly at: IsoTimestamp;
}

/**
 * §88 transition. Illegal edges throw; there is no "closest match" fallback.
 *
 * `at` is injectable so a replay (§77) reproduces the exact timestamps of the original run.
 */
export function transition(
  state: BotState,
  event: StateEvent,
  options: { readonly at?: IsoTimestamp } = {},
): TransitionResult {
  if (!Object.values(BOT_STATES).includes(state)) {
    throw new IllegalTransitionError('illegal_transition', `unknown current state ${JSON.stringify(state)}`, null, null);
  }
  const to = resolveEventTarget(event);
  if (!Object.values(BOT_STATES).includes(to)) {
    throw new IllegalTransitionError('illegal_transition', `unknown target state ${JSON.stringify(to)}`, state, null);
  }
  if (to === state) {
    throw new IllegalTransitionError(
      'already_in_state',
      `event ${event.type} targets the current state ${state}; self-transitions are not part of the §88 graph`,
      state,
      to,
    );
  }
  if (!isTransitionAllowed(state, to)) {
    throw new IllegalTransitionError(
      'illegal_transition',
      `${state} -> ${to} is not in BOT_STATE_TRANSITIONS (§88); event ${event.type} rejected (§96 fail closed)`,
      state,
      to,
    );
  }
  return {
    from: state,
    to,
    event: event.type,
    reason: event.reason ?? `${event.type} (no reason supplied)`,
    at: options.at ?? new Date().toISOString(),
  };
}

/** Read-only mirror of the gate sets, for callers that want to branch instead of catching. */
export function isReadOnlyState(state: BotState): boolean {
  return READ_ONLY_STATES.includes(state);
}

export function isNoNewCapitalState(state: BotState): boolean {
  return NO_NEW_CAPITAL_STATES.includes(state);
}

/**
 * Executing actions that require a transaction (or a transaction-adjacent side effect).
 * `commitsNewCapital` marks the actions §60/§66 block earlier than the rest: adding capital is
 * forbidden in `RISK_REVIEW` etc., while an exit or a fee collection is still allowed there.
 */
export const WRITE_ACTIONS = {
  APPROVE_ALLOWANCE: { id: 'APPROVE_ALLOWANCE', commitsNewCapital: false },
  SWAP_BUILD: { id: 'SWAP_BUILD', commitsNewCapital: true },
  ADD_LIQUIDITY: { id: 'ADD_LIQUIDITY', commitsNewCapital: true },
  SWITCH_POOL: { id: 'SWITCH_POOL', commitsNewCapital: true },
  REMOVE_LIQUIDITY: { id: 'REMOVE_LIQUIDITY', commitsNewCapital: false },
  COLLECT_FEES: { id: 'COLLECT_FEES', commitsNewCapital: false },
} as const;
export type WriteAction = (typeof WRITE_ACTIONS)[keyof typeof WRITE_ACTIONS];

/** Verdict of the write gate. `ok === false` means the caller MUST NOT send anything. */
export interface WriteGateVerdict {
  readonly ok: boolean;
  readonly gate?: 'READ_ONLY_STATES' | 'NO_NEW_CAPITAL_STATES';
  readonly reason?: string;
}

/**
 * §58/§60/§66/§96 — may this write be attempted from `state`?
 *
 * Two gates, checked in that order:
 *   - `READ_ONLY_STATES` (GLOBAL_RISK_OFF / EMERGENCY / PAUSED / ERROR): no transaction at all.
 *   - `NO_NEW_CAPITAL_STATES` (adds RISK_REVIEW / PARTIAL_POSITION): no capital-committing action,
 *     which is the §66 "stop new positions" / §60 "reserve too low" rule and the §43 "a partial
 *     fill must not be completed automatically" rule.
 */
export function checkWriteAllowed(state: BotState, action: WriteAction): WriteGateVerdict {
  if (READ_ONLY_STATES.includes(state)) {
    return {
      ok: false,
      gate: 'READ_ONLY_STATES',
      reason: `${state} is read-only: '${action.id}' must not be sent (§58/§66 — nothing is sent while halted)`,
    };
  }
  if (action.commitsNewCapital && NO_NEW_CAPITAL_STATES.includes(state)) {
    return {
      ok: false,
      gate: 'NO_NEW_CAPITAL_STATES',
      reason: `${state} forbids new capital: '${action.id}' rejected (§60/§66/§43)`,
    };
  }
  return { ok: true };
}

/** Throwing form of `checkWriteAllowed`, for the executors' pre-flight. */
export function assertWriteAllowed(state: BotState, action: WriteAction): void {
  const verdict = checkWriteAllowed(state, action);
  if (!verdict.ok && verdict.gate !== undefined && verdict.reason !== undefined) {
    throw new StateWriteBlockedError(state, action.id, verdict.gate, verdict.reason);
  }
}

/**
 * The §44 state of the running bot, persisted in `runtime_state` (migration 4) so a restart
 * resumes in the same state instead of re-deriving one from a fresh default — a restart into
 * `IDLE` while a position is open would be exactly the "guess" §96 forbids.
 */
export class StateMachine {
  readonly #store: RuntimeStateStore;
  #state: BotState;

  private constructor(store: RuntimeStateStore, state: BotState) {
    this.#store = store;
    this.#state = state;
  }

  /**
   * Load the persisted state, or start at `initialState` on a virgin database.
   *
   * Fail closed on a stored value that is not a §44 state: `RuntimeStateStore.get()` raises rather
   * than substituting a default, so a corrupted/edited database stops the process instead of
   * silently choosing a permissive state.
   */
  static open(db: Database, initialState: BotState = BOT_STATES.IDLE): StateMachine {
    const store = new RuntimeStateStore(db);
    const persisted = store.get();
    if (persisted !== null) return new StateMachine(store, persisted.botState);
    store.set({ botState: initialState, reason: 'process start: no persisted state' });
    return new StateMachine(store, initialState);
  }

  get current(): BotState {
    return this.#state;
  }

  /** Where this event would take the machine (pure; throws only for an unknown event type). */
  targetOf(event: StateEvent): BotState {
    return resolveEventTarget(event);
  }

  /** True when the event is a legal edge from the current state (self-edges are not legal). */
  canApply(event: StateEvent): boolean {
    const to = resolveEventTarget(event);
    return to !== this.#state && isTransitionAllowed(this.#state, to);
  }

  /**
   * Apply an event. Throws `IllegalTransitionError` on an illegal edge — always, including for a
   * repeated observation. Use `applyOnce` when a duplicate event is expected to be harmless.
   */
  apply(event: StateEvent, at?: IsoTimestamp): TransitionResult {
    return this.#commit(transition(this.#state, event, at === undefined ? {} : { at }));
  }

  /**
   * Apply an event, treating "already in the target state" as a no-op *for that case only*.
   *
   * A duplicate observation (e.g. two monitor ticks both reporting `PRICE_IN_RANGE`) is normal in a
   * polling loop; an illegal edge is not and still throws. Returns `null` for the no-op.
   */
  applyOnce(event: StateEvent, at?: IsoTimestamp): TransitionResult | null {
    if (resolveEventTarget(event) === this.#state) return null;
    return this.apply(event, at);
  }

  /** §58/§60/§66 — gate a write against the CURRENT state. */
  assertWriteAllowed(action: WriteAction): void {
    assertWriteAllowed(this.#state, action);
  }

  checkWriteAllowed(action: WriteAction): WriteGateVerdict {
    return checkWriteAllowed(this.#state, action);
  }

  /** Event → transition, or a no-op when already there. Nothing else mutates the state. */
  #commit(result: TransitionResult): TransitionResult {
    this.#store.set({ botState: result.to, reason: `${result.from}->${result.to}: ${result.reason}` }, result.at);
    this.#state = result.to;
    return result;
  }
}
