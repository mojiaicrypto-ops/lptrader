/**
 * Integer→decimal helpers shared by the strategy layer.
 *
 * These exist because every economic figure downstream is a `number` (USD, ratios) while every
 * on-chain amount is a `bigint` with `decimals` metadata (§primitives UNITAGREEMENT). Converting
 * via `Number(amount) / 10 ** decimals` overflows `Number` precision for anything above ~2^53 wei
 * — which is every realistic token balance — so the conversion goes through the decimal string.
 */

/**
 * RAW bigint amount → float in whole (UI) tokens.
 *
 * `decimals` is taken from the token metadata (`TokenMeta.decimals`), never assumed: BSC USDC/USDT
 * are 18, not the 6 used on other chains (research §1).
 */
export function toFloat(amount: bigint, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`unusable decimals: ${String(decimals)}`);
  }
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const digits = abs.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  const value = Number(`${whole}.${fraction}`);
  return negative ? -value : value;
}

/**
 * Float whole tokens → RAW bigint, truncating toward zero.
 *
 * Truncation (not rounding) is deliberate: this direction feeds approvals and `amountMin` bounds,
 * where rounding UP would ask for more than the caller authorised. Use `roundUp` only for
 * `amountMin`/`amountOutMinimum` when the caller has explicitly chosen that direction.
 */
export function fromFloat(value: number, decimals: number, roundUp = false): bigint {
  if (!Number.isFinite(value)) throw new Error(`unusable amount: ${String(value)}`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`unusable decimals: ${String(decimals)}`);
  }
  const factor = 10n ** BigInt(decimals);
  const scaled = value * 10 ** decimals;
  const truncated = BigInt(roundUp ? Math.ceil(scaled) : Math.trunc(scaled));
  // Guard the float path: if the scaling lost precision, fall back to the exact decimal string.
  if (!Number.isFinite(scaled)) {
    const [whole = '0', fraction = ''] = value.toFixed(decimals).split('.');
    return BigInt(whole) * factor + BigInt(fraction.padEnd(decimals, '0') || '0');
  }
  return truncated;
}

/**
 * `floor(amount * (1 - tolerance))` in integer maths.
 *
 * BigInt so the rounding direction is explicit rather than a float artefact: the result is a
 * minimum-output bound that will be signed, and one wei too high is a revert.
 */
export function applyFloorRatio(amount: bigint, keepRatio: number): bigint {
  if (!Number.isFinite(keepRatio) || keepRatio < 0 || keepRatio > 1) {
    throw new Error(`ratio out of range: ${String(keepRatio)}`);
  }
  const SCALE = 1_000_000_000n; // 1e9 — exact for the 0.003 / 0.3% class of tolerances
  const scaled = BigInt(Math.round(keepRatio * Number(SCALE)));
  return (amount * scaled) / SCALE;
}
