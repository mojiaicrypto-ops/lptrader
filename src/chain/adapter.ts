/**
 * §81 `ChainAdapter` — the only component in this project allowed to talk to an RPC.
 *
 * Design decisions worth knowing before reading the implementation:
 *
 * - **Reads go through `RpcPool`** (§99), so every critical value is either cross-checked between
 *   two endpoints or explicitly flagged `degraded`. Nothing here reads from a raw `PublicClient`
 *   behind the pool's back.
 * - **Units.** Everything this class returns is RAW: `getTokenBalance` returns the ERC-20 base unit
 *   and never a UI-scaled bStock amount. UI conversion (`uiMultiplier`) lives in
 *   `src/chain/tokenReader.ts`, so a caller physically cannot sign a UI amount by accident.
 * - **Writes.** `sendTransaction` is the only write path. It runs the §95 guard first (refusing on
 *   any failed check), requires an attached signer, and records a §98 lifecycle. A transaction whose
 *   state cannot be resolved is reported as `UNKNOWN` with a reason — it is never re-sent.
 * - **No secrets.** The adapter receives an already-constructed viem `Account`/`WalletClient`. It
 *   never accepts, stores, derives or logs a private key, and no key material can reach its errors.
 */
import {
  TransactionReceiptNotFoundError,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  type Account,
  type PublicClient,
  type WalletClient,
} from 'viem';
import type {
  ChainAdapter,
  ChainWriteRequest,
  TokenBalance,
  TransactionInfo,
} from '../types/adapters.ts';
import { TX_STATES, type TxState } from '../types/adapters.ts';
import type { Address, ChainId, Hash, Hex } from '../types/primitives.ts';
import type { DexId } from '../types/primitives.ts';
import type { Whitelist } from '../types/registry.ts';
import { BSC_DEX_CONTRACTS, type DexContracts } from '../config/builtins.ts';
import { CLMM_FACTORY_ABI, ERC20_ABI, MULTICALL3_AGGREGATE3_ABI } from './abis.ts';
import {
  ChainError,
  CHAIN_ERROR_CODES,
  RpcNodeError,
  TxStateUnknownError,
} from './errors.ts';
import {
  CHAIN_DEFINITIONS,
  MULTICALL3_ADDRESS,
  RpcPool,
  type RpcEndpointOptions,
  type RpcProvenance,
  type RpcReadResult,
} from './rpc.ts';
import {
  assertTxGuard,
  initialTxLifecycle,
  interpretTransaction,
  type TxLifecycle,
} from './txState.ts';

export interface ChainAdapterOptions {
  readonly chainId: ChainId;
  /** §11/§12/§8 source of truth for every whitelist check performed here. */
  readonly whitelist: Whitelist;
  /** RPC endpoints + cross-check policy (§99). */
  readonly rpc?: RpcEndpointOptions;
  /** viem account injected by the caller (e.g. `privateKeyToAccount`). Never a raw key string. */
  readonly account?: Account;
  /** Pre-built wallet client; takes precedence over `account` when both are supplied. */
  readonly walletClient?: WalletClient;
  /** Confirmations required before `CONFIRMED`. Defaults to 1 (mined and canonical enough to act on). */
  readonly confirmations?: number;
  /**
   * Cross-check balances/nonces between endpoints (§99). Defaults to `true`; only a single-endpoint
   * setup or a deliberate throughput trade-off should disable it.
   */
  readonly crossCheck?: boolean;
  /** When true, `sendTransaction` still runs the guard but stops before broadcasting. */
  readonly dryRun?: boolean;
}

/** A `getTokenBalances` result plus the provenance of the batch that produced it. */
export interface TokenBalancesResult {
  readonly balances: readonly TokenBalance[];
  readonly provenance: RpcProvenance;
}

/**
 * §81 adapter over one BSC-family chain.
 *
 * Multi-RPC and cross-check semantics live in `RpcPool`; this class adds the whitelist gate, the
 * unit rules and the write path.
 */
export class BscChainAdapter implements ChainAdapter {
  readonly chainId: ChainId;
  readonly nativeCurrencyDecimals = 18;

  private readonly whitelist: Whitelist;
  private readonly rpc: RpcPool;
  private readonly walletClient: WalletClient | null;
  private readonly signerAddress: Address | null;
  private readonly confirmations: number;
  private readonly crossCheckEnabled: boolean;
  private readonly dryRun: boolean;
  /** §98 lifecycle per broadcast hash; kept so an operator can see how many times an intent was sent. */
  private readonly lifecycles: Record<string, TxLifecycle> = {};

