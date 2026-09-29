/**
 * §84 ReferencePriceProvider — the Reference NAV / deviation filter & peg-ladder input stack.
 *
 * ## Why the provenance matters (§56–§57)
 * `Sourced<T>` travels with every price, because the §55 peg ladder may only escalate to a HARD
 * exit when the reference is trustworthy. On closed markets the reference is a frozen last close,
 * so V1 only alerts (`Disable Hard Depeg Exit`, §57) — see `hardExitReferenceUsable`.
 *
 * ## Source ladder (research `onchain-facts-2026-09-29.md` §3)
 * 1. `binance-index` — `GET {fapi}/fapi/v1/constituents?symbol=<TICKER>USDT`. The official
 *    bStocks index: third-party live US equity prints + Binance futures, weighted. The payload
 *    carries `constituents[].price`/`weight`; the index value is the weight-weighted mean. Binance's
 *    documented behaviour after the US close is to FREEZE the index at the last valid close until
 *    the next session — which is exactly what §56 needs, so this is also the `getLatestClose` source.
 * 2. `binance-spot` — `GET {api}/api/v3/ticker/price?symbol=<TICKER>USDT`. Continuous and always
 *    readable; for bStocks it is an INDICATIVE price (24/7, can carry a premium/discount vs the
 *    underlying NAV), which is why it may only back an alternative/indicative reference (§57).
 * 3. `oracle` — optional on-chain APRO `latestRoundData()` reader (injected; only 6 of the 8
 *    bStocks have an APRO feed, see `APRO_BSTOCK_FEEDS`). Decimals are normalised from the feed's
 *    own answer, never assumed (8 for Chainlink equity feeds, 18 for USDC/USD-style feeds).
 *
 * ## Placeholder handling (measured 2026-09-29)
 * The `/constituents` endpoint is reachable and returns fresh weights, but its `price` fields were
 * observed as `"-1"` placeholders while the US market is open. `"-1"`, `"0"`, negative and
 * non-numeric prices are all INVALID: a source with any invalid constituent is discarded whole
 * (the weighted mean is only meaningful when every official weight has a real print), and the
 * ladder falls through. Nothing is ever guessed: when every source fails this returns
 * `{ value: null, source: 'unavailable', stale: true }`.
 */

import { BSC_CHAIN_ID } from '../config/builtins.ts';
import {
  MARKET_STATUSES,
  type MarketStatus,
  type ReferencePriceProvider,
} from '../types/adapters.ts';
import { DATA_SOURCES, type DataSource, type Sourced } from '../types/market.ts';
import type { Address, ChainId, IsoTimestamp, PriceUsd, UnixSeconds } from '../types/primitives.ts';
import { WhitelistError, type TokenRegistry } from '../types/registry.ts';

/* ------------------------------------------------------------------ *
 * Binance bStocks market facts (address-keyed — symbol is display-only)
 * ------------------------------------------------------------------ */

/**
 * One bStocks market. Keyed by the LOWERCASED CONTRACT ADDRESS (baseline §8): the ticker is an
 * attribute of the address, never a resolution path, so the same-symbol impostors documented in
 * research §1 can never be priced by accident.
 */
export interface BstockMarket {
  /** Lowercased BSC contract address (the identity). */
  readonly address: Address;
  /** Binance USDT-quoted symbol shared by the spot and USDⓈ-M index endpoints. */
  readonly ticker: string;
  /** APRO AggregatorV3 push feed on BSC, when one exists (research §3). */
  readonly aproFeed?: Address;
}

/** `ticker` = `<symbol>USDT`; all 8 observed TRADING on both Binance spot and the bStocks index. */
function market(address: Address, symbol: string, aproFeed?: Address): BstockMarket {
  return {
    address: address.toLowerCase() as Address,
    ticker: `${symbol}USDT`,
    ...(aproFeed === undefined ? {} : { aproFeed: aproFeed.toLowerCase() as Address }),
  };
}

/**
 * All 8 whitelisted bStocks (research §1) keyed by lowercased contract address. A static
 * Record, not a Map: the table never mutates and the key space is a closed literal set.
 *
 * AAPLB / AMZNB have NO APRO feed — they degrade to the Binance HTTP rungs only (research §3).
 */
