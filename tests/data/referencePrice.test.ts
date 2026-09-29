/**
 * T7 offline tests for `src/data/referencePrice.ts`.
 *
 * Everything here runs WITHOUT network: `fetchImpl` and the clock are injected, so the ladder,
 * placeholder handling, normalisation and the §56/§57 hard-exit policy are all deterministic.
 * The single live-endpoint proof lives in the slice report (a throwaway script, not a test).
 */

import { describe, expect, it, vi } from 'vitest';
import { BSC_BSTOCKS } from '../../src/config/builtins.ts';
import { createBuiltinRegistry } from '../../src/config/registry.ts';
import {
  BinanceReferencePriceProvider,
  DEFAULT_BINANCE_ENDPOINTS,
  MARKET_BY_ADDRESS,
  NYSE_HOLIDAY_CALENDAR,
  classifyMarketStatus,
  createReferencePriceProvider,
  hardExitReferenceUsable,
  normalizeOracleAnswer,
  parseBinancePrice,
  readEasternClock,
  weightedIndexPrice,
  type OnchainFeedReader,
} from '../../src/data/referencePrice.ts';
import { MARKET_STATUSES } from '../../src/types/adapters.ts';
import { DATA_SOURCES } from '../../src/types/market.ts';
import type { Address } from '../../src/types/primitives.ts';

const QQQB = '0x205812CdBed920aFf76C6580abD681a46D11efc7';
const AAPLB = '0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a';
const IMPOSTOR = '0xb904108b7f6d3b27c23128ca2b62738061b8a689';

/* ------------------------------------------------------------------ *
 * Offline fetch double
 * ------------------------------------------------------------------ */

interface RouteResponse {
  readonly status?: number;
  readonly body?: unknown;
  /** Raw text body (used for HTML/error pages). */
  readonly text?: string;
  readonly date?: string;
}

type Routes = Record<string, RouteResponse | (() => RouteResponse)>;

interface FetchCall {
  readonly url: string;
}

/**
 * Builds a `fetch` stub over an exact-URL table. An unregistered URL is a TEST BUG (the module
 * must never call something the ladder did not declare), so it throws instead of silently 404ing.
 */