  constructor(options: ChainAdapterOptions) {
    // §11: a non-whitelisted chain must fail at construction, not on the first write.
    options.whitelist.assertWhitelistedChain(options.chainId);
    this.chainId = options.chainId;
    this.whitelist = options.whitelist;
    this.rpc = new RpcPool(options.chainId, options.rpc ?? {});
    this.confirmations = options.confirmations ?? 1;
    this.crossCheckEnabled = options.crossCheck ?? true;
    this.dryRun = options.dryRun ?? false;

    if (options.walletClient !== undefined) {
      this.walletClient = options.walletClient;
    } else if (options.account !== undefined) {
      // The write path must use the same endpoint ordering as the read path, so the wallet client
      // is built on the pool's primary transport rather than viem's default public RPC.
      this.walletClient = createWalletClient({
        account: options.account,
        chain: CHAIN_DEFINITIONS[options.chainId as keyof typeof CHAIN_DEFINITIONS],
        transport: this.rpc.primaryTransport,
      }) as WalletClient;
    } else {
      this.walletClient = null;
    }
    const account = this.walletClient?.account;
    this.signerAddress = account === undefined ? null : getAddress(account.address);
  }

  /** Exposed for diagnostics/scripts only; callers must not read chain state through it. */
  get rpcPool(): RpcPool {
    return this.rpc;
  }

  assertWhitelistedChain(): void {
    this.whitelist.assertWhitelistedChain(this.chainId);
  }

  /** §12 DEX whitelist check, exposed so the readers can gate their contract addresses. */
  assertWhitelistedDex(dex: DexId): void {
    this.whitelist.assertWhitelistedDex(this.chainId, dex);
  }

  /**
   * Independently verify a write target (§95, §8, §12, §91).
   *
   * The target must be one of the contracts this system is allowed to touch on this chain: a
   * whitelisted DEX's deployed contracts, or Multicall3. §91 forbids "Approve Unknown Contract" and
   * "Interact With Unknown DEX", and §95 requires the contract address to be verified before every
   * transaction — so it is enforced here rather than left to the guard's self-reported
   * `toWhitelisted`, which `assertTxGuard` cannot verify (measured: a forged all-true guard aimed at
   * the known impostor address `0xb904108b…` passes `assertTxGuard`).
   *
   * ## Why there is no selector check here
   * An earlier version also required the calldata selector to appear in `KNOWN_SELECTORS`, and that was
   * wrong on two counts. It blocked legitimate calls — the DEX adapters use `exactInputSingle`,
   * `multicall(bytes32,bytes[])`, `mint`, `pull`, `approveZeroThenMax` and more, none of which belong in
   * a chain-layer list (it failed 6 adapter tests) — and it duplicated an ownership boundary: the
   * selector surface is defined by each adapter's ABIs, and those are encoded through viem's typed
   * `encodeFunctionData`, so the selector is derived from a reviewed ABI rather than typed by hand.
   * Copying that surface into the chain layer would create exactly the drift this project keeps
   * guarding against. The guard's `functionSelectorOk` therefore stays the caller's responsibility, and
   * the caller is the adapter that owns the ABI.
   */
  private assertWhitelistedWriteTarget(to: Address): void {
    const allowed = new Set<string>([MULTICALL3_ADDRESS.toLowerCase()]);
    for (const contracts of Object.values(BSC_DEX_CONTRACTS)) {
      for (const address of Object.values(contracts)) {
        if (typeof address === 'string') allowed.add(address.toLowerCase());
      }
    }
    if (!allowed.has(to.toLowerCase())) {
      throw new ChainError(
        CHAIN_ERROR_CODES.ADDRESS_NOT_WHITELISTED,
        `write target ${to} is not a whitelisted contract on chain ${this.chainId} (§8/§12/§91): ` +
          'refusing to send, regardless of what the caller-reported guard claims',
        { chainId: this.chainId, address: to },
      );
    }
  }