export const MARKET_BY_ADDRESS: Readonly<Record<Address, BstockMarket>> = {
  '0x205812cdbed920aff76c6580abd681a46d11efc7': market(
    '0x205812CdBed920aFf76C6580abD681a46D11efc7',
    'QQQB',
    '0x2708567c468db65a72095716FCff023dcDfEA07A',
  ),
  '0x80106cb3ead06659a5ad19df39d9b4733863b9b0': market(
    '0x80106cb3ead06659a5ad19df39d9b4733863b9b0',
    'MSFTB',
    '0xBC92F296c48E31409eD4DbD638F1fbe0ee5A3724',
  ),
  '0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a': market(
    '0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a',
    'AAPLB',
  ),
  '0x1a4b499833a79a09ad7cf1d42d7dacf71e92eb00': market(
    '0x1a4b499833a79a09ad7cf1d42d7dacf71e92eb00',
    'AMZNB',
  ),
  '0x7425889fe94f9d693e8daefe88bcced6acfef4c0': market(
    '0x7425889fe94f9d693e8daefe88bcced6acfef4c0',
    'METAB',
    '0x32Fd1E5E20b091Df7286EE8C69937C4A8D619885',
  ),
  '0x02fca66c1d1afb4e2a7884261eb00f63598a7436': market(
    '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
    'NVDAB',
    '0x310EFC9Fefe89B8085F89E91Ac782Bef6416499E',
  ),
  '0x5b1910eaad6450e50f816082aa078c41f10c292f': market(
    '0x5b1910eaad6450e50f816082aa078c41f10c292f',
    'TSLAB',
    '0xe1bc21701Bc8FFa39DaecDb8f58263C1d5e1c0bc',
  ),
  '0x0ca5d51d0277bd006fd9607d3e560785ebad8222': market(
    '0x0ca5d51d0277bd006fd9607d3e560785ebad8222',
    'PLTRB',
    '0xBb0535d8C1B1adB790beD2d9b84d4Dbc78fdD902',
  ),
};

/** Every bStocks market, in whitelist order (research §1). */
export const BSTOCK_MARKETS: readonly BstockMarket[] = Object.values(MARKET_BY_ADDRESS);

/* ------------------------------------------------------------------ *
 * US market hours (§56)
 * ------------------------------------------------------------------ */

/** Static holiday table — a KNOWN LIMITATION: it must be extended by the operator each year. */
export interface MarketHolidayCalendar {
  /** Full closures, `YYYY-MM-DD` in US/Eastern. */
  readonly holidays: readonly string[];
  /** 13:00 ET early closes, `YYYY-MM-DD` in US/Eastern. */
  readonly earlyCloses: readonly string[];
}

/**
 * NYSE full closures + early closes for 2026–2027 (source: `nyse.com/trade/hours-calendars`).
 * This is deliberate: guessing dates would be worse than not covering them, so the calendar is a
 * reviewable, overridable constant instead of generated rules (Good Friday / observed-shift rules
 * are easy to get subtly wrong).
 */
export const NYSE_HOLIDAY_CALENDAR: MarketHolidayCalendar = {
  holidays: [
    // 2026
    '2026-01-01', // New Year's Day
    '2026-01-19', // Martin Luther King Jr. Day
    '2026-02-16', // Washington's Birthday
    '2026-04-03', // Good Friday
    '2026-05-25', // Memorial Day
    '2026-06-19', // Juneteenth
    '2026-07-03', // Independence Day observed
    '2026-09-07', // Labor Day
    '2026-11-26', // Thanksgiving Day
    '2026-12-25', // Christmas Day
    // 2027
    '2027-01-01', // New Year's Day
    '2027-01-18', // Martin Luther King Jr. Day
    '2027-02-15', // Washington's Birthday
    '2027-03-26', // Good Friday
    '2027-05-31', // Memorial Day
    '2027-06-18', // Juneteenth observed
    '2027-07-05', // Independence Day observed
    '2027-09-06', // Labor Day
    '2027-11-25', // Thanksgiving Day
    '2027-12-24', // Christmas Day observed
  ],
  earlyCloses: [
    '2026-11-27', // day after Thanksgiving
    '2026-12-24', // Christmas Eve
    '2027-11-26', // day after Thanksgiving
  ],
};

