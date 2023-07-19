import fs from 'fs';
import toml from '@iarna/toml';
import Errors from './Errors';
import Logger from '../Logger';
import Swap from '../db/models/Swap';
import { ConfigType } from '../Config';
import { OrderSide } from '../consts/Enums';
import { PairConfig } from '../consts/Types';
import { PayReq } from '../proto/lnd/rpc_pb';
import LndClient from '../lightning/LndClient';
import { Currency } from '../wallet/WalletManager';
import ElementsClient from '../chain/ElementsClient';
import EthereumManager from '../wallet/ethereum/EthereumManager';
import {
  getChainCurrency,
  getLightningCurrency,
  getPairId,
  splitPairId,
  stringify,
} from '../Utils';

type PairTimeoutBlocksDelta = {
  reverse: number;

  swapMinimal: number;
  swapMaximal: number;
};

type PairTimeoutBlockDeltas = {
  base: PairTimeoutBlocksDelta;
  quote: PairTimeoutBlocksDelta;
};

class TimeoutDeltaProvider {
  public static routingOffset = 60;
  public static readonly noRoutes = -1;

  // A map of the symbols of currencies and their block times in minutes
  public static blockTimes = new Map<string, number>([
    ['BTC', 10],
    ['LTC', 2.5],
    ['ETH', 0.2],
    [ElementsClient.symbol, 1],
  ]);

  public timeoutDeltas = new Map<string, PairTimeoutBlockDeltas>();

  constructor(
    private logger: Logger,
    private config: ConfigType,
    private currencies: Map<string, Currency>,
    private ethereumManager: EthereumManager,
  ) {}

  public static convertBlocks = (
    fromSymbol: string,
    toSymbol: string,
    blocks: number,
  ): number => {
    const minutes = blocks * TimeoutDeltaProvider.getBlockTime(fromSymbol)!;

    // In the context this function is used, we calculate the timeout of the first leg of a
    // reverse swap which has to be longer than the second one
    return Math.ceil(minutes / TimeoutDeltaProvider.getBlockTime(toSymbol)!);
  };

  public init = (pairs: PairConfig[]): void => {
    for (const pair of pairs) {
      const pairId = getPairId(pair);

      if (pair.timeoutDelta !== undefined) {
        // Compatibility mode with legacy config
        if (typeof pair.timeoutDelta === 'number') {
          pair.timeoutDelta = {
            reverse: pair.timeoutDelta,
            swapMaximal: pair.timeoutDelta,
            swapMinimal: pair.timeoutDelta,
          };
        }

        this.logger.debug(
          `Setting timeout block delta of ${pairId} to minutes: ${stringify(
            pair.timeoutDelta,
          )}`,
        );
        this.timeoutDeltas.set(
          pairId,
          this.minutesToBlocks(pairId, pair.timeoutDelta),
        );
      } else {
        throw Errors.NO_TIMEOUT_DELTA(pairId);
      }
    }
  };

  public setTimeout = (
    pairId: string,
    newDeltas: PairTimeoutBlocksDelta,
  ): void => {
    if (this.timeoutDeltas.has(pairId)) {
      const blocks = this.minutesToBlocks(pairId, newDeltas);

      this.timeoutDeltas.set(pairId, blocks);

      for (let i = 0; i < this.config.pairs.length; i += 1) {
        if (getPairId(this.config.pairs[i]) === pairId) {
          this.config.pairs[i].timeoutDelta = newDeltas;

          break;
        }
      }

      // Write the new config to the disk
      const newConfig = toml.stringify(this.config as toml.JsonMap);
      fs.writeFileSync(this.config.configpath, newConfig);
    } else {
      throw Errors.PAIR_NOT_FOUND(pairId);
    }
  };

  public getCltvLimit = async (swap: Swap): Promise<number> => {
    const { base, quote } = splitPairId(swap.pair);
    const chainCurrency = this.currencies.get(
      getChainCurrency(base, quote, swap.orderSide, false),
    )!;

    const currentBlock = chainCurrency.chainClient
      ? (await chainCurrency.chainClient.getBlockchainInfo()).blocks
      : await this.ethereumManager.provider.getBlockNumber();

    const blockLeft = TimeoutDeltaProvider.convertBlocks(
      chainCurrency.symbol,
      getLightningCurrency(base, quote, swap.orderSide, false),
      swap.timeoutBlockHeight - currentBlock,
    );

    return Math.floor(blockLeft - 2);
  };

  public getTimeout = async (
    pairId: string,
    orderSide: OrderSide,
    isReverse: boolean,
    invoice?: string,
  ): Promise<[number, boolean]> => {
    const timeouts = this.timeoutDeltas.get(pairId);

    if (!timeouts) {
      throw Errors.PAIR_NOT_FOUND(pairId);
    }

    if (isReverse) {
      return [
        orderSide === OrderSide.BUY
          ? timeouts.base.reverse
          : timeouts.quote.reverse,
        false,
      ];
    } else {
      const { base, quote } = splitPairId(pairId);
      const chain = getChainCurrency(base, quote, orderSide, false);
      const lightning = getLightningCurrency(base, quote, orderSide, false);

      const chainDeltas =
        orderSide === OrderSide.BUY ? timeouts.quote : timeouts.base;
      const lightningDeltas =
        orderSide === OrderSide.BUY ? timeouts.base : timeouts.quote;

      return invoice
        ? await this.getTimeoutInvoice(
            chain,
            lightning,
            chainDeltas,
            lightningDeltas,
            invoice,
          )
        : [chainDeltas.swapMinimal, true];
    }
  };