  /**
   * §8: an address must be whitelisted before any call to it is made. Returns the canonical
   * lowercased address so identity comparisons downstream cannot diverge from the registry's.
   */
  private requireWhitelistedToken(tokenAddress: Address) {
    const token = this.whitelist.registry.getTokenByAddress(this.chainId, tokenAddress);
    if (token === null) {
      throw new ChainError(
        CHAIN_ERROR_CODES.ADDRESS_NOT_WHITELISTED,
        `token ${tokenAddress} is not whitelisted on chain ${this.chainId} (§8); refusing to read it`,
        { chainId: this.chainId, address: tokenAddress },
      );
    }
    return token;
  }

  /**
   * Cross-checked (or single-endpoint) read.
   *
   * `operation` receives the block height the cross-check pinned and MUST pass it to the RPC call.
   * Without it a cross-check compares two different blocks: `slot0`/balances/fee-growth are all
   * block-mutable, so exact equality would fail on every live read (measured — see
   * `RpcPool.crossCheck`). For a single-endpoint read the height is `undefined` ("latest"), because
   * there is no second observation to agree with.
   */
  private async read<T>(
    operation: (client: PublicClient, blockNumber: bigint | undefined) => Promise<T>,
    method: string,
    crossCheck: boolean,
  ): Promise<RpcReadResult<T>> {
    if (crossCheck && this.crossCheckEnabled) {
      return this.rpc.crossCheck(operation, method);
    }
    // A single-endpoint read has nothing to compare against, so no height is pinned and `undefined`
    // means the node's own head ("latest"). That is the correct semantic for a non-cross-checked read:
    // there is no second observation it would have to agree with.
    return this.rpc.call((client) => operation(client, undefined), method);
  }

  async getBlockNumber(): Promise<bigint> {
    // The head moves between two nodes by design, so this read is never cross-checked.
    const result = await this.rpc.call((client) => client.getBlockNumber(), 'eth_blockNumber');
    return result.value;
  }

