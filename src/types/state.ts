/**
 * §44 bot states (full set). `PARTIAL_POSITION` and `EMERGENCY` are additional states required
 * by this iteration's plan (§43 partial fills; §58 emergency marker) and are documented as
 * extensions so no consumer has to invent one.
 */
export const BOT_STATES = {
  IDLE: 'IDLE',
  SELECT_POOL: 'SELECT_POOL',
  PREPARE_POSITION: 'PREPARE_POSITION',
  SWAP: 'SWAP',
  ADD_LIQUIDITY: 'ADD_LIQUIDITY',
  MONITOR: 'MONITOR',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  UNDERPERFORMING: 'UNDERPERFORMING',
  SEARCH_REPLACEMENT: 'SEARCH_REPLACEMENT',
  EXIT_POSITION: 'EXIT_POSITION',
  SWITCH_POOL: 'SWITCH_POOL',
  RISK_REVIEW: 'RISK_REVIEW',
  GLOBAL_RISK_OFF: 'GLOBAL_RISK_OFF',
  PAUSED: 'PAUSED',
  ERROR: 'ERROR',
  /** §43 extension: a build/exit partially executed; requires manual review, never auto-retry. */
  PARTIAL_POSITION: 'PARTIAL_POSITION',
  /** §58 extension: an emergency condition is active. */
  EMERGENCY: 'EMERGENCY',
} as const;
export type BotState = (typeof BOT_STATES)[keyof typeof BOT_STATES];

/**
 * Allowed transitions, transcribed from the §88 state machine diagram plus the §45 main loop.
 * The state machine must reject any edge not listed here (§96 fail closed).
 */
export const BOT_STATE_TRANSITIONS: Readonly<Record<BotState, readonly BotState[]>> = {
  IDLE: ['SELECT_POOL', 'MONITOR', 'GLOBAL_RISK_OFF', 'PAUSED', 'ERROR'],
  SELECT_POOL: ['PREPARE_POSITION', 'IDLE', 'ERROR', 'PAUSED'],
  PREPARE_POSITION: ['SWAP', 'ADD_LIQUIDITY', 'IDLE', 'ERROR', 'PAUSED'],
  SWAP: ['ADD_LIQUIDITY', 'PARTIAL_POSITION', 'ERROR', 'PAUSED'],
  ADD_LIQUIDITY: ['MONITOR', 'PARTIAL_POSITION', 'ERROR', 'PAUSED'],
  MONITOR: [
    'OUT_OF_RANGE',
    'UNDERPERFORMING',
    'RISK_REVIEW',
    'EXIT_POSITION',
    'GLOBAL_RISK_OFF',
    'EMERGENCY',
    'PAUSED',
    'ERROR',
  ],
  OUT_OF_RANGE: ['MONITOR', 'RISK_REVIEW', 'EXIT_POSITION', 'SEARCH_REPLACEMENT', 'GLOBAL_RISK_OFF', 'EMERGENCY', 'PAUSED'],
  UNDERPERFORMING: ['SEARCH_REPLACEMENT', 'MONITOR', 'EXIT_POSITION', 'PAUSED'],
  SEARCH_REPLACEMENT: ['MONITOR', 'SWITCH_POOL', 'EXIT_POSITION', 'PAUSED'],
  EXIT_POSITION: ['PAUSED', 'PARTIAL_POSITION', 'GLOBAL_RISK_OFF', 'ERROR'],
  SWITCH_POOL: ['MONITOR', 'PARTIAL_POSITION', 'ERROR', 'PAUSED'],
  RISK_REVIEW: ['MONITOR', 'EXIT_POSITION', 'GLOBAL_RISK_OFF', 'EMERGENCY', 'PAUSED'],
  GLOBAL_RISK_OFF: ['PAUSED', 'RISK_REVIEW', 'ERROR'],
  PARTIAL_POSITION: ['RISK_REVIEW', 'PAUSED', 'ERROR'],
  EMERGENCY: ['PAUSED', 'ERROR'],
  // Recovery out of PAUSED / ERROR is always an explicit operator action.
  PAUSED: ['IDLE', 'MONITOR', 'GLOBAL_RISK_OFF', 'ERROR'],
  ERROR: ['IDLE', 'PAUSED'],
};

/** States in which no new capital may be committed (§66 "stop new positions"). */
export const NO_NEW_CAPITAL_STATES: readonly BotState[] = [
  BOT_STATES.RISK_REVIEW,
  BOT_STATES.GLOBAL_RISK_OFF,
  BOT_STATES.EMERGENCY,
  BOT_STATES.PARTIAL_POSITION,
  BOT_STATES.PAUSED,
  BOT_STATES.ERROR,
];

/** States in which the bot must not send any transaction at all. */
export const READ_ONLY_STATES: readonly BotState[] = [
  BOT_STATES.GLOBAL_RISK_OFF,
  BOT_STATES.EMERGENCY,
  BOT_STATES.PAUSED,
  BOT_STATES.ERROR,
];