const EASTERN = 'America/New_York';
/** Regular session opens 09:30 ET (§56); the core session ends 16:00 ET. */
const SESSION_OPEN_MINUTES = 9 * 60 + 30;
const SESSION_CLOSE_MINUTES = 16 * 60;
/** NYSE early-close days end the session at 13:00 ET. */
const EARLY_CLOSE_MINUTES = 13 * 60;

const EASTERN_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Civil time in US/Eastern — the only basis for §56 market hours (DST handled by the tz db). */
export interface EasternClock {
  /** `YYYY-MM-DD` in US/Eastern. */
  readonly date: string;
  /** 0 = Sunday .. 6 = Saturday. */
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
  /** Minutes since local midnight. */
  readonly minutesOfDay: number;
}

/** Reads the US/Eastern wall clock, or `null` when the runtime lacks the tz database. */
export function readEasternClock(at: Date): EasternClock | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = EASTERN_CLOCK.formatToParts(at);
  } catch {
    return null;
  }
  const pick = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((part) => part.type === type)?.value;
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  const hour = pick('hour');
  const minute = pick('minute');
  const weekday = pick('weekday');
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    weekday === undefined
  ) {
    return null;
  }
  const weekdayIndex = WEEKDAY_INDEX[weekday];
  if (weekdayIndex === undefined) return null;
  const hourValue = Number(hour);
  const minuteValue = Number(minute);
  if (!Number.isInteger(hourValue) || !Number.isInteger(minuteValue)) return null;
  const clock: EasternClock = {
    date: `${year}-${month}-${day}`,
    weekday: weekdayIndex,
    hour: hourValue,
    minute: minuteValue,
    minutesOfDay: hourValue * 60 + minuteValue,
  };
  return clock;
}

/** Pure §56 classification. Note: the frozen contract has no `pre`/`after` state — extended-hours
 * trading is reported as `closed`, because it is NOT the regular session the reference NAV tracks. */
export function classifyMarketStatus(
  at: Date,
  calendar: MarketHolidayCalendar = NYSE_HOLIDAY_CALENDAR,
): MarketStatus {
  const clock = readEasternClock(at);
  if (clock === null) return MARKET_STATUSES.UNKNOWN;
  const { date, weekday } = clock;
  if (weekday === 0 || weekday === 6) return MARKET_STATUSES.WEEKEND;
  if (calendar.holidays.includes(date)) return MARKET_STATUSES.HOLIDAY;
  const minutesOfDay = clock.hour * 60 + clock.minute;
  const closeMinutes = calendar.earlyCloses.includes(date)
    ? EARLY_CLOSE_MINUTES
    : SESSION_CLOSE_MINUTES;
  return minutesOfDay >= SESSION_OPEN_MINUTES && minutesOfDay < closeMinutes
    ? MARKET_STATUSES.OPEN
    : MARKET_STATUSES.CLOSED;
}

/* ------------------------------------------------------------------ *
 * Oracle normalisation
 * ------------------------------------------------------------------ */

/** Minimal `latestRoundData()` projection an on-chain reader must supply. */
export interface OracleRoundData {
  readonly answer: bigint;
  /** `decimals()` of THAT feed — 8 for Chainlink equity feeds, 18 for USDC/USD-style feeds. */
  readonly decimals: number;
  /** `updatedAt` of the round (Unix seconds). */
  readonly updatedAt: UnixSeconds;
}

/**
 * Narrow on-chain read port. `ChainAdapter`/`ChainLayer` supplies the implementation; this slice
 * never owns an RPC client. Absent ⇒ the `oracle` rung is simply not in the ladder.
 */
export interface OnchainFeedReader {
  /** `null` when the feed does not exist / reverts. Must not throw for a missing feed. */
  readLatestRoundData(feedAddress: Address): Promise<OracleRoundData | null>;
}