function mockFetch(routes: Routes): { fetchImpl: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url });
    const entry = routes[url];
    if (entry === undefined) throw new Error(`unexpected fetch: ${url}`);
    const resolved = typeof entry === 'function' ? entry() : entry;
    const status = resolved.status ?? 200;
    const text = resolved.text ?? JSON.stringify(resolved.body ?? {});
    return new Response(text, {
      status,
      headers: {
        'content-type': resolved.text === undefined ? 'application/json' : 'text/html',
        ...(resolved.date === undefined ? {} : { date: resolved.date }),
      },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const URL_INDEX = (ticker: string): string =>
  `${DEFAULT_BINANCE_ENDPOINTS.fapi}/fapi/v1/constituents?symbol=${ticker}`;
const URL_SPOT = (ticker: string): string =>
  `${DEFAULT_BINANCE_ENDPOINTS.spot}/api/v3/ticker/price?symbol=${ticker}`;
const URL_KLINES = (ticker: string): string =>
  `${DEFAULT_BINANCE_ENDPOINTS.spot}/api/v3/klines?symbol=${ticker}&interval=1d&limit=2`;

const QQQB_INDEX_URL = URL_INDEX('QQQBUSDT');
const QQQB_SPOT_URL = URL_SPOT('QQQBUSDT');

/** A live US session: Wednesday 2026-07-15 14:00 UTC = 10:00 ET (session open, DST active). */
const OPEN_ET = new Date('2026-07-15T14:00:00.000Z');
/** The same day, 13:00 ET = 17:00 UTC (after the close). */
const AFTER_CLOSE_ET = new Date('2026-07-15T21:00:00.000Z');
const SATURDAY_ET = new Date('2026-07-18T15:00:00.000Z');

function providerAt(
  at: Date,
  routes: Routes,
  extra: Partial<Parameters<typeof createReferencePriceProvider>[0]> = {},
): { provider: BinanceReferencePriceProvider; calls: FetchCall[] } {
  const { fetchImpl, calls } = mockFetch(routes);
  const provider = createReferencePriceProvider({
    fetchImpl,
    now: () => at,
    ...extra,
  });
  return { provider, calls };
}

/* ------------------------------------------------------------------ *
 * Placeholder handling — `price <= 0` / `"-1"` is OFFICIALLY invalid
 * ------------------------------------------------------------------ */

describe('placeholder prices are invalid, never averaged in', () => {
  it('treats the measured "-1" constituent placeholder as invalid', () => {
    expect(parseBinancePrice('-1')).toBeNull();
    expect(parseBinancePrice('-1.00000000')).toBeNull();
  });

  it('finally rejects zero, negative, empty and non-numeric strings', () => {
    for (const raw of ['0', '0.00000000', '-0.5', '', '   ', 'abc', 'NaN', 'Infinity', null, undefined, {}]) {
      expect(parseBinancePrice(raw)).toBeNull();
    }
  });

  it('accepts a real decimal string exactly', () => {
    expect(parseBinancePrice('359.15000000')).toBe(359.15);
    expect(parseBinancePrice('738.69000000')).toBe(738.69);
  });

  it('discards the WHOLE index when any weighted constituent is a placeholder', () => {
    // 5 real prints + 1 placeholder: renormalising would understate the index, so it must be null.
    expect(
      weightedIndexPrice([
        { price: '738.69', weight: '0.5' },
        { price: '-1', weight: '0.5' },
      ]),
    ).toBeNull();
    expect(weightedIndexPrice([])).toBeNull();
    expect(weightedIndexPrice([{ price: '738.69', weight: '0' }])).toBeNull();
  });

  it('computes the official weight-weighted mean of valid constituents', () => {
    // Weights 0.25/0.75 of 100/200 ⇒ 175.
    expect(
      weightedIndexPrice([
        { price: '100', weight: '0.25' },
        { price: '200', weight: '0.75' },
      ]),
    ).toBe(175);
  });
});

/* ------------------------------------------------------------------ *
 * Ladder + fallback
 * ------------------------------------------------------------------ */

describe('source ladder: index → spot → oracle', () => {
  it('uses the weighted index when every constituent has a real print', () => {
    const { provider } = providerAt(OPEN_ET, {
      [QQQB_INDEX_URL]: () => ({
        body: {
          symbol: 'QQQBUSDT',
          time: OPEN_ET.getTime(),
          constituents: [
            { exchange: 'binance_future', symbol: 'QQQUSDT', price: '738.00', weight: '0.5' },
            { exchange: 'kaiko', symbol: 'KK_RFR_QQQUSD', price: '740.00', weight: '0.5' },
          ],
        },
        date: OPEN_ET.toUTCString(),
      }),
    });

    return provider.getStockReferencePrice(QQQB).then((sourced) => {
      expect(sourced.value).toBe(739);
      expect(sourced.source).toBe(DATA_SOURCES.BINANCE_INDEX);
      expect(sourced.stale).toBe(false);
      expect(sourced.asOf).toBe(OPEN_ET.toISOString());
    });
  });

  it('falls back to spot when the live index is entirely "-1" placeholders (the measured 2026-09-29 state)', async () => {
    const { provider, calls } = providerAt(OPEN_ET, {
      [QQQB_INDEX_URL]: {
        body: {
          symbol: 'QQQBUSDT',
          time: OPEN_ET.getTime(),
          constituents: [
            { exchange: 'binance_future', symbol: 'QQQUSDT', price: '-1', weight: '0.00735294' },
            { exchange: 'dxfeed', symbol: 'QQQ:USLF24', price: '-1', weight: '0.25735294' },
          ],
        },
        date: OPEN_ET.toUTCString(),
      },
      [QQQB_SPOT_URL]: { body: { symbol: 'QQQBUSDT', price: '738.69000000' }, date: OPEN_ET.toUTCString() },
    });

    const result = await provider.getStockReferencePrice(QQQB);
    expect(result.value).toBe(738.69);
    expect(result.source).toBe(DATA_SOURCES.BINANCE_SPOT);
    expect(result.stale).toBe(false);
    // The ladder really did try the index first and then fall through.
    expect(calls.map((call) => call.url)).toEqual([QQQB_INDEX_URL, QQQB_SPOT_URL]);
    expect(provider.getLastAttempts()).toEqual([
      { source: DATA_SOURCES.BINANCE_INDEX, ok: false, detail: expect.any(String) },
      { source: DATA_SOURCES.BINANCE_SPOT, ok: true, detail: expect.any(String) },
    ]);
  });

  it('falls back to spot when the index returns 5xx', async () => {
    const { provider } = providerAt(OPEN_ET, {
      [QQQB_INDEX_URL]: { status: 503, text: '<html>maintenance</html>' },
      [QQQB_SPOT_URL]: { body: { symbol: 'QQQBUSDT', price: '700.5' }, date: OPEN_ET.toUTCString() },
    });

    const result = await provider.getStockReferencePrice(QQQB);
    expect(result.value).toBe(700.5);
    expect(result.source).toBe(DATA_SOURCES.BINANCE_SPOT);
  });

  it('falls back to spot when the index body is malformed', async () => {
    for (const body of [{ code: -1121, msg: 'Invalid symbol.' }, { symbol: 'QQQBUSDT' }, { symbol: 1, constituents: 'x' }]) {
      const { provider } = providerAt(OPEN_ET, {
        [QQQB_INDEX_URL]: { body },
        [QQQB_SPOT_URL]: { body: { symbol: 'QQQBUSDT', price: '700.5' }, date: OPEN_ET.toUTCString() },
      });
      const result = await provider.getStockReferencePrice(QQQB);
      expect(result.value).toBe(700.5);
    }
  });

  it('returns UNAVAILABLE + stale and NO guessed price when every rung fails', async () => {
    const { provider } = providerAt(OPEN_ET, {
      [QQQB_INDEX_URL]: { status: 500, text: 'boom' },
      [QQQB_SPOT_URL]: { status: 502, text: 'bad gateway' },
    });

    const result = await provider.getStockReferencePrice(QQQB);
    expect(result.value).toBeNull();
    expect(result.source).toBe(DATA_SOURCES.UNAVAILABLE);
    expect(result.stale).toBe(true);
    expect(result.asOf).toBe(OPEN_ET.toISOString());
  });

  it('refuses to price an address that is not a known bStocks market (no symbol guessing)', async () => {
    const { provider, calls } = providerAt(OPEN_ET, {});
    const result = await provider.getStockReferencePrice(IMPOSTOR);
    expect(result.value).toBeNull();
    expect(result.source).toBe(DATA_SOURCES.UNAVAILABLE);
    expect(result.stale).toBe(true);
    expect(calls).toEqual([]);
  });

  it('refuses to price a whitelisted NON-bStock address (USDC is not in the bStocks table)', async () => {
    const { provider } = providerAt(OPEN_ET, {});
    const result = await provider.getStockReferencePrice('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d');
    expect(result.value).toBeNull();
    expect(result.stale).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * On-chain APRO rung + decimal normalisation
 * ------------------------------------------------------------------ */

describe('on-chain rung and decimal normalisation', () => {
  it('normalises an 8-decimal Chainlink-style equity feed exactly', () => {
    // AAPL-style feed: 336.12345678 at 8 decimals.
    expect(normalizeOracleAnswer(33_612_345_678n, 8)).toBe(336.12345678);
    // $1.00 at 8 decimals.
    expect(normalizeOracleAnswer(100_000_000n, 8)).toBe(1);
  });

  it('normalises an 18-decimal feed (USDC/USD-style) to the same USD scale', () => {
    // 1.000000000000000000 → 1 USD, and the same economic value as 100_000_000 @ 8dp.
    expect(normalizeOracleAnswer(1_000_000_000_000_000_000n, 18)).toBe(1);
    expect(normalizeOracleAnswer(1_000_000_000_000_000_000n, 18)).toBe(normalizeOracleAnswer(100_000_000n, 8));
    expect(normalizeOracleAnswer(359_150_000_000_000_000_000n, 18)).toBe(359.15);
  });

  it('rejects a zero/negative answer and a nonsensical decimals value', () => {
    expect(normalizeOracleAnswer(0n, 8)).toBeNull();
    expect(normalizeOracleAnswer(-1n, 8)).toBeNull();
    expect(normalizeOracleAnswer(100_000_000n, -1)).toBeNull();
    expect(normalizeOracleAnswer(100_000_000n, 40)).toBeNull();
  });

  it('uses the on-chain feed as the last rung, and reports the feed-sourced asOf', async () => {
    const feed = '0x2708567c468db65a72095716fcff023dcdfea07a';
    const readLatestRoundData = vi.fn(async (address: Address) =>
      address === feed
        ? { answer: 739_290_000_000_000_000_000n, decimals: 18, updatedAt: Math.floor(OPEN_ET.getTime() / 1000) }
        : null,
    );
    const oracle: OnchainFeedReader = { readLatestRoundData };

    const { provider } = providerAt(
      OPEN_ET,
      {
        [QQQB_INDEX_URL]: { status: 500, text: 'down' },
        [QQQB_SPOT_URL]: { status: 500, text: 'down' },
      },
      { oracle },
    );

    const result = await provider.getStockReferencePrice(QQQB);
    expect(result.value).toBe(739.29);
    expect(result.source).toBe(DATA_SOURCES.ORACLE);
    expect(result.stale).toBe(false);
    expect(result.asOf).toBe(OPEN_ET.toISOString());
    expect(readLatestRoundData).toHaveBeenCalledTimes(1);
  });

  it('skips the on-chain rung entirely for AAPLB/AMZNB, which have no APRO feed', async () => {
    const readLatestRoundData = vi.fn(async () => null);
    const { provider } = providerAt(
      OPEN_ET,
      {
        [URL_INDEX('AAPLBUSDT')]: { status: 500, text: 'down' },
        [URL_SPOT('AAPLBUSDT')]: { body: { symbol: 'AAPLBUSDT', price: '336.82' }, date: OPEN_ET.toUTCString() },
      },
      { oracle: { readLatestRoundData } },
    );

    expect(MARKET_BY_ADDRESS[AAPLB]?.aproFeed).toBeUndefined();
    expect((BSC_BSTOCKS.find((token) => token.address === AAPLB)?.symbol)).toBe('AAPLB');
    const result = await provider.getStockReferencePrice(AAPLB);
    expect(result.value).toBe(336.82);
    expect(readLatestRoundData).not.toHaveBeenCalled();
  });

  it('treats a reverting/absent feed as a rung failure instead of throwing', async () => {
    const oracle: OnchainFeedReader = {
      readLatestRoundData: async () => {
        throw new Error('execution reverted');
      },
    };
    const { provider } = providerAt(
      OPEN_ET,
      {
        [QQQB_INDEX_URL]: { status: 500, text: 'down' },
        [QQQB_SPOT_URL]: { status: 500, text: 'down' },
      },
      { oracle },
    );
    const result = await provider.getStockReferencePrice(QQQB);
    expect(result.value).toBeNull();
    expect(result.stale).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Indicative price + latest close
 * ------------------------------------------------------------------ */

describe('indicative price and latest close', () => {
  it('prefers the continuous spot quote for the §57 indicative price', async () => {
    const { provider, calls } = providerAt(OPEN_ET, {
      [QQQB_SPOT_URL]: { body: { symbol: 'QQQBUSDT', price: '738.69' }, date: OPEN_ET.toUTCString() },
      [QQQB_INDEX_URL]: { body: { symbol: 'QQQBUSDT', constituents: [] }, date: OPEN_ET.toUTCString() },
    });

    const result = await provider.getIndicativePrice(QQQB);
    expect(result.value).toBe(738.69);
    expect(result.source).toBe(DATA_SOURCES.BINANCE_SPOT);
    expect(calls.map((call) => call.url)).toEqual([QQQB_SPOT_URL]);
  });

  it('returns the frozen Binance index as the latest close while the market is closed', async () => {
    const frozen = new Date(AFTER_CLOSE_ET.getTime() - 60 * 60 * 1000);
    const { provider } = providerAt(AFTER_CLOSE_ET, {
      [QQQB_INDEX_URL]: {
        body: {
          symbol: 'QQQBUSDT',
          time: frozen.getTime(),
          constituents: [
            { exchange: 'kaiko', symbol: 'KK_RFR_QQQUSD', price: '739.35', weight: '0.5' },
            { exchange: 'dxfeed', symbol: 'QQQ:USLF24', price: '739.35', weight: '0.5' },
          ],
        },
        date: frozen.toUTCString(),
      },
    });

    const result = await provider.getLatestClose(QQQB);
    expect(result.value).toBe(739.35);
    expect(result.source).toBe(DATA_SOURCES.BINANCE_INDEX);
    // A 1h-old close is stale under the 120s open-market budget but NOT under the closed budget.
    expect(result.stale).toBe(false);
    expect(result.asOf).toBe(frozen.toISOString());
  });

  it('falls back to the last COMPLETED daily candle close when the index is unavailable', async () => {
    // Candle boundaries derived from the injected clock so the "completed vs still-open" split is
    // explicit: the first candle closed an hour ago, the second is still forming.
    const dayMs = 24 * 60 * 60 * 1000;
    const completedCloseTime = Math.floor((AFTER_CLOSE_ET.getTime() - 60 * 60 * 1000) / 1000) * 1000;
    const openCloseTime = AFTER_CLOSE_ET.getTime() + 60 * 60 * 1000;
    const { provider } = providerAt(AFTER_CLOSE_ET, {
      [QQQB_INDEX_URL]: { status: 500, text: 'down' },
      [URL_KLINES('QQQBUSDT')]: {
        body: [
          // Completed candle ⇒ 737.30 is the close.
          [completedCloseTime - dayMs, '743.46', '744.61', '727.82', '737.30', '7944.34', completedCloseTime, '5847257.70', 27612, '2501.07', '1844068.17', '0'],
          // Still-open candle (closeTime in the future) ⇒ must be ignored.
          [completedCloseTime, '737.27', '739.35', '732.42', '739.35', '2098.34', openCloseTime, '1543510.56', 22022, '1392.94', '1024552.37', '0'],
        ],
      },
    });

    const result = await provider.getLatestClose(QQQB);
    expect(result.value).toBe(737.3);
    expect(result.source).toBe(DATA_SOURCES.BINANCE_SPOT);
    expect(result.asOf).toBe(new Date(completedCloseTime).toISOString());
  });
});

/* ------------------------------------------------------------------ *
 * Staleness
 * ------------------------------------------------------------------ */

describe('staleness thresholds', () => {
  it('marks a beyond-budget index value stale while the market is open', async () => {
    const old = new Date(OPEN_ET.getTime() - 10 * 60 * 1000);
    const { provider } = providerAt(OPEN_ET, {
      [QQQB_INDEX_URL]: {
        body: {
          symbol: 'QQQBUSDT',
          time: old.getTime(),
          constituents: [{ exchange: 'kaiko', symbol: 'KK', price: '739.35', weight: '1' }],
        },
        date: old.toUTCString(),
      },
      [QQQB_SPOT_URL]: { status: 500, text: 'down' },
    });

    const result = await provider.getStockReferencePrice(QQQB);
    expect(result.value).toBe(739.35); // still surfaced, but flagged
    expect(result.stale).toBe(true);
    expect(result.source).toBe(DATA_SOURCES.BINANCE_INDEX);
  });

  it('allows a multi-day-old close only while the market is closed (§57 freeze behaviour)', async () => {
    // Friday close, read on Sunday ⇒ ~2 days old; a legitimately frozen index.
    const fridayClose = new Date('2026-07-17T20:00:00.000Z');
    const routes: Routes = {
      [QQQB_INDEX_URL]: {
        body: {
          symbol: 'QQQBUSDT',
          time: fridayClose.getTime(),
          constituents: [{ exchange: 'kaiko', symbol: 'KK', price: '735.00', weight: '1' }],
        },
        date: fridayClose.toUTCString(),
      },
    };
    const sunday = providerAt(SATURDAY_ET, routes);
    expect((await sunday.provider.getLatestClose(QQQB)).stale).toBe(false);

    // Four days alone is fine; five is beyond the 4-day closed budget.
    const fiveDays = new Date(fridayClose.getTime() + 5 * 24 * 60 * 60 * 1000);
    const late = providerAt(fiveDays, routes);
    expect((await late.provider.getLatestClose(QQQB)).stale).toBe(true);
  });

  it('falls back to its own clock when the payload has no usable timestamp', async () => {
    const { provider } = providerAt(OPEN_ET, {
      [QQQB_INDEX_URL]: {
        body: {
          symbol: 'QQQBUSDT',
          time: 'not-a-number',
          constituents: [{ exchange: 'kaiko', symbol: 'KK', price: '735.00', weight: '1' }],
        },
      },
      [QQQB_SPOT_URL]: { status: 500, text: 'down' },
    });
    // No HTTP Date header either ⇒ the provider falls back to its own clock, so it is fresh.
    const result = await provider.getStockReferencePrice(QQQB);
    expect(result.value).toBe(735);
    expect(result.source).toBe(DATA_SOURCES.BINANCE_INDEX);
  });
});

/* ------------------------------------------------------------------ *
 * §56 market hours
 * ------------------------------------------------------------------ */

describe('§56 market status', () => {
  it('reports the regular session as open, with DST applied', () => {
    // 2026-07-15 is EDT (UTC-4): 13:29Z = 09:29 ET, 13:30Z = 09:30 ET, 20:00Z = 16:00 ET.
    expect(classifyMarketStatus(new Date('2026-07-15T13:29:00Z'))).toBe(MARKET_STATUSES.CLOSED);
    expect(classifyMarketStatus(new Date('2026-07-15T13:30:00Z'))).toBe(MARKET_STATUSES.OPEN);
    expect(classifyMarketStatus(new Date('2026-07-15T19:59:59Z'))).toBe(MARKET_STATUSES.OPEN);
    expect(classifyMarketStatus(new Date('2026-07-15T20:00:00Z'))).toBe(MARKET_STATUSES.CLOSED);
  });

  it('shifts by one hour under EST (winter) — the same UTC instant differs', () => {
    // 2026-01-20 is EST (UTC-5): 14:30Z = 09:30 ET (open) vs 13:30Z = 08:30 ET (closed).
    expect(classifyMarketStatus(new Date('2026-01-20T14:29:00Z'))).toBe(MARKET_STATUSES.CLOSED);
    expect(classifyMarketStatus(new Date('2026-01-20T14:30:00Z'))).toBe(MARKET_STATUSES.OPEN);
    // The identical wall-clock UTC time that was "open" in July is still pre-open in January.
    expect(classifyMarketStatus(new Date('2026-07-15T14:30:00Z'))).toBe(MARKET_STATUSES.OPEN);
  });

  it('reports weekends as weekend (§56: never compare Saturday against Friday close)', () => {
    expect(classifyMarketStatus(new Date('2026-07-18T15:00:00Z'))).toBe(MARKET_STATUSES.WEEKEND); // Sat
    expect(classifyMarketStatus(new Date('2026-07-19T15:00:00Z'))).toBe(MARKET_STATUSES.WEEKEND); // Sun
  });

  it('reports the static-calendar holidays, including Good Friday and the observed shift', () => {
    for (const date of [
      '2026-01-01', // New Year's Day
      '2026-04-03', // Good Friday
      '2026-06-19', // Juneteenth
      '2026-07-03', // Independence Day observed (4th is a Saturday)
      '2026-09-07', // Labor Day
      '2026-11-26', // Thanksgiving
      '2026-12-25', // Christmas
      '2027-03-26', // Good Friday 2027
      '2027-07-05', // Independence Day observed 2027
    ]) {
      expect(NYSE_HOLIDAY_CALENDAR.holidays).toContain(date);
      expect(classifyMarketStatus(new Date(`${date}T15:00:00Z`))).toBe(MARKET_STATUSES.HOLIDAY);
    }
  });

  it('closes at 13:00 ET on the early-close days', () => {
    expect(NYSE_HOLIDAY_CALENDAR.earlyCloses).toContain('2026-11-27');
    // 2026-11-27 is EST: 17:30Z = 12:30 ET (open) and 18:00Z = 13:00 ET (closed).
    expect(classifyMarketStatus(new Date('2026-11-27T17:30:00Z'))).toBe(MARKET_STATUSES.OPEN);
    expect(classifyMarketStatus(new Date('2026-11-27T18:00:00Z'))).toBe(MARKET_STATUSES.CLOSED);
    // An ordinary Friday at 13:00 ET is still open.
    expect(classifyMarketStatus(new Date('2026-12-04T18:00:00Z'))).toBe(MARKET_STATUSES.OPEN);
  });

  it('treats the 15:30–18:00 ET window as closed (no pre/after in the frozen contract)', () => {
    // Pre-market 08:00 ET and after-hours 17:00 ET are NOT the regular session the NAV tracks.
    expect(classifyMarketStatus(new Date('2026-07-15T12:00:00Z'))).toBe(MARKET_STATUSES.CLOSED);
    expect(classifyMarketStatus(new Date('2026-07-15T21:00:00Z'))).toBe(MARKET_STATUSES.CLOSED);
  });

  it('reads the US/Eastern wall clock (DST-independent basis)', () => {
    expect(readEasternClock(OPEN_ET)).toEqual({
      date: '2026-07-15',
      weekday: 3,
      hour: 10,
      minute: 0,
      minutesOfDay: 600,
    });
    expect(readEasternClock(new Date('2026-01-20T14:30:00Z'))?.minutesOfDay).toBe(9 * 60 + 30);
  });

  it('exposes the status through the provider interface', async () => {
    const { provider } = providerAt(SATURDAY_ET, {});
    expect(await provider.getMarketStatus()).toBe(MARKET_STATUSES.WEEKEND);
  });
});

/* ------------------------------------------------------------------ *
 * §57 hard-exit gating
 * ------------------------------------------------------------------ */

describe('§57 hard exit is disabled on closed markets', () => {
  const fresh = (asOf: Date, value: number): Parameters<typeof hardExitReferenceUsable>[0]['reference'] => ({
    value,
    source: DATA_SOURCES.BINANCE_INDEX,
    asOf: asOf.toISOString(),
    stale: false,
  });

  it('allows a hard exit only while the regular session is open with a fresh reference', () => {
    expect(
      hardExitReferenceUsable({ marketStatus: MARKET_STATUSES.OPEN, reference: fresh(OPEN_ET, 739) }).usable,
    ).toBe(true);
  });

  it('blocks the hard exit when the market is open but no reference could be read', () => {
    const verdict = hardExitReferenceUsable({
      marketStatus: MARKET_STATUSES.OPEN,
      reference: { value: null, source: DATA_SOURCES.UNAVAILABLE, asOf: OPEN_ET.toISOString(), stale: true },
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.reason).toContain('unusable');
  });

  it('blocks the hard exit when the market is open but the reference is stale', () => {
    const verdict = hardExitReferenceUsable({
      marketStatus: MARKET_STATUSES.OPEN,
      reference: { ...fresh(OPEN_ET, 739), stale: true },
    });
    expect(verdict.usable).toBe(false);
  });

  it('degrades to alert-only on closed / weekend / holiday / unknown', () => {
    for (const status of [
      MARKET_STATUSES.CLOSED,
      MARKET_STATUSES.WEEKEND,
      MARKET_STATUSES.HOLIDAY,
      MARKET_STATUSES.UNKNOWN,
    ]) {
      const verdict = hardExitReferenceUsable({ marketStatus: status, reference: fresh(AFTER_CLOSE_ET, 739) });
      expect(verdict.usable).toBe(false);
      expect(verdict.reason).toContain('alert-only');
    }
  });

  it('re-enables a hard exit only with an EXPLICIT §57 alternative reference', () => {
    const verdict = hardExitReferenceUsable({
      marketStatus: MARKET_STATUSES.CLOSED,
      reference: { value: null, source: DATA_SOURCES.UNAVAILABLE, asOf: OPEN_ET.toISOString(), stale: true },
      alternativeReference: {
        value: 739.4,
        source: DATA_SOURCES.BINANCE_SPOT,
        asOf: OPEN_ET.toISOString(),
        stale: false,
      },
    });
    expect(verdict.usable).toBe(true);
    expect(verdict.reason).toContain('alternative reference pricing');

    // A stale alternative is not an alternative.
    expect(
      hardExitReferenceUsable({
        marketStatus: MARKET_STATUSES.CLOSED,
        reference: fresh(OPEN_ET, 739),
        alternativeReference: { ...fresh(OPEN_ET, 739), stale: true },
      }).usable,
    ).toBe(false);
  });

  it('wires marketStatus + reference + verdict together for the risk manager', async () => {
    const { provider } = providerAt(SATURDAY_ET, {
      [QQQB_INDEX_URL]: {
        body: {
          symbol: 'QQQBUSDT',
          time: new Date('2026-07-17T20:00:00.000Z').getTime(),
          constituents: [{ exchange: 'kaiko', symbol: 'KK', price: '735.00', weight: '1' }],
        },
        date: new Date('2026-07-17T20:00:00.000Z').toUTCString(),
      },
    });

    const outcome = await provider.getHardExitReference(QQQB);
    expect(outcome.marketStatus).toBe(MARKET_STATUSES.WEEKEND);
    expect(outcome.reference.value).toBe(735);
    expect(outcome.reference.source).toBe(DATA_SOURCES.BINANCE_INDEX);
    expect(outcome.verdict.usable).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Table integrity
 * ------------------------------------------------------------------ */

describe('address → ticker table', () => {
  it('covers exactly the whitelisted bStocks, keyed by lowercased address', () => {
    const stockTokens = createBuiltinRegistry().listStockTokens();
    expect(stockTokens).toHaveLength(8);
    for (const token of stockTokens) {
      const entry = MARKET_BY_ADDRESS[token.address];
      if (entry === undefined) throw new Error(`${token.symbol} missing from the bStocks ticker table`);
      expect(entry.ticker).toBe(`${token.symbol.toUpperCase()}USDT`);
      expect(entry.address).toBe(entry.address.toLowerCase());
    }
    expect(Object.keys(MARKET_BY_ADDRESS)).toHaveLength(8);
  });

  it('has an APRO feed for 6 of 8 bStocks and none for AAPLB / AMZNB (research §3)', () => {
    const withFeed = Object.values(MARKET_BY_ADDRESS).filter((entry) => entry.aproFeed !== undefined);
    expect(withFeed.map((entry) => entry.ticker).sort()).toEqual([
      'METABUSDT',
      'MSFTBUSDT',
      'NVDABUSDT',
      'PLTRBUSDT',
      'QQQBUSDT',
      'TSLABUSDT',
    ]);
    expect(MARKET_BY_ADDRESS[AAPLB]?.aproFeed).toBeUndefined();
    expect(MARKET_BY_ADDRESS['0x1a4b499833a79a09ad7cf1d42d7dacf71e92eb00']?.aproFeed).toBeUndefined();
  });

  it('aborts construction when the table disagrees with the whitelist (fail closed)', () => {
    const registry = createBuiltinRegistry();
    const qqqbLower = QQQB.toLowerCase();
    const tampered = {
      getTokenByAddress: (chainId: number, address: Address) => {
        const token = registry.getTokenByAddress(chainId, address);
        if (token === null || address.toLowerCase() !== qqqbLower) return token;
        return { ...token, symbol: 'SPYB' };
      },
    };
    expect(() =>
      createReferencePriceProvider({ registry: tampered as never }),
    ).toThrow(/wrong instrument/);
    // The un-tampered registry is accepted (proving the check is not trivially failing).
    expect(() => createReferencePriceProvider({ registry })).not.toThrow();
  });
});
