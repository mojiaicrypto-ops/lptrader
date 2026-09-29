/**
 * T11 state machine tests — §44 states, §88 graph enforcement, §43 partial fills, §58 emergency,
 * §66 write gates and §74 persistence across a restart.
 *
 * Every legal edge in the frozen graph is exercised, and every illegal (from, to) pair is asserted
 * to throw — that is the §96 `fail closed` guarantee, so it is tested exhaustively rather than by
 * example.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOT_STATES,
  BOT_STATE_TRANSITIONS,
  NO_NEW_CAPITAL_STATES,
  READ_ONLY_STATES,
  type BotState,
} from '../../src/types/state.ts';
import { closeDatabase, openDatabase, StoreError, type Database } from '../../src/store/db.ts';
import { RuntimeStateStore } from '../../src/store/stateStore.ts';
import {
  EVENT_TARGETS,
  IllegalTransitionError,
  STATE_EVENTS,
  StateMachine,
  StateWriteBlockedError,
  WRITE_ACTIONS,
  assertWriteAllowed,
  checkWriteAllowed,
  eventAlternatives,
  isReadOnlyState,
  isTransitionAllowed,
  resolveEventTarget,
  transition,
  type StateEventType,
} from '../../src/strategy/stateMachine.ts';

const ALL_STATES = Object.values(BOT_STATES) as readonly BotState[];
const ALL_EVENTS = Object.values(STATE_EVENTS) as readonly StateEventType[];

let dir = '';
let dbPath = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lptrader-fsm-'));
  dbPath = path.join(dir, 'lptrader.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('§88 transition graph', () => {
  it('every state in BOT_STATES appears as a source with a legal target list', () => {
    for (const state of ALL_STATES) {
      expect(BOT_STATE_TRANSITIONS[state]).toBeDefined();
      expect(BOT_STATE_TRANSITIONS[state].length).toBeGreaterThan(0);
      for (const target of BOT_STATE_TRANSITIONS[state]) {
        expect(ALL_STATES).toContain(target);
      }
    }
  });

  it('allows exactly the frozen edges and throws on every other pair', () => {
    let allowed = 0;
    let rejected = 0;
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const legal = BOT_STATE_TRANSITIONS[from].includes(to);
        const event = { type: STATE_EVENTS.OPERATOR_PAUSE, target: to, reason: 'probe' } as const;
        if (legal) {
          const result = transition(from, event, { at: '2026-09-29T00:00:00.000Z' });
          expect(result).toMatchObject({ from, to });
          allowed += 1;
        } else {
          expect(() => transition(from, event)).toThrow(IllegalTransitionError);
          rejected += 1;
        }
      }
    }
    // Sanity on the graph size: 90 pairs total, so both counters must be non-trivial.
    expect(allowed + rejected).toBe(ALL_STATES.length ** 2);
    expect(allowed).toBeGreaterThan(40);
    expect(rejected).toBeGreaterThan(40);
  });

  it('rejects a self-transition (no state lists itself, and the machine says so explicitly)', () => {
    for (const state of ALL_STATES) {
      expect(isTransitionAllowed(state, state)).toBe(false);
      const error = (() => {
        try {
          transition(state, { type: STATE_EVENTS.OPERATOR_PAUSE, target: state });
          return null;
        } catch (caught) {
          return caught as IllegalTransitionError;
        }
      })();
      expect(error?.code).toBe('already_in_state');
    }
  });

  it('rejects an unknown event type and an unknown state value', () => {
    expect(() => transition(BOT_STATES.IDLE, { type: 'TELEPORT' as StateEventType })).toThrow(/unknown state event/);
    expect(() => transition('FLYING' as BotState, { type: STATE_EVENTS.OPERATOR_PAUSE })).toThrow(/unknown current state/);
  });

  it('resolves an event target, honouring the documented default and an explicit alternative', () => {
    expect(resolveEventTarget({ type: STATE_EVENTS.NO_ACTIVE_POSITION })).toBe(BOT_STATES.SELECT_POOL);
    expect(resolveEventTarget({ type: STATE_EVENTS.POSITION_PLAN_READY })).toBe(BOT_STATES.SWAP);
    expect(resolveEventTarget({ type: STATE_EVENTS.POSITION_PLAN_READY, target: BOT_STATES.ADD_LIQUIDITY })).toBe(
      BOT_STATES.ADD_LIQUIDITY,
    );
    // The alternative is only a *proposal*: PREPARE_POSITION -> ADD_LIQUIDITY is a frozen edge, but
    // MONITOR -> it is not, so the same event is refused from MONITOR.
    expect(() => transition(BOT_STATES.MONITOR, { type: STATE_EVENTS.POSITION_PLAN_READY, target: BOT_STATES.ADD_LIQUIDITY })).toThrow(
      /is not in BOT_STATE_TRANSITIONS/,
    );
  });

  it('rejects a target the event does not offer', () => {
    expect(() => transition(BOT_STATES.IDLE, { type: STATE_EVENTS.NO_ACTIVE_POSITION, target: BOT_STATES.MONITOR })).not.toThrow(); // IDLE->MONITOR IS legal
    expect(() => transition(BOT_STATES.SWAP, { type: STATE_EVENTS.EMERGENCY_DETECTED })).toThrow(/SWAP -> EMERGENCY/);
    expect(eventAlternatives(STATE_EVENTS.OPERATOR_RESUME)).toEqual([
      BOT_STATES.IDLE,
      BOT_STATES.MONITOR,
      BOT_STATES.GLOBAL_RISK_OFF,
      BOT_STATES.ERROR,
    ]);
  });

  it('documents a target for every event', () => {
    for (const event of ALL_EVENTS) {
      expect(EVENT_TARGETS[event]).toBeDefined();
      expect(ALL_STATES).toContain(EVENT_TARGETS[event].target);
    }
  });
});

describe('§45/§88 happy path and §43 partial fills', () => {
  it('walks IDLE → SELECT_POOL → PREPARE_POSITION → SWAP → ADD_LIQUIDITY → MONITOR', () => {
    const steps: readonly StateEventType[] = [
      STATE_EVENTS.NO_ACTIVE_POSITION,
      STATE_EVENTS.CANDIDATE_POOL_FOUND,
      STATE_EVENTS.POSITION_PLAN_READY,
      STATE_EVENTS.SWAP_CONFIRMED,
      STATE_EVENTS.ATOMIC_BUILD_CONFIRMED,
    ];
    let state: BotState = BOT_STATES.IDLE;
    const path: BotState[] = [state];
    for (const [index, type] of steps.entries()) {
      state = transition(state, { type, reason: `step ${index}` }, { at: '2026-09-29T00:00:00.000Z' }).to;
      path.push(state);
    }
    expect(path).toEqual([
      BOT_STATES.IDLE,
      BOT_STATES.SELECT_POOL,
      BOT_STATES.PREPARE_POSITION,
      BOT_STATES.SWAP,
      BOT_STATES.ADD_LIQUIDITY,
      BOT_STATES.MONITOR,
    ]);
  });

  it('§43: swap ok + addLiquidity failed parks in PARTIAL_POSITION and cannot complete automatically', () => {
    const parked = transition(
      BOT_STATES.ADD_LIQUIDITY,
      { type: STATE_EVENTS.PARTIAL_EXECUTION, reason: 'addLiquidity reverted: price moved' },
      { at: '2026-09-29T00:00:00.000Z' },
    );
    expect(parked.to).toBe(BOT_STATES.PARTIAL_POSITION);

    // §43: never re-attempt the swap leg. There is no PARTIAL_POSITION -> SWAP/ADD_LIQUIDITY edge.
    expect(isTransitionAllowed(BOT_STATES.PARTIAL_POSITION, BOT_STATES.SWAP)).toBe(false);
    expect(isTransitionAllowed(BOT_STATES.PARTIAL_POSITION, BOT_STATES.ADD_LIQUIDITY)).toBe(false);
    expect(() => transition(BOT_STATES.PARTIAL_POSITION, { type: STATE_EVENTS.SWAP_CONFIRMED })).toThrow(IllegalTransitionError);

    // It is capital-blocked while parked: no automatic completion of a partial fill.
    expect(checkWriteAllowed(BOT_STATES.PARTIAL_POSITION, WRITE_ACTIONS.ADD_LIQUIDITY)).toMatchObject({
      ok: false,
      gate: 'NO_NEW_CAPITAL_STATES',
    });
    expect(checkWriteAllowed(BOT_STATES.PARTIAL_POSITION, WRITE_ACTIONS.SWAP_BUILD)).toMatchObject({ ok: false });

    // Exit paths out of PARTIAL_POSITION exist (§88) but they are review/halt paths.
    expect(BOT_STATE_TRANSITIONS[BOT_STATES.PARTIAL_POSITION]).toEqual([
      BOT_STATES.RISK_REVIEW,
      BOT_STATES.PAUSED,
      BOT_STATES.ERROR,
    ]);
    expect(transition(BOT_STATES.PARTIAL_POSITION, { type: STATE_EVENTS.OPERATOR_REVIEW_COMPLETE }).to).toBe(
      BOT_STATES.RISK_REVIEW,
    );
  });

  it('§43: an exit that only partially executed is also parked', () => {
    expect(transition(BOT_STATES.EXIT_POSITION, { type: STATE_EVENTS.PARTIAL_EXECUTION }).to).toBe(
      BOT_STATES.PARTIAL_POSITION,
    );
    expect(transition(BOT_STATES.SWITCH_POOL, { type: STATE_EVENTS.PARTIAL_EXECUTION }).to).toBe(
      BOT_STATES.PARTIAL_POSITION,
    );
  });
});

describe('§58 emergency and §66 global risk off', () => {
  it('enters EMERGENCY from MONITOR/OUT_OF_RANGE/RISK_REVIEW and exits only to PAUSED/ERROR', () => {
    for (const from of [BOT_STATES.MONITOR, BOT_STATES.OUT_OF_RANGE, BOT_STATES.RISK_REVIEW]) {
      expect(transition(from, { type: STATE_EVENTS.EMERGENCY_DETECTED }).to).toBe(BOT_STATES.EMERGENCY);
    }
    // No path back to trading without an operator: EMERGENCY offers only PAUSED and ERROR.
    expect(BOT_STATE_TRANSITIONS[BOT_STATES.EMERGENCY]).toEqual([BOT_STATES.PAUSED, BOT_STATES.ERROR]);
    expect(transition(BOT_STATES.EMERGENCY, { type: STATE_EVENTS.EMERGENCY_CLEARED }).to).toBe(BOT_STATES.PAUSED);
    expect(() => transition(BOT_STATES.EMERGENCY, { type: STATE_EVENTS.PRICE_IN_RANGE })).toThrow(IllegalTransitionError);
    // §58: no transaction may be sent while EMERGENCY is active.
    for (const action of Object.values(WRITE_ACTIONS)) {
      expect(assertWriteAllowedThrow(() => assertWriteAllowed(BOT_STATES.EMERGENCY, action))?.gate).toBe(
        'READ_ONLY_STATES',
      );
    }
  });

  it('§66: GLOBAL_RISK_OFF is entered from the monitoring states and is fully read-only', () => {
    for (const from of [BOT_STATES.IDLE, BOT_STATES.MONITOR, BOT_STATES.OUT_OF_RANGE]) {
      expect(transition(from, { type: STATE_EVENTS.GLOBAL_RISK_OFF_TRIGGERED }).to).toBe(BOT_STATES.GLOBAL_RISK_OFF);
    }
    expect(transition(BOT_STATES.GLOBAL_RISK_OFF, { type: STATE_EVENTS.RISK_OFF_WORKLIST }).to).toBe(BOT_STATES.RISK_REVIEW);
    expect(transition(BOT_STATES.GLOBAL_RISK_OFF, { type: STATE_EVENTS.RISK_OFF_WORKLIST_DONE }).to).toBe(BOT_STATES.PAUSED);
    expect(isReadOnlyState(BOT_STATES.GLOBAL_RISK_OFF)).toBe(true);
    // §67's "remove liquidity / collect fees" steps are only reachable after the explicit move to
    // RISK_REVIEW, because the frozen READ_ONLY_STATES forbids every tx in GLOBAL_RISK_OFF.
    expect(checkWriteAllowed(BOT_STATES.GLOBAL_RISK_OFF, WRITE_ACTIONS.REMOVE_LIQUIDITY).ok).toBe(false);
    expect(checkWriteAllowed(BOT_STATES.RISK_REVIEW, WRITE_ACTIONS.REMOVE_LIQUIDITY).ok).toBe(true);
  });

  it('§96: does not leave GLOBAL_RISK_OFF straight back into trading', () => {
    expect(isTransitionAllowed(BOT_STATES.GLOBAL_RISK_OFF, BOT_STATES.MONITOR)).toBe(false);
    expect(isTransitionAllowed(BOT_STATES.GLOBAL_RISK_OFF, BOT_STATES.IDLE)).toBe(false);
    expect(() => transition(BOT_STATES.GLOBAL_RISK_OFF, { type: STATE_EVENTS.PRICE_IN_RANGE })).toThrow(IllegalTransitionError);
  });
});

describe('write gates (§43/§58/§60/§66/§96)', () => {
  it('rejects EVERY action from EVERY read-only state, and every capital action from capital-blocked states', () => {
    for (const state of READ_ONLY_STATES) {
      for (const action of Object.values(WRITE_ACTIONS)) {
        const verdict = checkWriteAllowed(state, action);
        expect(verdict.ok).toBe(false);
        expect(verdict.gate).toBe('READ_ONLY_STATES');
        expect(verdict.reason).toContain(action.id);
      }
    }
    for (const state of NO_NEW_CAPITAL_STATES.filter((s) => !READ_ONLY_STATES.includes(s))) {
      for (const action of Object.values(WRITE_ACTIONS)) {
        const verdict = checkWriteAllowed(state, action);
        expect(verdict.ok).toBe(action.commitsNewCapital ? false : true);
        if (!verdict.ok) expect(verdict.gate).toBe('NO_NEW_CAPITAL_STATES');
      }
    }
  });

  it('permits writes in the operating states', () => {
    for (const state of [BOT_STATES.SWAP, BOT_STATES.ADD_LIQUIDITY, BOT_STATES.EXIT_POSITION, BOT_STATES.SWITCH_POOL]) {
      for (const action of Object.values(WRITE_ACTIONS)) {
        expect(checkWriteAllowed(state, action).ok).toBe(true);
      }
    }
  });

  it('assertWriteAllowed throws the typed error with the state, action and gate', () => {
    const error = assertWriteAllowedThrow(() => assertWriteAllowed(BOT_STATES.PAUSED, WRITE_ACTIONS.COLLECT_FEES));
    expect(error).toBeInstanceOf(StateWriteBlockedError);
    expect(error).toMatchObject({ state: BOT_STATES.PAUSED, action: 'COLLECT_FEES', gate: 'READ_ONLY_STATES' });
    expect(error?.message).toContain('read-only');
  });
});

describe('StateMachine persistence (§74)', () => {
  let db: Database;
  beforeEach(() => {
    db = openDatabase(dbPath);
  });
  afterEach(() => closeDatabase(db));

  it('starts at IDLE on a virgin database and persists every transition', () => {
    const machine = StateMachine.open(db);
    expect(machine.current).toBe(BOT_STATES.IDLE);

    machine.apply({ type: STATE_EVENTS.NO_ACTIVE_POSITION }, '2026-09-29T00:00:01.000Z');
    machine.apply({ type: STATE_EVENTS.CANDIDATE_POOL_FOUND, reason: 'QQQB/USDC passes §16' }, '2026-09-29T00:00:02.000Z');
    machine.apply({ type: STATE_EVENTS.POSITION_PLAN_READY }, '2026-09-29T00:00:03.000Z');
    expect(machine.current).toBe(BOT_STATES.SWAP);

    expect(new RuntimeStateStore(db).get()).toEqual({
      botState: BOT_STATES.SWAP,
      updatedAt: '2026-09-29T00:00:03.000Z',
      reason: 'PREPARE_POSITION->SWAP: POSITION_PLAN_READY (no reason supplied)',
      epoch: 0,
    });
  });

  it('restores the state after a restart instead of falling back to IDLE', () => {
    const first = StateMachine.open(db);
    first.apply({ type: STATE_EVENTS.OPERATOR_PAUSE, reason: 'PSA: stop trading' });
    expect(first.current).toBe(BOT_STATES.PAUSED);
    closeDatabase(db);

    const reopened = openDatabase(dbPath);
    const second = StateMachine.open(reopened);
    expect(second.current).toBe(BOT_STATES.PAUSED);
    // ...and it keeps enforcing the graph from the restored state: PAUSED allows MONITOR (so a
    // stale in-range observation must NOT be able to drive a state change by itself here), but it
    // has no edge to OUT_OF_RANGE.
    expect(() => second.apply({ type: STATE_EVENTS.PRICE_OUT_OF_RANGE })).toThrow(IllegalTransitionError);
    expect(second.apply({ type: STATE_EVENTS.OPERATOR_RESUME, target: BOT_STATES.MONITOR }).to).toBe(BOT_STATES.MONITOR);
    closeDatabase(reopened);
  });

  it('fails closed on a corrupted persisted state', () => {
    openDatabase(dbPath);
    db.exec("INSERT INTO runtime_state (singleton, bot_state, updated_at, epoch) VALUES (1, 'FLYING', '2026-09-29', 0)");
    expect(() => StateMachine.open(db)).toThrow(StoreError);
    expect(() => StateMachine.open(db)).toThrow(/unknown bot state/);
  });

  it('applyOnce tolerates a duplicate observation but still rejects an illegal edge', () => {
    const machine = StateMachine.open(db);
    machine.apply({ type: STATE_EVENTS.NO_ACTIVE_POSITION });
    machine.apply({ type: STATE_EVENTS.CANDIDATE_POOL_FOUND });
    machine.apply({ type: STATE_EVENTS.POSITION_PLAN_READY });
    machine.apply({ type: STATE_EVENTS.SWAP_CONFIRMED });
    machine.apply({ type: STATE_EVENTS.ATOMIC_BUILD_CONFIRMED });
    expect(machine.current).toBe(BOT_STATES.MONITOR);

    // A second identical observation is a no-op, not an error.
    expect(machine.applyOnce({ type: STATE_EVENTS.PRICE_IN_RANGE })).toBeNull();
    expect(machine.current).toBe(BOT_STATES.MONITOR);
    // An illegal edge still throws.
    expect(() => machine.applyOnce({ type: STATE_EVENTS.OPERATOR_RESUME })).toThrow(IllegalTransitionError);
    // canApply is the non-throwing probe.
    expect(machine.canApply({ type: STATE_EVENTS.PRICE_OUT_OF_RANGE })).toBe(true);
    expect(machine.canApply({ type: STATE_EVENTS.OPERATOR_RESUME })).toBe(false);
  });

  it('gates writes against the CURRENT persisted state', () => {
    const machine = StateMachine.open(db);
    // IDLE -> RISK_REVIEW does not exist in §88; the loop must reach MONITOR first.
    expect(() => machine.apply({ type: STATE_EVENTS.RISK_REVIEW_REQUESTED })).toThrow(IllegalTransitionError);
    machine.apply({ type: STATE_EVENTS.ACTIVE_POSITION_PRESENT, reason: 'position pos-1 is open' });
    machine.apply({ type: STATE_EVENTS.RISK_REVIEW_REQUESTED, reason: 'tvl drop 55%' });
    expect(machine.current).toBe(BOT_STATES.RISK_REVIEW);
    expect(machine.checkWriteAllowed(WRITE_ACTIONS.SWAP_BUILD)).toMatchObject({ ok: false, gate: 'NO_NEW_CAPITAL_STATES' });
    expect(machine.checkWriteAllowed(WRITE_ACTIONS.COLLECT_FEES)).toMatchObject({ ok: true });
    expect(() => machine.assertWriteAllowed(WRITE_ACTIONS.SWITCH_POOL)).toThrow(StateWriteBlockedError);
    // ...and the gate follows the persisted state, not a cached field.
    expect(new RuntimeStateStore(db).get()?.botState).toBe(BOT_STATES.RISK_REVIEW);
  });
});

/** Capture the typed error a throwing assertion produces, or `null` when it does not throw. */
function assertWriteAllowedThrow(fn: () => void): StateWriteBlockedError | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof StateWriteBlockedError) return error;
    throw error;
  }
}