/**
 * Chainlink/APRO `latestRoundData()` answer → `PriceUsd` (USD per whole token).
 * NEVER hardcodes 8 or 18: the divisor comes from the feed's own `decimals()`.
 */
export function normalizeOracleAnswer(answer: bigint, decimals: number): PriceUsd | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  return toPriceUsd(Number(answer) / 10 ** decimals);
}

/** Last step of every normalisation: a price is only usable when finite and strictly positive. */
export function toPriceUsd(raw: number): PriceUsd | null {
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * Binance prices arrive as decimal strings, and `"-1"` is the official "no print yet" placeholder
 * (measured 2026-09-29 on `/fapi/v1/constituents`). Anything non-finite or `<= 0` is invalid.
 */
export function parseBinancePrice(raw: unknown): PriceUsd | null {
  if (typeof raw === 'number') return toPriceUsd(raw);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  // `Number('')`/`Number(' ')` are 0 and `Number('abc')` is NaN — both are rejected above/below.
  if (!Number.isFinite(value)) return null;
  return toPriceUsd(value);
}

/**
 * Weighted mean of the official index constituents.
 *
 * Returns `null` when ANY constituent lacks a valid price: the published weights are the official
 * index construction and do not renormalise, so averaging a subset would silently misstate the
 * index. A degraded index is discarded whole and the ladder falls through (§96 fail closed).
 */
export function weightedIndexPrice(
  constituents: readonly { readonly price: unknown; readonly weight: unknown }[],
): PriceUsd | null {
  if (constituents.length === 0) return null;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const constituent of constituents) {
    const price = parseBinancePrice(constituent.price);
    const weight = parseBinancePrice(constituent.weight);
    if (price === null || weight === null) return null;
    weightedSum += price * weight;
    weightTotal += weight;
  }
  if (!(weightTotal > 0)) return null;
  return toPriceUsd(weightedSum / weightTotal);
}

/* ------------------------------------------------------------------ *
 * Hard-exit reference policy (§57)
 * ------------------------------------------------------------------ */

export interface HardExitReferenceVerdict {
  readonly usable: boolean;
  readonly reason: string;
}

/**
 * §57 — may a depeg verdict trigger a HARD exit?
 *
 * Only when the regular US session is `open` AND a trustworthy reference exists. On
 * `closed`/`weekend`/`holiday`/`unknown` the reference is a frozen or indefinite value, so V1
 * degrades to alert-only (`Disable Hard Depeg Exit`) unless an explicit alternative reference
 * (§57: related futures / indicative price / issuer quote / market maker price) is supplied.
 * Callers must pass that alternative explicitly — absence is the safe default, never an assumption.
 */
export function hardExitReferenceUsable(args: {
  readonly marketStatus: MarketStatus;
  readonly reference: Sourced<PriceUsd | null>;
  readonly alternativeReference?: Sourced<PriceUsd | null>;
}): HardExitReferenceVerdict {
  const { marketStatus, reference } = args;
  if (marketStatus === MARKET_STATUSES.OPEN) {
    if (reference.value === null || reference.stale) {
      return {
        usable: false,
        reason: `market open but reference unusable (source=${reference.source}, stale=${String(reference.stale)})`,
      };
    }
    return { usable: true, reason: `market open, fresh reference from ${reference.source}` };
  }
  const alternative = args.alternativeReference;
  if (alternative !== undefined && alternative.value !== null && !alternative.stale) {
    return {
      usable: true,
      reason: `market ${marketStatus}; §57 alternative reference pricing from ${alternative.source}`,
    };
  }
  return {
    usable: false,
    reason: `market ${marketStatus}; §57 alert-only (no reliable alternative reference)`,
  };
}

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

/** Which endpoint family a rung talks to (overridable for tests / regional mirrors). */
export interface BinanceEndpoints {
  readonly fapi: string;
  readonly spot: string;
}

export const DEFAULT_BINANCE_ENDPOINTS: BinanceEndpoints = {
  fapi: 'https://fapi.binance.com',
  spot: 'https://api.binance.com',
};

