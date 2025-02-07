import { SwapTreeSerializer } from 'boltz-core';
import Logger from '../../Logger';
import {
  getChainCurrency,
  getHexBuffer,
  getHexString,
  getLightningCurrency,
  splitPairId,
} from '../../Utils';
import {
  FailedSwapUpdateEvents,
  SwapType,
  SwapUpdateEvent,
  SwapVersion,
} from '../../consts/Enums';
import Swap from '../../db/models/Swap';
import { ChainSwapInfo } from '../../db/repositories/ChainSwapRepository';
import ReverseSwapRepository from '../../db/repositories/ReverseSwapRepository';
import SwapRepository from '../../db/repositories/SwapRepository';
import WrappedSwapRepository from '../../db/repositories/WrappedSwapRepository';
import { Payment } from '../../proto/lnd/rpc_pb';
import SwapNursery from '../../swap/SwapNursery';
import WalletManager, { Currency } from '../../wallet/WalletManager';
import Errors from '../Errors';
import { createPartialSignature, isPreimageValid } from './Utils';

type PartialSignature = {
  pubNonce: Buffer;
  signature: Buffer;
};

// TODO: Should we verify what we are signing? And if so, how strict should we be?

class MusigSigner {
  constructor(
    private readonly logger: Logger,
    private readonly currencies: Map<string, Currency>,
    private readonly walletManager: WalletManager,
    private readonly nursery: SwapNursery,
  ) {}

  public signRefund = async (
    swapId: string,
    theirNonce: Buffer,
    rawTransaction: Buffer,
    index: number,
  ): Promise<PartialSignature> => {
    const swap = await SwapRepository.getSwap({ id: swapId });
    if (!swap) {
      throw Errors.SWAP_NOT_FOUND(swapId);
    }

    const { base, quote } = splitPairId(swap.pair);
    const currency = this.currencies.get(
      getChainCurrency(base, quote, swap.orderSide, false),
    )!;

    if (currency.chainClient === undefined) {
      throw Errors.CURRENCY_NOT_UTXO_BASED();
    }

    if (
      swap.version !== SwapVersion.Taproot ||
      !(await MusigSigner.isEligibleForRefund(
        swap,
        this.currencies.get(
          getLightningCurrency(base, quote, swap.orderSide, false),
        )!,
      ))
    ) {
      this.logger.verbose(
        `Not creating partial signature for refund of Swap ${swap.id}: it is not eligible`,
      );
      throw Errors.NOT_ELIGIBLE_FOR_COOPERATIVE_REFUND();
    }

    this.logger.debug(
      `Creating partial signature for refund of Swap ${swap.id}`,
    );

    const swapTree = SwapTreeSerializer.deserializeSwapTree(swap.redeemScript!);

    return createPartialSignature(
      currency,
      this.walletManager.wallets.get(currency.symbol)!,
      swapTree,
      swap.keyIndex!,
      getHexBuffer(swap.refundPublicKey!),
      theirNonce,
      rawTransaction,
      index,
    );
  };

  public signReverseSwapClaim = async (
    swapId: string,
    preimage: Buffer,
    theirNonce: Buffer,
    rawTransaction: Buffer,
    index: number,
  ): Promise<PartialSignature> => {
    const swap = await ReverseSwapRepository.getReverseSwap({ id: swapId });
    if (!swap) {
      throw Errors.SWAP_NOT_FOUND(swapId);
    }

    if (
      swap.version !== SwapVersion.Taproot ||
      ![
        SwapUpdateEvent.TransactionMempool,
        SwapUpdateEvent.TransactionConfirmed,
        SwapUpdateEvent.InvoiceSettled,
      ].includes(swap.status as SwapUpdateEvent)
    ) {
      this.logger.verbose(
        `Not creating partial signature for claim of Reverse Swap ${swap.id}: it is not eligible`,
      );
      throw Errors.NOT_ELIGIBLE_FOR_COOPERATIVE_CLAIM();
    }

    if (!isPreimageValid(swap, preimage)) {
      this.logger.verbose(
        `Not creating partial signature for claim of Reverse Swap ${swap.id}: preimage is incorrect`,
      );
      throw Errors.INCORRECT_PREIMAGE();
    }

    this.logger.debug(
      `Got preimage for Reverse Swap ${swap.id}: ${getHexString(preimage)}`,
    );
    await WrappedSwapRepository.setPreimage(swap, preimage);

    return this.nursery.lock.acquire(SwapNursery.reverseSwapLock, async () => {
      if (swap.status !== SwapUpdateEvent.InvoiceSettled) {
        await this.nursery.settleReverseSwapInvoice(swap, preimage);
      }

      this.logger.debug(
        `Creating partial signature for claim of Reverse Swap ${swap.id}`,
      );

      const { base, quote } = splitPairId(swap.pair);
      const chainCurrency = getChainCurrency(base, quote, swap.orderSide, true);
      const swapTree = SwapTreeSerializer.deserializeSwapTree(
        swap.redeemScript!,
      );

      return createPartialSignature(
        this.currencies.get(chainCurrency)!,
        this.walletManager.wallets.get(chainCurrency)!,
        swapTree,
        swap.keyIndex!,
        getHexBuffer(swap.claimPublicKey!),
        theirNonce,
        rawTransaction,
        index,
      );
    });
  };

  public static isEligibleForRefund = async (
    swap: Swap | ChainSwapInfo,
    lightningCurrency?: Currency,
  ) =>
    FailedSwapUpdateEvents.includes(swap.status as SwapUpdateEvent) &&
    (lightningCurrency === undefined ||
      !(await MusigSigner.hasNonFailedLightningPayment(
        lightningCurrency,
        swap,
      )));

  private static hasNonFailedLightningPayment = async (
    currency: Currency,
    swap: Swap | ChainSwapInfo,
  ): Promise<boolean> => {
    if (swap.type === SwapType.Chain) {
      return false;
    }

    try {
      if (currency.lndClient) {
        const pendingPayment = await currency.lndClient!.trackPayment(
          getHexBuffer(swap.preimageHash),
        );

        if (pendingPayment.status !== Payment.PaymentStatus.FAILED) {
          return true;
        }
      }
    } catch (e) {
      /* empty */
    }

    try {
      const invoice = (swap as Swap).invoice;
      if (currency.clnClient && invoice !== undefined) {
        const payment = await currency.clnClient!.checkPayStatus(invoice);
        if (payment !== undefined) {
          return true;
        }
      }
    } catch (e) {
      return true;
    }

    return false;
  };
}

export default MusigSigner;
export { PartialSignature };