  public checkRoutability = async (
    lnd: LndClient,
    decodedInvoice: PayReq,
    cltvLimit: number,
  ) => {
    try {
      // Check whether the receiving side supports MPP and if so,
      // query a route for the number of sats of the invoice divided
      // by the max payment parts we tell to LND to use
      const supportsMpp = decodedInvoice
        .toObject()
        .featuresMap.map(
          ([, feature]) =>
            feature.name === 'multi-path-payments' &&
            (feature.isKnown || feature.isRequired),
        )
        .some((val) => val);

      const amountToQuery = Math.max(
        supportsMpp
          ? Math.ceil(
              decodedInvoice.getNumSatoshis() / LndClient.paymentMaxParts,
            )
          : decodedInvoice.getNumSatoshis(),
        1,
      );

      const routes = await lnd.queryRoutes(
        decodedInvoice.getDestination(),
        amountToQuery,
        cltvLimit,
        decodedInvoice.getCltvExpiry(),
        decodedInvoice.getRouteHintsList(),
      );

      return routes.routesList.reduce(
        (highest, r) => (highest > r.totalTimeLock ? highest : r.totalTimeLock),
        TimeoutDeltaProvider.noRoutes,
      );
    } catch (error) {
      this.logger.debug(`Could not query routes: ${error}`);
      return TimeoutDeltaProvider.noRoutes;
    }
  };

  private getTimeoutInvoice = async (
    chainCurrency: string,
    lightningCurrency: string,
    chainTimeout: PairTimeoutBlocksDelta,
    lightningTimeout: PairTimeoutBlocksDelta,
    invoice: string,
  ): Promise<[number, boolean]> => {
    const { lndClient, chainClient } = this.currencies.get(lightningCurrency)!;
    const decodedInvoice = await lndClient!.decodePayReqRawResponse(invoice);

    const [routeTimeLock, chainInfo] = await Promise.all([
      this.checkRoutability(
        lndClient!,
        decodedInvoice,
        lightningTimeout.swapMaximal,
      ),
      chainClient!.getBlockchainInfo(),
    ]);

    if (routeTimeLock === TimeoutDeltaProvider.noRoutes) {
      return [chainTimeout.swapMaximal, false];
    }

    const routeDeltaRelative = routeTimeLock - chainInfo.blocks;
    this.logger.debug(
      `CLTV needed to route: ${routeDeltaRelative} ${lightningCurrency} blocks`,
    );

    // Add some buffer to make sure we have enough limit when the transaction confirms
    const routeDeltaMinutes = Math.ceil(
      routeDeltaRelative * TimeoutDeltaProvider.getBlockTime(lightningCurrency),
    );
    const finalExpiry = routeDeltaMinutes + TimeoutDeltaProvider.routingOffset;

    const minTimeout = Math.ceil(
      finalExpiry / TimeoutDeltaProvider.getBlockTime(chainCurrency),
    );

    if (minTimeout > chainTimeout.swapMaximal) {
      throw Errors.MIN_EXPIRY_TOO_BIG(
        Math.ceil(
          chainTimeout.swapMaximal *
            TimeoutDeltaProvider.getBlockTime(chainCurrency),
        ),
        routeDeltaMinutes,
      );
    }

    const cltv = Math.max(chainTimeout.swapMinimal, minTimeout);
    this.logger.debug(`Using timeout of: ${cltv} ${chainCurrency} blocks`);
    return [cltv, true];
  };

  private minutesToBlocks = (
    pair: string,
    newDeltas: PairTimeoutBlocksDelta,
  ) => {
    const calculateBlocks = (symbol: string, minutes: number) => {
      const minutesPerBlock = TimeoutDeltaProvider.getBlockTime(symbol);
      const blocks = minutes / minutesPerBlock;

      // Sanity checks to make sure no impossible deltas are set
      if (blocks % 1 !== 0 || blocks < 1) {
        throw Errors.INVALID_TIMEOUT_BLOCK_DELTA();
      }

      return blocks;
    };

    const convertToBlocks = (symbol: string): PairTimeoutBlocksDelta => {
      return {
        reverse: calculateBlocks(symbol, newDeltas.reverse),
        swapMinimal: calculateBlocks(symbol, newDeltas.swapMinimal),
        swapMaximal: calculateBlocks(symbol, newDeltas.swapMaximal),
      };
    };

    const { base, quote } = splitPairId(pair);

    return {
      base: convertToBlocks(base),
      quote: convertToBlocks(quote),
    };
  };

  /**
   * If the block time for the symbol is not hardcoded, it is assumed that the symbol belongs to an ERC20 token
   */
  private static getBlockTime = (symbol: string): number => {
    return (
      TimeoutDeltaProvider.blockTimes.get(symbol) ||
      TimeoutDeltaProvider.blockTimes.get('ETH')!
    );
  };
}

export default TimeoutDeltaProvider;
export { PairTimeoutBlocksDelta };