export interface ReferencePriceProviderOptions {
  readonly chainId?: ChainId;
  /** Used to cross-check the address→ticker table against the whitelist (fail closed on mismatch). */
  readonly registry?: TokenRegistry;
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Injectable clock — market hours and staleness must be deterministic under test. */
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  /** Freshness budget while the US session is open. */
  readonly maxAgeSeconds?: number;
  /** Freshness budget while closed: the index is SUPPOSED to freeze, so the budget is a session gap. */
  readonly maxAgeSecondsClosed?: number;
  readonly endpoints?: BinanceEndpoints;
  readonly holidayCalendar?: MarketHolidayCalendar;
  /** Optional on-chain APRO rung. Without it the ladder is HTTP-only. */
  readonly oracle?: OnchainFeedReader;
}

/** Per-rung outcome, kept for logging/audit (§100 — never a silent degradation). */
export interface SourceAttempt {
  readonly source: DataSource;
  readonly ok: boolean;
  readonly detail: string;
}

const DEFAULTS = {
  timeoutMs: 5_000,
  maxAgeSeconds: 120,
  /** Longest US closure is a 3-day weekend plus an observed holiday ⇒ 4 days of slack. */
  maxAgeSecondsClosed: 4 * 24 * 60 * 60,
} as const;

interface Candidate {
  readonly value: PriceUsd;
  readonly asOf: IsoTimestamp;
  readonly source: DataSource;
  readonly stale: boolean;
}

/**
 * §84 implementation over Binance bStocks index → Binance spot → optional on-chain APRO feed.
 *
 * Every externally-sourced value leaves this class as `Sourced<PriceUsd|null>`; failures are
 * reported as `DATA_SOURCES.UNAVAILABLE` with `stale: true` and `value: null` so consumers fail
 * closed instead of acting on a guess (§96).
 */
export class BinanceReferencePriceProvider implements ReferencePriceProvider {
  private readonly chainId: ChainId;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly maxAgeSeconds: number;
  private readonly maxAgeSecondsClosed: number;
  private readonly endpoints: BinanceEndpoints;
  private readonly calendar: MarketHolidayCalendar;
  private readonly oracle: OnchainFeedReader | null;
  private readonly attempts: SourceAttempt[] = [];