  /** RAW ERC-20 balance. UI scaling for bStocks happens in `tokenReader.ts`, never here. */
  async getTokenBalance(tokenAddress: Address): Promise<bigint> {
    const signer = this.signerAddress;
    if (signer === null) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        'getTokenBalance has no attached signer; use getTokenBalanceOf(tokenAddress, holder) instead',
        { tokenAddress },
      );
    }
    return this.getTokenBalanceOf(tokenAddress, signer);
  }

  /** RAW ERC-20 balance of `holder` (the signer-independent form used by portfolio reads). */
  async getTokenBalanceOf(tokenAddress: Address, holder: Address): Promise<bigint> {
    const token = this.requireWhitelistedToken(tokenAddress);
    const result = await this.read(
      async (client, blockNumber) =>
        (await client.readContract({
          address: token.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [holder],
          blockNumber,
        })) as bigint,
      'balanceOf',
      true,
    );
    return result.value;
  }

  async getNativeBalance(address: Address): Promise<bigint> {
    const result = await this.read(
      (client, blockNumber) => client.getBalance({ address, blockNumber }),
      'eth_getBalance',
      true,
    );
    return result.value;
  }

  /**
   * Batch ERC-20 balances through Multicall3 (`aggregate3`, `allowFailure: false`).
   *
   * `allowFailure: false` is deliberate: a batch that silently omits a failed leg would look like a
   * zero balance, and a zero balance is a decision input (it can trigger a swap or a skip). A revert
   * aborts the whole batch instead.
   */
  async getTokenBalances(
    tokenAddresses: readonly Address[],
    holder?: Address,
  ): Promise<readonly TokenBalance[]> {
    const owner = holder ?? this.signerAddress;
    if (owner === null || owner === undefined) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        'getTokenBalances needs an owner address (none attached and none supplied)',
      );
    }
    const result = await this.getTokenBalancesWithProvenance(tokenAddresses, owner);
    return result.balances;
  }

  /** Same as `getTokenBalances` but also reports whether the batch was cross-checked (§99). */
  async getTokenBalancesWithProvenance(
    tokenAddresses: readonly Address[],
    holder: Address,
  ): Promise<TokenBalancesResult> {
    if (tokenAddresses.length === 0) return { balances: [], provenance: { observedBy: [], degraded: false } };
    const tokens = tokenAddresses.map((address) => this.requireWhitelistedToken(address));
    const callData = tokens.map(() =>
      encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [holder],
      }),
    );

    const read = async (
      client: PublicClient,
      blockNumber: bigint | undefined,
    ): Promise<readonly bigint[]> => {
      const responses = (await client.readContract({
        address: MULTICALL3_ADDRESS,
        abi: MULTICALL3_AGGREGATE3_ABI,
        functionName: 'aggregate3',
        blockNumber,
        args: [
          tokens.map((token, index) => ({
            target: token.address,
            allowFailure: false,
            callData: callData[index] as Hex,
          })),
        ],
      })) as readonly { success: boolean; returnData: Hex }[];

      if (responses.length !== tokens.length) {
        throw new ChainError(
          CHAIN_ERROR_CODES.DECODE_FAILED,
          `multicall3 returned ${responses.length} results for ${tokens.length} calls`,
          { expected: tokens.length, actual: responses.length },
        );
      }
      return responses.map((response) => BigInt(response.returnData));
    };

    const result = await this.read(read, 'multicall3.aggregate3(balanceOf)', true);
    return {
      balances: tokens.map((token, index) => ({
        tokenId: token.id,
        address: token.address,
        decimals: token.decimals,
        raw: result.value[index] as bigint,
      })),
      provenance: result.provenance,
    };
  }

  async getAllowance(tokenAddress: Address, owner: Address, spender: Address): Promise<bigint> {
    const token = this.requireWhitelistedToken(tokenAddress);
    const result = await this.read(
      async (client, blockNumber) =>
        (await client.readContract({
          address: token.address,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [owner, spender],
          blockNumber,
        })) as bigint,
      'allowance',
      true,
    );
    return result.value;
  }

  /**
   * §12: `getPool` is the only factory call needed by the read layer, and it is DEX-gated so a
   * mis-typed address can never be queried as if it were a whitelisted factory.
   */
  async getPoolAddress(
    dex: DexId,
    tokenA: Address,
    tokenB: Address,
    fee: number,
  ): Promise<Address | null> {
    this.whitelist.assertWhitelistedDex(this.chainId, dex);
    const contracts: DexContracts | undefined = BSC_DEX_CONTRACTS[dex];
    if (contracts === undefined) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DEX_NOT_WHITELISTED,
        `no contract set for DEX ${dex} on chain ${this.chainId}`,
        { dex, chainId: this.chainId },
      );
    }
    const result = await this.read(
      async (client) =>
        (await client.readContract({
          address: contracts.factory,
          abi: CLMM_FACTORY_ABI,
          functionName: 'getPool',
          args: [tokenA, tokenB, fee],
        })) as Address,
      'getPool',
      true,
    );
    return result.value === ZERO_ADDRESS ? null : getAddress(result.value);
  }

  /**
   * A `readContract` that participates in the §99 cross-check.
   *
   * Used by the token/pool/position readers for every *critical* value (balances, `slot0`, liquidity,
   * `positions`). Two endpoints that disagree make the read fail rather than return a value.
   */
  async readContract<T>(request: {
    readonly address: Address;
    readonly abi: readonly unknown[];
    readonly functionName: string;
    readonly args?: readonly unknown[];
  }): Promise<RpcReadResult<T>> {
    const result = await this.read(
      (client, blockNumber) =>
        client.readContract({
          address: request.address,
          abi: request.abi,
          functionName: request.functionName,
          args: request.args ?? [],
          blockNumber,
        }) as Promise<T>,
      `${request.functionName}(${request.address})`,
      true,
    );
    return result;
  }

  /**
   * A `readContract` that tolerates a revert, returning `null` instead.
   *
   * Only for **probing** (e.g. "does this contract implement `uiMultiplier()`?"), where a revert is a
   * meaningful answer rather than a failure. Transport failures still raise: "the node is down" must
   * never be mistaken for "the contract does not implement it" — that would silently downgrade a
   * bStock to a plain token.
   */
  async tryReadContract<T>(request: {
    readonly address: Address;
    readonly abi: readonly unknown[];
    readonly functionName: string;
    readonly args?: readonly unknown[];
  }): Promise<{ readonly value: T | null; readonly provenance: RpcProvenance }> {
    const result = await this.read(
      async (client) => {
        try {
          return (await client.readContract({
            address: request.address,
            abi: request.abi,
            functionName: request.functionName,
            args: request.args ?? [],
          })) as T;
        } catch (error) {
          const verdict = classifyRevert(error);
          if (verdict) return null;
          throw error;
        }
      },
      `${request.functionName}(${request.address})`,
      false,
    );
    return { value: result.value, provenance: result.provenance };
  }

  /** §81 write-path gas estimate. A failing estimate is a hard failure (fail closed). */
  async estimateGas(tx: ChainWriteRequest): Promise<bigint> {
    const account = this.requireSigner('estimateGas');
    return this.rpc.primary.estimateGas({
      account,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
  }

  async getGasPrice(): Promise<bigint> {
    const result = await this.read(
      (client) => client.getGasPrice(),
      'eth_gasPrice',
      // Gas price legitimately differs between nodes and between blocks; never cross-checked.
      false,
    );
    return result.value;
  }

  getSignerAddress(): Address | null {
    return this.signerAddress;
  }

  /**
   * §98 on-chain state resolution for a hash.
   *
   * `null` is returned only when the node answered that it has never seen the hash — which the
   * contract models as `UNKNOWN`, never as `FAILED` (see `interpretTransaction`).
   */
  async getTransaction(txHash: Hash): Promise<TransactionInfo | null> {
    const receipt = await this.rpc.call(async (client) => {
      try {
        return await client.getTransactionReceipt({ hash: txHash });
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    }, 'eth_getTransactionReceipt');

    if (receipt.value === null) {
      const pending = await this.rpc.call(async (client) => {
        try {
          return await client.getTransaction({ hash: txHash });
        } catch {
          return null;
        }
      }, 'eth_getTransactionByHash');
      if (pending.value === null) return interpretTransaction(txHash, null);
      const transaction = pending.value;
      return interpretTransaction(txHash, {
        blockNumber: transaction.blockNumber ?? null,
        from: transaction.from,
        to: transaction.to,
        value: transaction.value,
        ...(transaction.gasPrice === undefined || transaction.gasPrice === null
          ? {}
          : { gasPrice: transaction.gasPrice }),
      });
    }

    const mined = receipt.value;
    return interpretTransaction(txHash, {
      blockNumber: mined.blockNumber,
      from: mined.from,
      to: mined.to,
      value: 0n,
      gasUsed: mined.gasUsed,
      effectiveGasPrice: mined.effectiveGasPrice,
      status: mined.status,
    });
  }

  /**
   * §95/§98 write path.
   *
   * Order of operations (each step is a refusal point):
   * 1. the §95 guard, re-derived from its sub-checks here so a hand-built guard cannot bypass it;
   * 2. a signer must be attached (no signer ⇒ no write, ever);
   * 3. `dryRun` stops after the guard;
   * 4. a missing gas limit is estimated — a failing estimate aborts instead of broadcasting blind;
   * 5. broadcast, recording the §98 lifecycle.
   */
  async sendTransaction(tx: ChainWriteRequest): Promise<Hash> {
    assertTxGuard(tx.guard, { to: tx.to });
    // §95 defense in depth, and NOT redundant with the guard.
    //
    // `assertTxGuard` re-derives `ok` from the guard's own booleans, so it catches a malformed guard —
    // but it cannot verify anything: a caller that fills every sub-check with `true` while targeting an
    // unwhitelisted contract passes it. Measured: a forged all-true guard aimed at the known impostor
    // QQQB address `0xb904108b…` is accepted by `assertTxGuard`. Since this method is the only write
    // path in the system, the adapter verifies independently everything it can — it holds the whitelist
    // and the calldata, so trusting a self-reported boolean here would leave the most catastrophic
    // failure mode (signing to the wrong contract) protected only by the caller's honesty.
    this.assertWhitelistedWriteTarget(tx.to);
    const account = this.requireSigner('sendTransaction');
    const client = this.requireWalletClient();

    const gasLimit = tx.gasLimit ?? (await this.estimateGas(tx));
    if (gasLimit <= 0n) {
      throw new ChainError(
        CHAIN_ERROR_CODES.TX_GUARD_FAILED,
        'gas limit resolved to zero; refusing to broadcast',
        { to: tx.to },
      );
    }

    if (this.dryRun) {
      throw new ChainError(
        CHAIN_ERROR_CODES.TX_GUARD_FAILED,
        'adapter is in dry-run mode: the transaction passed §95 but was not broadcast',
        { to: tx.to, dryRun: true, gasLimit: gasLimit.toString() },
      );
    }

    let hash: Hash;
    try {
      hash = await client.sendTransaction({
        account,
        chain: null,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gas: gasLimit,
        ...(tx.gasPrice === undefined ? {} : { gasPrice: tx.gasPrice }),
      });
    } catch (error) {
      // A send failure before broadcast carries no hash; record it as FAILED (not UNKNOWN) because
      // nothing was submitted. The caller decides whether a *new* intent is allowed.
      const reason = error instanceof Error ? error.message : String(error);
      throw new ChainError(CHAIN_ERROR_CODES.RPC_NODE_ERROR, `broadcast failed: ${reason}`, {
        to: tx.to,
      });
    }

    this.lifecycles[hash.toLowerCase()] = {
      ...initialTxLifecycle(),
      state: TX_STATES.SUBMITTED,
      hash,
      attempts: 1,
    };
    return hash;
  }

  /** §98 lifecycle record for a hash this adapter broadcast, if any. */
  getLifecycle(hash: Hash): TxLifecycle | null {
    return this.lifecycles[hash.toLowerCase()] ?? null;
  }

  /**
   * Wait for a broadcast transaction to reach a terminal §98 state.
   *
   * `UNKNOWN` is surfaced as `TxStateUnknownError` — not as a timeout and never as a licence to
   * resend. The hash is included so the operator can re-query it by hand.
   */
  async waitForTransaction(hash: Hash, timeoutMs = 120_000): Promise<TransactionInfo> {
    const deadline = Date.now() + timeoutMs;
    let last: TransactionInfo | null = null;
    while (Date.now() < deadline) {
      const info = await this.getTransaction(hash);
      if (info === null) {
        last = null;
      } else {
        last = info;
        if (info.state !== TX_STATES.SUBMITTED && info.state !== TX_STATES.CREATED) {
          if (info.state === TX_STATES.UNKNOWN) {
            throw new TxStateUnknownError(
              hash,
              info.unknownReason ?? 'state undetermined',
              { endpointCount: this.rpc.getEndpointCount() },
            );
          }
          if (info.blockNumber !== null) {
            const head = await this.getBlockNumber();
            if (info.blockNumber + BigInt(this.confirmations) - 1n > head) {
              await sleep(1_000);
              continue;
            }
          }
          this.lifecycles[hash.toLowerCase()] = {
            state: info.state,
            hash,
            attempts: this.lifecycles[hash.toLowerCase()]?.attempts ?? 1,
            unknownReason: null,
          };
          return info;
        }
      }
      await sleep(2_000);
    }
    throw new TxStateUnknownError(
      hash,
      `no terminal state within ${timeoutMs}ms${last === null ? ' (hash unknown to every endpoint)' : ` (last state ${last.state})`}`,
      { timeoutMs },
    );
  }

  private requireSigner(operation: string): Address {
    if (this.signerAddress === null) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `${operation} requires an attached signer; this adapter was constructed read-only`,
        { operation },
      );
    }
    return this.signerAddress;
  }

  private requireWalletClient(): WalletClient {
    if (this.walletClient === null) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        'no wallet client attached; this adapter cannot sign or broadcast',
      );
    }
    return this.walletClient;
  }
}