  constructor(options: ReferencePriceProviderOptions = {}) {
    this.chainId = options.chainId ?? BSC_CHAIN_ID;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? ((): Date => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.maxAgeSeconds = options.maxAgeSeconds ?? DEFAULTS.maxAgeSeconds;
    this.maxAgeSecondsClosed = options.maxAgeSecondsClosed ?? DEFAULTS.maxAgeSecondsClosed;
    this.endpoints = options.endpoints ?? DEFAULT_BINANCE_ENDPOINTS;
    this.calendar = options.holidayCalendar ?? NYSE_HOLIDAY_CALENDAR;
    this.oracle = options.oracle ?? null;
    if (options.registry !== undefined) this.assertTickerTableMatchesWhitelist(options.registry);
  }

  /**
   * The address→ticker table is a static fact, so a drift between it and the whitelist would price
   * the wrong instrument. Any mismatch aborts at construction (fail closed at startup, not at trade).
   */
  private assertTickerTableMatchesWhitelist(registry: TokenRegistry): void {
    for (const entry of BSTOCK_MARKETS) {
      const token = registry.getTokenByAddress(this.chainId, entry.address);
      if (token === null) continue;
      if (entry.ticker.toUpperCase() !== `${token.symbol.toUpperCase()}USDT`) {
        throw new WhitelistError(
          `bStocks ticker table says ${entry.address} is ${entry.ticker} but the whitelist ` +
            `reports symbol ${token.symbol}; refusing to price the wrong instrument`,
          { chainId: this.chainId, address: entry.address },
        );
      }
    }
  }

  /** Rungs attempted by the most recent call, in order — for the decision log. */
  getLastAttempts(): readonly SourceAttempt[] {
    return [...this.attempts];
  }

  async getStockReferencePrice(tokenAddress: Address): Promise<Sourced<PriceUsd | null>> {
    // §3 priority ladder: official index → continuous spot → on-chain APRO feed.
    return this.best(
      (market) => [
        () => this.indexCandidate(market),
        () => this.spotCandidate(market),
        () => this.oracleCandidate(market),
      ],
      tokenAddress,
    );
  }

  /**
   * §57 indicative price: the continuous 24/7 bStock quote (may carry a premium/discount vs the
   * underlying NAV), falling back to the official index.
   */
  async getIndicativePrice(tokenAddress: Address): Promise<Sourced<PriceUsd | null>> {
    return this.best(
      (market) => [() => this.spotCandidate(market), () => this.indexCandidate(market)],
      tokenAddress,
    );
  }

  /**
   * Most recent close. The Binance bStocks index officially freezes at the last valid close after
   * the US session, so it is reused first; the fallback is the close of the last COMPLETED daily
   * candle on Binance spot.
   *
   * KNOWN LIMITATION: that candle closes at 00:00 UTC, not at the 16:00 ET US close, so during the
   * US session it lags the true session close. Both rungs label themselves via `source`/`asOf`
   * precisely so this approximation stays visible.
   */
  async getLatestClose(tokenAddress: Address): Promise<Sourced<PriceUsd | null>> {
    return this.best(
      (market) => [() => this.indexCandidate(market), () => this.dailyCloseCandidate(market)],
      tokenAddress,
    );
  }

  /**
   * §56 market status. `unknown` when the runtime cannot resolve US/Eastern (no tz database), which
   * also blocks a hard exit — the only safe reading of an unclassifiable session.
   */
  async getMarketStatus(): Promise<MarketStatus> {
    return classifyMarketStatus(this.now(), this.calendar);
  }

  /**
   * One call for the §55/§57 consumers: the status, the reference and the resulting hard-exit
   * verdict. V1 passes no alternative reference, so closed markets are alert-only.
   */
  async getHardExitReference(tokenAddress: Address): Promise<{
    readonly marketStatus: MarketStatus;
    readonly reference: Sourced<PriceUsd | null>;
    readonly verdict: HardExitReferenceVerdict;
  }> {
    const [marketStatus, reference] = await Promise.all([
      this.getMarketStatus(),
      this.getStockReferencePrice(tokenAddress),
    ]);
    return { marketStatus, reference, verdict: hardExitReferenceUsable({ marketStatus, reference }) };
  }

  /* ------------------------------ ladder ------------------------------ */

  private async best(
    rungs: (market: BstockMarket) => readonly (() => Promise<Candidate | null>)[],
    tokenAddress: Address,
  ): Promise<Sourced<PriceUsd | null>> {
    this.attempts.length = 0;
    const nowIso = this.now().toISOString();
    const market = MARKET_BY_ADDRESS[tokenAddress.toLowerCase() as Address];
    if (market === undefined) {
      this.attempts.push({
        source: DATA_SOURCES.UNAVAILABLE,
        ok: false,
        detail: `${tokenAddress} is not a known bStocks market`,
      });
      return { value: null, source: DATA_SOURCES.UNAVAILABLE, asOf: nowIso, stale: true };
    }
    let degraded: Candidate | null = null;
    for (const rung of rungs(market)) {
      const candidate = await rung();
      if (candidate === null) continue;
      if (!candidate.stale) {
        return {
          value: candidate.value,
          source: candidate.source,
          asOf: candidate.asOf,
          stale: candidate.stale,
        };
      }
      degraded ??= candidate;
    }
    if (degraded !== null) {
      return {
        value: degraded.value,
        source: degraded.source,
        asOf: degraded.asOf,
        stale: degraded.stale,
      };
    }
    return { value: null, source: DATA_SOURCES.UNAVAILABLE, asOf: nowIso, stale: true };
  }

  private record(source: DataSource, ok: boolean, detail: string): void {
    this.attempts.push({ source, ok, detail });
  }

  /* ------------------------------ rungs ------------------------------ */

  /** Rung 1: official bStocks index (weighted constituent mean). */
  private async indexCandidate(market: BstockMarket): Promise<Candidate | null> {
    const url = `${this.endpoints.fapi}/fapi/v1/constituents?symbol=${encodeURIComponent(market.ticker)}`;
    const response = await this.httpJson<{
      readonly symbol?: unknown;
      readonly time?: unknown;
      readonly constituents?: unknown;
    }>(url);
    if (!response.ok) {
      this.record(DATA_SOURCES.BINANCE_INDEX, false, response.detail);
      return null;
    }
    const body = response.body;
    if (typeof body.symbol !== 'string' || !Array.isArray(body.constituents)) {
      this.record(DATA_SOURCES.BINANCE_INDEX, false, 'malformed constituents payload');
      return null;
    }
    const constituents = body.constituents.filter(
      (entry): entry is { price: unknown; weight: unknown } =>
        typeof entry === 'object' && entry !== null,
    );
    const price = weightedIndexPrice(constituents);
    if (price === null) {
      // The measured 2026-09-29 condition: endpoint up, every constituent `price` is the "-1" placeholder.
      this.record(
        DATA_SOURCES.BINANCE_INDEX,
        false,
        `no valid constituent price (${constituents.length} constituents, "${String(
          (constituents[0] as { price?: unknown } | undefined)?.price,
        )}" placeholder ⇒ invalid)`,
      );
      return null;
    }
    const asOf = this.isoFromMillis(body.time) ?? response.date ?? this.now().toISOString();
    const stale = this.isStale(asOf);
    this.record(DATA_SOURCES.BINANCE_INDEX, true, `index ${price} asOf ${asOf} stale=${String(stale)}`);
    return { value: price, asOf, source: DATA_SOURCES.BINANCE_INDEX, stale };
  }

  /** Rung 2: Binance spot ticker (continuous, indicative). */
  private async spotCandidate(market: BstockMarket): Promise<Candidate | null> {
    const url = `${this.endpoints.spot}/api/v3/ticker/price?symbol=${encodeURIComponent(market.ticker)}`;
    const response = await this.httpJson<{ readonly symbol?: unknown; readonly price?: unknown }>(url);
    if (!response.ok) {
      this.record(DATA_SOURCES.BINANCE_SPOT, false, response.detail);
      return null;
    }
    const body = response.body;
    // A Binance error body (`{"code":-1121,"msg":"Invalid symbol."}`) has no `price` field.
    if (typeof body.symbol !== 'string') {
      this.record(DATA_SOURCES.BINANCE_SPOT, false, 'malformed ticker payload');
      return null;
    }
    const price = parseBinancePrice(body.price);
    if (price === null) {
      this.record(
        DATA_SOURCES.BINANCE_SPOT,
        false,
        `invalid price ${JSON.stringify(body.price)} (placeholder/<=0 ⇒ invalid)`,
      );
      return null;
    }
    // `/ticker/price` carries no payload timestamp; the HTTP `Date` header is the best asOf.
    const asOf = response.date ?? this.now().toISOString();
    const stale = this.isStale(asOf);
    this.record(DATA_SOURCES.BINANCE_SPOT, true, `spot ${price} asOf ${asOf} stale=${String(stale)}`);
    return { value: price, asOf, source: DATA_SOURCES.BINANCE_SPOT, stale };
  }

  /** Fallback close: close of the last COMPLETED 1d candle. */
  private async dailyCloseCandidate(market: BstockMarket): Promise<Candidate | null> {
    const url =
      `${this.endpoints.spot}/api/v3/klines?symbol=${encodeURIComponent(market.ticker)}` +
      `&interval=1d&limit=2`;
    const response = await this.httpJson<unknown>(url);
    if (!response.ok) {
      this.record(DATA_SOURCES.BINANCE_SPOT, false, response.detail);
      return null;
    }
    if (!Array.isArray(response.body)) {
      this.record(DATA_SOURCES.BINANCE_SPOT, false, 'malformed klines payload');
      return null;
    }
    const nowMs = this.now().getTime();
    for (const row of [...response.body].reverse()) {
      if (!Array.isArray(row)) continue;
      const closeTime = Number(row[6]);
      const close = parseBinancePrice(row[4]);
      if (!Number.isFinite(closeTime) || closeTime >= nowMs || close === null) continue;
      const asOf = new Date(closeTime).toISOString();
      const stale = this.isStale(asOf);
      this.record(
        DATA_SOURCES.BINANCE_SPOT,
        true,
        `daily close ${close} asOf ${asOf} stale=${String(stale)} (UTC candle boundary, not the 16:00 ET close)`,
      );
      return { value: close, asOf, source: DATA_SOURCES.BINANCE_SPOT, stale };
    }
    this.record(DATA_SOURCES.BINANCE_SPOT, false, 'no completed daily candle');
    return null;
  }

  /** Rung 3: on-chain APRO feed (only present for the 6 bStocks in research §3). */
  private async oracleCandidate(market: BstockMarket): Promise<Candidate | null> {
    if (this.oracle === null) return null;
    const feedAddress = market.aproFeed;
    if (feedAddress === undefined) {
      this.record(DATA_SOURCES.ORACLE, false, `no APRO feed for ${market.ticker}`);
      return null;
    }
    let round: OracleRoundData | null;
    try {
      round = await this.oracle.readLatestRoundData(feedAddress);
    } catch (error) {
      this.record(DATA_SOURCES.ORACLE, false, error instanceof Error ? error.message : String(error));
      return null;
    }
    if (round === null) {
      this.record(DATA_SOURCES.ORACLE, false, `feed ${feedAddress} unavailable`);
      return null;
    }
    const price = normalizeOracleAnswer(round.answer, round.decimals);
    if (price === null) {
      this.record(
        DATA_SOURCES.ORACLE,
        false,
        `invalid answer ${String(round.answer)} @ ${round.decimals}dp (placeholder/<=0 ⇒ invalid)`,
      );
      return null;
    }
    const asOf = new Date(round.updatedAt * 1000).toISOString();
    const stale = this.isStale(asOf);
    this.record(
      DATA_SOURCES.ORACLE,
      true,
      `oracle ${price} (${String(round.answer)}/${String(round.decimals)}dp) asOf ${asOf} stale=${String(stale)}`,
    );
    return { value: price, asOf, source: DATA_SOURCES.ORACLE, stale };
  }

  /* ------------------------------ helpers ------------------------------ */

  /**
   * Staleness budget depends on the session (§56/§57): the index is DESIGNED to freeze after the
   * close, so an age-based check with the open-market budget would flag every legitimate close.
   */
  private isStale(asOf: IsoTimestamp): boolean {
    const asOfMs = Date.parse(asOf);
    if (!Number.isFinite(asOfMs)) return true;
    const nowMs = this.now().getTime();
    const ageSeconds = (nowMs - asOfMs) / 1000;
    const status = classifyMarketStatus(this.now(), this.calendar);
    const budget =
      status === MARKET_STATUSES.OPEN ? this.maxAgeSeconds : this.maxAgeSecondsClosed;
    return ageSeconds > budget;
  }

  private isoFromMillis(value: unknown): IsoTimestamp | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    return new Date(value).toISOString();
  }

  private async httpJson<T>(
    url: string,
  ): Promise<
    { readonly ok: true; readonly body: T; readonly date: IsoTimestamp | null }
    | { readonly ok: false; readonly detail: string }
  > {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      return { ok: false, detail: `${url} failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!response.ok) {
      return { ok: false, detail: `${url} HTTP ${String(response.status)}` };
    }
    let body: T;
    try {
      body = (await response.json()) as T;
    } catch (error) {
      return { ok: false, detail: `${url} returned non-JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
    const header = response.headers?.get('date') ?? null;
    const parsed = header === null ? Number.NaN : Date.parse(header);
    return {
      ok: true,
      body,
      date: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null,
    };
  }
}

/** Convenience factory; the composition root wires the registry + optional oracle reader. */
export function createReferencePriceProvider(
  options: ReferencePriceProviderOptions = {},
): BinanceReferencePriceProvider {
  return new BinanceReferencePriceProvider(options);
}