/** The canonical zero address; `getPool` returns it when a pool does not exist. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

/** Poll backoff for `waitForTransaction`. */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * True when `error` is an on-chain revert rather than a transport/RPC-infrastructure failure.
 *
 * The distinction is load-bearing for probing: a revert means "this contract has no such function"
 * (a legitimate answer), while an unreachable node means "unknown" and must propagate.
 */
function classifyRevert(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; cursor !== undefined && cursor !== null && depth < 8; depth += 1) {
    if (typeof cursor === 'object') {
      const name = (cursor as { name?: unknown }).name;
      if (name === 'ExecutionRevertedError' || name === 'ContractFunctionRevertedError') {
        return true;
      }
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/** §98 state of a *locally recorded* hash; exported so callers can log it without importing viem. */
export function localStateOf(lifecycle: TxLifecycle | null): TxState {
  return lifecycle?.state ?? TX_STATES.CREATED;
}

/** Selector table used by executors for the §95 `functionSelectorOk` check on this adapter's calls. */
export const KNOWN_SELECTORS: Readonly<Record<string, Hex>> = {
  approve: '0x095ea7b3',
  collect: '0xfc6f7865',
  decreaseLiquidity: '0x0c49ccbe',
  increaseLiquidity: '0x219f5d17',
  mint: '0x88316456',
  multicall: '0xac9650d8',
  exactInputSingle: '0x04e45aaf',
  swapAndAdd: '0x3f2f4d2b',
  aggregate3: '0x82ad56cb',
};

export { RpcNodeError };
